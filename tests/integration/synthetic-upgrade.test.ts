import "dotenv/config";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, getDatabase } from "../../src/db/client";
import { expireTradingOrders, mutateTrading, publicTradingSnapshot, tradingSnapshot } from "../../src/db/trading";
import { holdings, journals, ledgerAccounts, ledgerEntries, markets, orders, sessions, shareMovements, tradingOperations, users } from "../../src/db/schema";
import { digest, randomToken } from "../../src/domain/identity";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const name = `jader_synthetic_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
const isolatedUrl = new URL(url); isolatedUrl.pathname = `/${name}`;
process.env.DATABASE_URL = isolatedUrl.toString();
const connection = createDatabase(isolatedUrl.toString());
const token = randomToken();
let created = false;
let ownerId: string, marketId: string, walletId: string, escrowId: string, yesId: string, noId: string, orderId: string;

// Write valid pre-0004 operations to represent positions created by the old app.
async function legacyMint() {
  return connection.db.transaction(async tx => {
    const id = randomUUID(), journalId = randomUUID();
    await tx.insert(journals).values({ id: journalId, operationKey: journalId, requestHash: "legacy-mint", actorId: ownerId, recipientId: ownerId, kind: "mint", reason: "trading", amount: 50000n, tradingOperationId: id });
    await tx.insert(ledgerEntries).values([{ journalId, accountId: walletId, delta: -50000n }, { journalId, accountId: escrowId, delta: 50000n }]);
    await tx.insert(shareMovements).values([yesId, noId].map(holdingId => ({ operationId: id, groupId: journalId, holdingId, kind: "mint", availableDelta: 5n, reservedDelta: 0n })));
    await tx.insert(tradingOperations).values({ id, ownerId, marketId, action: "mint", requestHash: "legacy-mint", response: {} });
  });
}
async function legacySell() {
  return connection.db.transaction(async tx => {
    const id = randomUUID();
    await tx.insert(orders).values({ id, operationId: id, ownerId, marketId, outcome: "YES", side: "sell", price: 3000n, quantity: 2n, remaining: 2n, timeInForce: "GTC" });
    await tx.insert(shareMovements).values({ operationId: id, groupId: id, holdingId: yesId, kind: "reserve", availableDelta: -2n, reservedDelta: 2n });
    await tx.insert(tradingOperations).values({ id, ownerId, marketId, action: "place", requestHash: "legacy-order", response: {} });
    return id;
  });
}

beforeAll(async () => {
  await control.client.unsafe(`CREATE DATABASE "${name}"`); created = true;
  const previous = mkdtempSync(join(tmpdir(), "jader-synthetic-upgrade-"));
  try {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 3);
    mkdirSync(join(previous, "meta"));
    writeFileSync(join(previous, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(`drizzle/${entry.tag}.sql`, join(previous, `${entry.tag}.sql`));
    await migrate(connection.db, { migrationsFolder: previous });
  } finally { rmSync(previous, { recursive: true, force: true }); }
  const [admin, owner] = await connection.db.insert(users).values([{ handle: "synthetic_admin", passwordHash: "unused-test-hash", role: "admin" }, { handle: "synthetic_holder", passwordHash: "unused-test-hash" }]).returning();
  ownerId = owner.id;
  const [issuance, wallet] = await connection.db.insert(ledgerAccounts).values([{ kind: "issuance" }, { kind: "wallet", ownerId }, { kind: "reserved", ownerId }]).returning();
  walletId = wallet.id;
  await connection.db.insert(sessions).values({ userId: ownerId, tokenHash: digest(token), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now() + 3600000) });
  await connection.db.transaction(async tx => {
    const [journal] = await tx.insert(journals).values({ operationKey: randomUUID(), requestHash: "legacy-credit", actorId: admin.id, recipientId: ownerId, kind: "credit", reason: "correction", amount: 100000n }).returning();
    await tx.insert(ledgerEntries).values([{ journalId: journal.id, accountId: issuance.id, delta: -100000n }, { journalId: journal.id, accountId: walletId, delta: 100000n }]);
  });
  const [market] = await connection.db.insert(markets).values({ slug: "legacy-synthetic", question: "Will this fictional event occur?", description: "Legacy synthetic upgrade fixture.", category: "community", resolutionRules: "Use the fictional event record to resolve.", resolutionSource: "Fictional record", closesAt: new Date("2035-12-31T12:00:00Z"), publishedAt: new Date(), status: "open", synthetic: "yes" }).returning();
  marketId = market.id;
  const [escrow] = await connection.db.insert(ledgerAccounts).values({ kind: "escrow", marketId }).returning();
  escrowId = escrow.id;
  const [yes, no] = await connection.db.insert(holdings).values([{ ownerId, marketId, outcome: "YES" }, { ownerId, marketId, outcome: "NO" }]).returning();
  yesId = yes.id; noId = no.id;
  await legacyMint(); orderId = await legacySell();
  await migrate(connection.db, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  await connection.client.end(); await getDatabase()?.client.end();
  if (created) await control.client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await control.client.end();
});

describe("upgrading synthetic markets with existing collateral", () => {
  it("continues to reject new synthetic inventory and orders in both the app and database", async () => {
    for (const action of ["mint", "place"] as const) await expect(mutateTrading(token, action, { marketId, operationKey: randomUUID(), quantity: "1", outcome: "YES", side: "sell", price: "3000", timeInForce: "GTC" })).rejects.toMatchObject({ code: "trading_unavailable" });
    for (const write of [legacyMint, legacySell]) await expect(write()).rejects.toMatchObject({ message: expect.stringContaining("Synthetic browsing market is not tradable") });
  });
  it("releases legacy reservations and redeems complete sets exactly once without issuing credits", async () => {
    const before = await tradingSnapshot(token, marketId);
    expect(before.holdings.find(h => h.outcome === "YES")).toMatchObject({ available: "3", reserved: "2" });
    await expect(mutateTrading(token, "burn", { marketId, operationKey: randomUUID(), quantity: "4" })).rejects.toMatchObject({ code: "insufficient_shares" });
    await expireTradingOrders();
    expect((await connection.db.select().from(orders).where(eq(orders.id, orderId)))[0]).toMatchObject({ status: "cancelled", reason: "synthetic_unavailable" });
    const request = { marketId, operationKey: randomUUID(), quantity: "5" };
    const first = await mutateTrading(token, "burn", request);
    expect(await mutateTrading(token, "burn", request)).toEqual(first);
    const after = await tradingSnapshot(token, marketId);
    expect(BigInt(after.availableCredits) - BigInt(before.availableCredits)).toBe(50000n);
    expect(after.holdings.every(h => h.available === "0" && h.reserved === "0")).toBe(true);
    expect((await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, escrowId)))[0].balance).toBe(0n);
    expect((await connection.db.execute(sql`SELECT sum(balance)::text AS total FROM ledger_accounts`))[0].total).toBe("0");
    expect((await publicTradingSnapshot(marketId)).executable).toBe(false);
    await expect(mutateTrading(token, "burn", { ...request, operationKey: randomUUID() })).rejects.toMatchObject({ code: "insufficient_shares" });
  });
});
