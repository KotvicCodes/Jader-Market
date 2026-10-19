import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, getDatabase } from "../../src/db/client";
import { adjustCredits, manageParticipant } from "../../src/db/members";
import { mutateMarket } from "../../src/db/market-admin";
import { mutateTrading } from "../../src/db/trading";
import { payoutHistory, publicResolution, settleMarkets } from "../../src/db/settlement";
import { holdings, ledgerAccounts, marketPayouts, marketResolutions, markets, sessions, shareMovements, tradingOperations, tradingOutbox, users, orders } from "../../src/db/schema";
import { digest, encryptSecret, randomToken } from "../../src/domain/identity";
import { legacyCredit, legacyMintAndAsk } from "../fixtures/legacy-trading";
import type { TradingAction } from "../../src/domain/trading";
import { oldestSettlementLagMs } from "../../scripts/acceptance-metrics";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const name = `jader_settlement_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
const isolatedUrl = new URL(url); isolatedUrl.pathname = `/${name}`;
process.env.DATABASE_URL = isolatedUrl.toString();
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
const connection = createDatabase(isolatedUrl.toString());
let created = false;
let legacyMarket: string;
let legacyOrder: string;
const admin = randomToken(), alice = randomToken(), bob = randomToken();
const ids = new Map<string, string>();
const evidence = "Verified fictional source: the published event record confirms this final result.";
const terms = { question: "Will the fictional settlement event occur?", description: "Synthetic collateral-funded settlement test.", category: "community", resolutionRules: "Resolve YES only on a verified event, otherwise NO.", resolutionSource: "Synthetic event record", closesAt: new Date("2035-12-31T12:00:00Z"), status: "open" as const, publishedAt: new Date() };

beforeAll(async () => {
  await control.client.unsafe(`CREATE DATABASE "${name}"`); created = true;
  const previous = mkdtempSync(join(tmpdir(), "jader-upgrade-"));
  try {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 4);
    mkdirSync(join(previous, "meta"));
    writeFileSync(join(previous, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(`drizzle/${entry.tag}.sql`, join(previous, `${entry.tag}.sql`));
    await migrate(connection.db, { migrationsFolder: previous });
  } finally { rmSync(previous, { recursive: true, force: true }); }
  await connection.db.insert(ledgerAccounts).values({ kind: "issuance" });
  for (const [handle, token] of [["settlement_admin", admin], ["alice", alice], ["bob", bob]]) {
    const [user] = await connection.db.insert(users).values({ handle, passwordHash: "unused-test-hash", role: token === admin ? "admin" : "participant", mfaSecret: token === admin ? encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") : null }).returning();
    ids.set(token, user.id);
    await connection.db.insert(ledgerAccounts).values([{ ownerId: user.id, kind: "wallet" }, { ownerId: user.id, kind: "reserved" }]);
    await connection.db.insert(sessions).values({ userId: user.id, tokenHash: digest(token), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now() + 3600000) });
  }
  for (const token of [alice, bob]) await legacyCredit(connection.db, ids.get(admin)!, ids.get(token)!, 1000000n);
  legacyMarket = await market();
  legacyOrder = await legacyMintAndAsk(connection.db, ids.get(alice)!, legacyMarket);
  await migrate(connection.db, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  await connection.client.end(); await getDatabase()?.client.end();
  if (created) await control.client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await control.client.end();
});
async function market() { const [row] = await connection.db.insert(markets).values({ ...terms, slug: randomUUID() }).returning(); return row.id; }
const act = (token: string, action: TradingAction, marketId: string, changes = {}) => mutateTrading(token, action, { marketId, operationKey: randomUUID(), quantity: "5", price: "3000", outcome: "YES", side: "buy", timeInForce: "GTC", ...changes });
const fund = (token: string, amount: string) => adjustCredits(admin, { recipientId: ids.get(token), amount, kind: "credit", reason: "correction", operationKey: randomUUID(), confirmed: true });
const close = (id: string) => mutateMarket(admin, "close", { id, revision: 0, operationKey: randomUUID(), confirmed: true });
const resolve = (id: string, result: string, extra = {}) => mutateMarket(admin, "resolve", { id, revision: 1, operationKey: randomUUID(), confirmed: true, result, evidence, ...extra });
async function balance(token: string) { const [row] = await connection.db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.ownerId, ids.get(token)!), eq(ledgerAccounts.kind, "wallet"))); return row.balance; }
async function verifyConservation(id: string) {
  expect((await connection.db.execute(sql`SELECT sum(balance)::text AS total FROM ledger_accounts`))[0].total).toBe("0");
  const [row] = await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.marketId, id));
  if (row) expect(row.balance).toBe(0n);
  expect((await connection.db.select().from(holdings).where(eq(holdings.marketId, id))).every(h => h.available === 0n && h.reserved === 0n)).toBe(true);
}

describe("immutable resolution and restartable collateral payouts", () => {
  it("preserves pre-migration collateral and reservations, then settles them", async () => {
    const before = await balance(alice);
    expect((await connection.db.select().from(holdings).where(eq(holdings.marketId, legacyMarket))).find(h => h.outcome === "YES")?.reserved).toBe(2n);
    await close(legacyMarket);
    await resolve(legacyMarket, "invalid");
    await settleMarkets();
    expect(await balance(alice)).toBe(before+50000n);
    expect((await connection.db.select().from(orders).where(eq(orders.id, legacyOrder)))[0].status).toBe("cancelled");
    await verifyConservation(legacyMarket);
  });
  for (const result of ["YES", "NO", "invalid"] as const) it(`settles distributed ${result} holdings, releases orders, and records private receipts`, async () => {
    const id = await market();
    await act(alice, "mint", id);
    await act(alice, "place", id, { side: "sell", quantity: "3" });
    await act(bob, "place", id, { side: "buy", quantity: "2", timeInForce: "IOC" });
    await act(bob, "place", id, { side: "buy", outcome: "NO", quantity: "1" });
    await close(id);
    const aliceBefore = await balance(alice), bobBefore = await balance(bob);
    const request = { operationKey: randomUUID() };
    const first = await resolve(id, result, request);
    expect(await resolve(id, result, request)).toEqual(first);
    expect(await publicResolution(id)).toMatchObject({ result, evidence });
    await expect(act(alice, "burn", id)).rejects.toMatchObject({ code: "trading_closed" });
    await Promise.all([settleMarkets(), settleMarkets()]);
    const aliceExpected = result === "YES" ? 30000n : result === "NO" ? 50000n : 40000n;
    const bobExpected = result === "YES" ? 20000n : result === "NO" ? 0n : 10000n;
    expect(await balance(alice)).toBe(aliceBefore + aliceExpected);
    expect(await balance(bob)).toBe(bobBefore + bobExpected);
    const payouts = await connection.db.select().from(marketPayouts).where(eq(marketPayouts.resolutionId, request.operationKey));
    expect(payouts).toHaveLength(3);
    expect(payouts.reduce((a, p) => a+p.amount, 0n)).toBe(50000n);
    const bobHistory = await payoutHistory(bob, 1);
    const allBob = await connection.db.select().from(marketPayouts).where(eq(marketPayouts.ownerId, ids.get(bob)!));
    expect(bobHistory.items.every(p => allBob.some(row => row.id === p.id))).toBe(true);
    expect(bobHistory.items.filter(p => payouts.some(row => row.id === p.id))).toHaveLength(1);
    expect((await connection.db.select().from(markets).where(eq(markets.id, id)))[0].status).toBe(result === "invalid" ? "void" : "resolved");
    expect(await resolve(id, result, request)).toEqual(first);
    expect(await settleMarkets()).toBe(0);
    await verifyConservation(id);
    const events = await connection.db.select().from(tradingOutbox).where(eq(tradingOutbox.marketId, id));
    expect(events.filter(e => e.event === "portfolio.changed" && payouts.some(p => p.id === e.operationId))).toHaveLength(3);
  });
  it("rejects invalid evidence, stale revisions, missing confirmation and insufficient authority", async () => {
    const id = await market();
    await expect(resolve(id, "YES", { revision: 0 })).rejects.toMatchObject({ code: "market_transition" });
    await close(id);
    await expect(mutateMarket(alice, "resolve", { id, revision: 1, operationKey: randomUUID(), result: "YES", evidence, confirmed: true })).rejects.toMatchObject({ code: "forbidden" });
    for (const change of [{ evidence: "short" }, { evidence: "a".repeat(2001) }, { result: "maybe" }, { confirmed: false }]) await expect(resolve(id, "YES", change)).rejects.toThrow();
    await expect(resolve(id, "YES", { revision: 0 })).rejects.toMatchObject({ code: "market_stale" });
    await connection.db.update(sessions).set({ authenticatedAt: new Date(Date.now()-660000) }).where(eq(sessions.tokenHash, digest(admin)));
    await expect(resolve(id, "YES")).rejects.toMatchObject({ code: "reauth_required" });
    await connection.db.update(sessions).set({ authenticatedAt: new Date() }).where(eq(sessions.tokenHash, digest(admin)));
    await resolve(id, "YES"); await settleMarkets(); await verifyConservation(id);
  });
  it("serializes contradictory resolutions and retries without paying twice", async () => {
    const id = await market(); await act(alice, "mint", id); await close(id);
    const requests = [{ operationKey: randomUUID() }, { operationKey: randomUUID() }];
    const outcomes = await Promise.allSettled([resolve(id, "YES", requests[0]), resolve(id, "NO", requests[1])]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(r => r.status === "rejected")).toMatchObject([{ reason: { code: "market_stale" } }]);
    const winner = outcomes.findIndex(r => r.status === "fulfilled");
    await expect(resolve(id, winner === 0 ? "NO" : "YES", requests[winner])).rejects.toMatchObject({ code: "market_operation_conflict" });
    await settleMarkets(); await verifyConservation(id);
  });
  it("resumes bounded chunks and preserves suspended holders' entitlements", async () => {
    const id = await market();
    for (let i=0; i<2; i++) { await fund(alice, "1000000"); await act(alice, "mint", id, { quantity: "1000000" }); }
    await close(id); const resolution = await resolve(id, "YES");
    await manageParticipant(admin, ids.get(alice), "suspend");
    const before = await balance(alice);
    await expect(payoutHistory(alice, 1)).rejects.toMatchObject({ code: "unauthenticated" });
    await connection.client`SELECT pg_sleep(0.05)`;
    const queueAgeBefore = await oldestSettlementLagMs(connection.db);
    expect(queueAgeBefore).toBeGreaterThanOrEqual(40);
    await settleMarkets();
    expect((await connection.db.select().from(markets).where(eq(markets.id, id)))[0].status).toBe("settling");
    expect(await oldestSettlementLagMs(connection.db)).toBeGreaterThanOrEqual(queueAgeBefore);
    let receipts = await connection.db.select().from(marketPayouts).where(eq(marketPayouts.resolutionId, (await connection.db.select().from(marketResolutions).where(eq(marketResolutions.marketId, resolution.id)))[0].id));
    expect(receipts.every(p => p.quantity === 1000000n)).toBe(true);
    expect(receipts).toHaveLength(2);
    await Promise.all([settleMarkets(), settleMarkets()]);
    expect(await balance(alice)).toBe(before+20000000000n);
    receipts = await connection.db.select().from(marketPayouts).where(eq(marketPayouts.resolutionId, receipts[0].resolutionId));
    expect(receipts).toHaveLength(4);
    await verifyConservation(id);
    expect(await oldestSettlementLagMs(connection.db)).toBe(0);
    await manageParticipant(admin, ids.get(alice), "resume");
  });
  it("rolls back an interrupted batch and resumes once after a worker failure", async () => {
    const id = await market(); await act(bob, "mint", id); await close(id);
    const operationKey = randomUUID(); await resolve(id, "invalid", { operationKey });
    const before = await balance(bob);
    await connection.client.unsafe(`CREATE FUNCTION fail_test_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (SELECT count(*) FROM market_payouts WHERE resolution_id=NEW.resolution_id)>1 THEN RAISE EXCEPTION 'Synthetic interruption'; END IF;
      RETURN NEW; END; $$;
      CREATE TRIGGER fail_test_batch AFTER INSERT ON market_payouts FOR EACH ROW EXECUTE FUNCTION fail_test_batch()`);
    try { await expect(settleMarkets()).rejects.toThrow(); }
    finally { await connection.client.unsafe("DROP TRIGGER fail_test_batch ON market_payouts; DROP FUNCTION fail_test_batch()"); }
    expect(await balance(bob)).toBe(before);
    expect(await connection.db.select().from(marketPayouts).where(eq(marketPayouts.resolutionId, operationKey))).toHaveLength(0);
    await Promise.all([settleMarkets(), settleMarkets()]);
    expect(await balance(bob)).toBe(before+50000n);
    await verifyConservation(id);
  });
  it("bounds each worker pass to twenty holdings and finishes the rest later", async () => {
    const id = await market();
    for (let i=0; i<11; i++) {
      const token = randomToken();
      const [user] = await connection.db.insert(users).values({ handle: `holder_${i}`, passwordHash: "unused-test-hash" }).returning();
      ids.set(token, user.id);
      await connection.db.insert(ledgerAccounts).values([{ kind: "wallet", ownerId: user.id }, { kind: "reserved", ownerId: user.id }]);
      await connection.db.insert(sessions).values({ userId: user.id, tokenHash: digest(token), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now()+3600000) });
      await fund(token, "1"); await act(token, "mint", id, { quantity: "1" });
    }
    await close(id); await resolve(id, "invalid");
    expect(await settleMarkets()).toBe(20);
    expect((await connection.db.select().from(markets).where(eq(markets.id, id)))[0].status).toBe("settling");
    expect(await settleMarkets()).toBe(2);
    expect((await connection.db.select().from(markets).where(eq(markets.id, id)))[0].status).toBe("void");
    await verifyConservation(id);
  });
  it("rejects premature completion, fabricated payouts, and changes to immutable records", async () => {
    const id = await market(); await act(bob, "mint", id); await close(id);
    const operationKey = randomUUID(); await resolve(id, "YES", { operationKey });
    await expect(connection.db.update(markets).set({ status: "resolved", revision: 3 }).where(eq(markets.id, id))).rejects.toThrow();
    await expect(connection.db.update(marketResolutions).set({ result: "NO" }).where(eq(marketResolutions.id, operationKey))).rejects.toThrow();
    const [stock] = await connection.db.select().from(holdings).where(and(eq(holdings.marketId, id), eq(holdings.outcome, "YES")));
    await expect(connection.db.transaction(async tx => {
      const payoutId = randomUUID();
      await tx.insert(shareMovements).values({ operationId: payoutId, groupId: payoutId, holdingId: stock.id, kind: "payout", availableDelta: -1n, reservedDelta: 0n });
      await tx.insert(marketPayouts).values({ id: payoutId, resolutionId: operationKey, holdingId: stock.id, ownerId: stock.ownerId, quantity: 1n, amount: 0n });
      await tx.insert(tradingOperations).values({ id: payoutId, ownerId: ids.get(admin), marketId: id, action: "settle", requestHash: "tamper", response: {} });
    })).rejects.toThrow();
    expect((await connection.db.select().from(holdings).where(eq(holdings.id, stock.id)))[0].available).toBe(5n);
    await settleMarkets();
    const [receipt] = await connection.db.select().from(marketPayouts).where(eq(marketPayouts.resolutionId, operationKey));
    await expect(connection.db.update(marketPayouts).set({ amount: 1n }).where(eq(marketPayouts.id, receipt.id))).rejects.toThrow();
    await expect(connection.db.delete(marketPayouts).where(eq(marketPayouts.id, receipt.id))).rejects.toThrow();
    await verifyConservation(id);
  });
});
