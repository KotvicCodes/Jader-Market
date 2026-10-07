import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, getDatabase } from "../../src/db/client";
import { adjustCredits, manageParticipant } from "../../src/db/members";
import { mutateMarket } from "../../src/db/market-admin";
import { expireTradingOrders, mutateTrading, publicTradingSnapshot, tradingSnapshot } from "../../src/db/trading";
import { fills, holdings, journals, ledgerAccounts, ledgerEntries, markets, orders, sessions, shareMovements, tradingOperations, tradingOutbox, users } from "../../src/db/schema";
import { digest, encryptSecret, randomToken } from "../../src/domain/identity";
import { lockTransactions } from "../../src/db/transaction-lock";
import type { TradingAction } from "../../src/domain/trading";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const name = `jader_trading_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
const isolatedUrl = new URL(url); isolatedUrl.pathname = `/${name}`;
process.env.DATABASE_URL = isolatedUrl.toString();
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
const connection = createDatabase(isolatedUrl.toString());
let created = false;
let adminId: string;
const admin = randomToken();
const alice = randomToken();
const bob = randomToken();
const carol = randomToken();
const ids = new Map<string, string>();
const terms = { question: "Will the fictional trading event occur?", description: "Synthetic collateral-backed trading test.", category: "community", resolutionRules: "Resolve YES only on a verified event, otherwise NO.", resolutionSource: "Synthetic event record", closesAt: new Date("2035-12-31T12:00:00Z"), status: "open" as const, publishedAt: new Date() };

beforeAll(async () => {
  await control.client.unsafe(`CREATE DATABASE "${name}"`); created = true;
  await migrate(connection.db, { migrationsFolder: "drizzle" });
  await connection.db.insert(ledgerAccounts).values({ kind: "issuance" });
  for (const [handle, token] of [["trading_admin", admin], ["alice", alice], ["bob", bob], ["carol", carol]]) {
    const [user] = await connection.db.insert(users).values({ handle, passwordHash: "unused-test-hash", role: token === admin ? "admin" : "participant", mfaSecret: token === admin ? encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") : null }).returning();
    ids.set(token, user.id); if (token === admin) adminId = user.id;
    await connection.db.insert(ledgerAccounts).values([{ ownerId: user.id, kind: "wallet" }, { ownerId: user.id, kind: "reserved" }]);
    await connection.db.insert(sessions).values({ userId: user.id, tokenHash: digest(token), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now() + 3600000) });
  }
  for (const token of [alice, bob, carol]) await fund(token, "100");
});
afterAll(async () => {
  await connection.client.end(); await getDatabase()?.client.end();
  if (created) await control.client.unsafe(`DROP DATABASE "${name}"`);
  await control.client.end();
});
async function market(overrides = {}) { const [row] = await connection.db.insert(markets).values({ ...terms, slug: randomUUID(), ...overrides }).returning(); return row.id; }
const act = (token: string, action: TradingAction, marketId: string, changes = {}) => mutateTrading(token, action, { marketId, operationKey: randomUUID(), quantity: "5", price: "3000", outcome: "YES", side: "buy", timeInForce: "GTC", ...changes });
const fund = (token: string, amount: string, kind = "credit") => adjustCredits(admin, { recipientId: ids.get(token), amount, kind, reason: "correction", operationKey: randomUUID(), confirmed: true });
const snapshot = (token: string, marketId: string) => tradingSnapshot(token, marketId);
async function verifyConservation() {
  const rows = await connection.db.execute(sql`SELECT coalesce(sum(balance),0)::text AS total FROM ledger_accounts`);
  expect(rows[0].total).toBe("0");
  const escrow = await connection.db.execute(sql`SELECT a.balance::text AS balance, coalesce(sum(h.available+h.reserved) FILTER (WHERE h.outcome='YES'),0)::text AS yes, coalesce(sum(h.available+h.reserved) FILTER (WHERE h.outcome='NO'),0)::text AS no FROM ledger_accounts a LEFT JOIN holdings h ON h.market_id=a.market_id WHERE a.kind='escrow' GROUP BY a.id`);
  for (const row of escrow) { expect(row.yes).toBe(row.no); expect(BigInt(row.balance as string)).toBe(BigInt(row.yes as string)*10000n); }
}

describe("collateral-backed trading", () => {
  it("mints and burns complete pairs without issuing credits", async () => {
    const id = await market();
    const before = await snapshot(alice, id);
    await act(alice, "mint", id);
    expect((await snapshot(alice, id)).availableCredits).toBe((BigInt(before.availableCredits)-50000n).toString());
    expect((await snapshot(alice, id)).holdings.map(h => h.available)).toEqual(["5", "5"]);
    await act(alice, "burn", id, { quantity: "2" });
    expect((await snapshot(alice, id)).holdings.map(h => h.available)).toEqual(["3", "3"]);
    await expect(act(alice, "burn", id, { quantity: "4" })).rejects.toMatchObject({ code: "insufficient_shares" });
    await expect(act(alice, "mint", id, { quantity: "1000000" })).rejects.toMatchObject({ code: "insufficient_credits" });
    await expect(act(bob, "place", id, { side: "sell" })).rejects.toMatchObject({ code: "insufficient_shares" });
    await verifyConservation();
  });
  it("matches buy takers at maker price with partial fills and immediate improvement refunds", async () => {
    const id = await market();
    await act(alice, "mint", id);
    const sell = await act(alice, "place", id, { side: "sell", quantity: "3", price: "2000" });
    const before = await snapshot(bob, id);
    const buy = await act(bob, "place", id, { quantity: "5", price: "3000" });
    expect(buy.fills).toMatchObject([{ price: "2000", quantity: "3" }]);
    expect(buy.order).toMatchObject({ status: "open", remaining: "2" });
    expect((await snapshot(alice, id)).orders[0]).toMatchObject({ ...(sell.order as object), remaining: "0", status: "filled" });
    const after = await snapshot(bob, id);
    expect(BigInt(before.availableCredits)-BigInt(after.availableCredits)).toBe(12000n);
    expect(BigInt(after.reservedCredits)-BigInt(before.reservedCredits)).toBe(6000n);
    expect(after.holdings).toMatchObject([{ outcome: "YES", available: "3", reserved: "0" }]);
    await act(bob, "cancel", id, { orderId: (buy.order as { id: string }).id });
    expect((await snapshot(bob, id)).reservedCredits).toBe(before.reservedCredits);
    await verifyConservation();
  });
  it("matches sell takers by best price then FIFO and retains prior partial fills", async () => {
    const id = await market();
    await act(alice, "mint", id, { quantity: "10" });
    await act(bob, "place", id, { price: "3500", quantity: "2" });
    await act(carol, "place", id, { price: "4000", quantity: "2" });
    await act(bob, "place", id, { price: "4000", quantity: "2" });
    const result = await act(alice, "place", id, { side: "sell", price: "3000", quantity: "5" });
    expect(result.fills).toMatchObject([{ price: "4000", quantity: "2" }, { price: "4000", quantity: "2" }, { price: "3500", quantity: "1" }]);
    const book = await publicTradingSnapshot(id);
    expect(book.book).toEqual([{ outcome: "YES", side: "buy", price: "3500", quantity: "1" }]);
    expect((await snapshot(carol, id)).holdings[0].available).toBe("2");
    await verifyConservation();
  });
  it("cancels IOC remainder including zero-fill orders and never auto-mints complementary bids", async () => {
    const id = await market();
    await act(bob, "place", id, { outcome: "NO", price: "7000" });
    const before = await snapshot(alice, id);
    const result = await act(alice, "place", id, { timeInForce: "IOC" });
    expect(result).toMatchObject({ order: { status: "cancelled", reason: "ioc_remainder", remaining: "5" }, fills: [] });
    expect((await snapshot(alice, id)).availableCredits).toBe(before.availableCredits);
    expect((await snapshot(alice, id)).holdings).toEqual([]);
    await act(alice, "mint", id);
    await act(alice, "place", id, { side: "sell", quantity: "2" });
    const partial = await act(carol, "place", id, { quantity: "4", timeInForce: "IOC" });
    expect(partial).toMatchObject({ order: { remaining: "2", status: "cancelled" }, fills: [{ quantity: "2" }] });
    await verifyConservation();
  });
  it("prevents self-trading by cancelling only newest remainder after earlier fills", async () => {
    const id = await market();
    await act(alice, "mint", id); await act(bob, "mint", id);
    await act(bob, "place", id, { side: "sell", price: "2000", quantity: "1" });
    const maker = await act(alice, "place", id, { side: "sell", price: "2500", quantity: "2" });
    const result = await act(alice, "place", id, { quantity: "3", price: "3000" });
    expect(result).toMatchObject({ order: { remaining: "2", status: "cancelled", reason: "self_trade" }, fills: [{ quantity: "1", price: "2000" }] });
    expect((await snapshot(alice, id)).orders.find(o => o.id === (maker.order as { id: string }).id)?.status).toBe("open");
    await verifyConservation();
  });
  it("replays concurrent requests exactly once, rejects changed inputs, and scopes cancellation", async () => {
    const id = await market(); const operationKey = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => act(carol, "mint", id, { operationKey })));
    for (const result of results) expect(result).toEqual(results[0]);
    expect((await snapshot(carol, id)).holdings.map(h => h.available)).toEqual(["5", "5"]);
    await expect(act(carol, "mint", id, { operationKey, quantity: "6" })).rejects.toMatchObject({ code: "operation_conflict" });
    const buy = await act(carol, "place", id);
    const orderId = (buy.order as { id: string }).id;
    await expect(act(alice, "cancel", id, { orderId })).rejects.toMatchObject({ code: "order_missing" });
    await Promise.all([act(carol, "cancel", id, { orderId }), act(carol, "cancel", id, { orderId })]);
    expect((await snapshot(carol, id)).orders[0].status).toBe("cancelled");
    await verifyConservation();
  });
  it("serializes cross-market buys so the same wallet cannot overspend", async () => {
    const first = await market(); const second = await market();
    const before = await snapshot(carol, first);
    const quantity = (BigInt(before.availableCredits)/9999n).toString();
    const results = await Promise.allSettled([act(carol, "place", first, { quantity, price: "9999" }), act(carol, "place", second, { quantity, price: "9999" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "insufficient_credits" } });
    for (const id of [first, second]) for (const order of (await snapshot(carol, id)).orders) await act(carol, "cancel", id, { orderId: order.id });
    await verifyConservation();
  });
  it("serializes sell/burn races and cancellation/fill races without creating inventory", async () => {
    const id = await market(); await act(alice, "mint", id);
    const race = await Promise.allSettled([act(alice, "burn", id), act(alice, "place", id, { side: "sell" })]);
    expect(race.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const open = (await snapshot(alice, id)).orders.find(o => o.status === "open");
    if (open) await act(alice, "cancel", id, { orderId: open.id });
    else await act(alice, "mint", id);
    const sell = await act(alice, "place", id, { side: "sell" });
    await Promise.all([act(alice, "cancel", id, { orderId: (sell.order as { id: string }).id }), act(bob, "place", id, { timeInForce: "IOC" })]);
    expect((await snapshot(alice, id)).orders.every(o => o.status !== "open")).toBe(true);
    await verifyConservation();
  });
  it("keeps resting reservations during pause, releases them atomically on close, and refuses reopening", async () => {
    const id = await market(); const buy = await act(bob, "place", id);
    const before = await snapshot(bob, id);
    await mutateMarket(admin, "pause", { id, revision: 0, confirmed: true, operationKey: randomUUID() });
    await expect(act(alice, "mint", id)).rejects.toMatchObject({ code: "trading_closed" });
    expect((await publicTradingSnapshot(id)).executable).toBe(false);
    expect((await snapshot(bob, id)).reservedCredits).toBe(before.reservedCredits);
    await mutateMarket(admin, "resume", { id, revision: 1, confirmed: true, operationKey: randomUUID() });
    await Promise.allSettled([mutateMarket(admin, "close", { id, revision: 2, confirmed: true, operationKey: randomUUID() }), act(alice, "place", id)]);
    expect((await snapshot(bob, id)).orders.find(o => o.id === (buy.order as { id: string }).id)).toMatchObject({ status: "cancelled", reason: "market_closed" });
    expect((await publicTradingSnapshot(id)).book).toEqual([]);
    await expect(act(bob, "place", id)).rejects.toMatchObject({ code: "trading_closed" });
    await verifyConservation();
  });
  it("expires GTD and deadline orders exactly once and filters stale quotes before maintenance", async () => {
    const expiry = new Date(Math.ceil((Date.now()+1500)/1000)*1000);
    const id = await market({ closesAt: expiry });
    const result = await act(bob, "place", id, { timeInForce: "GTD", expiresAt: expiry.toISOString().replace(".000Z", "Z") });
    const before = await snapshot(bob, id);
    await delay(Math.max(0, expiry.getTime()-Date.now()+30));
    expect((await publicTradingSnapshot(id)).book).toEqual([]);
    await expect(act(bob, "mint", id)).rejects.toMatchObject({ code: "trading_closed" });
    expect(await expireTradingOrders()).toBeGreaterThanOrEqual(1);
    expect(await expireTradingOrders()).toBe(0);
    const after = await snapshot(bob, id);
    expect(BigInt(before.reservedCredits)-BigInt(after.reservedCredits)).toBe(15000n);
    expect(after.orders.find(o => o.id === (result.order as { id: string }).id)?.status).toBe("expired");
    await verifyConservation();
  });
  it("suspends users and releases their orders across markets in the same transaction", async () => {
    const id = await market(); await act(carol, "mint", id); await act(carol, "place", id, { side: "sell" });
    const second = await market(); await act(carol, "place", second);
    await manageParticipant(admin, ids.get(carol), "suspend");
    await expect(snapshot(carol, id)).rejects.toMatchObject({ code: "unauthenticated" });
    expect((await publicTradingSnapshot(id)).book).toEqual([]);
    expect((await connection.db.select().from(orders).where(eq(orders.ownerId, ids.get(carol)!))).every(o => o.status !== "open")).toBe(true);
    await manageParticipant(admin, ids.get(carol), "resume");
    await connection.db.insert(sessions).values({ userId: ids.get(carol)!, tokenHash: digest(carol), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now()+3600000) });
    await verifyConservation();
  });
  it("expires GTD independently of market closure, supports retries after expiry, and skips stale makers", async () => {
    const id = await market(); await act(alice, "mint", id);
    const expiresAt = new Date(Math.ceil((Date.now()+1500)/1000)*1000).toISOString().replace(".000Z", "Z");
    const operationKey = randomUUID();
    const placed = await act(alice, "place", id, { side: "sell", timeInForce: "GTD", expiresAt, operationKey });
    await delay(Math.max(0, Date.parse(expiresAt)-Date.now()+30));
    expect((await publicTradingSnapshot(id)).book).toEqual([]);
    expect(await act(alice, "place", id, { side: "sell", timeInForce: "GTD", expiresAt, operationKey })).toEqual(placed);
    const buy = await act(bob, "place", id, { timeInForce: "IOC" });
    expect(buy.fills).toEqual([]);
    expect((await snapshot(alice, id)).orders[0]).toMatchObject({ status: "expired", reason: "time_expired" });
    await expect(act(bob, "place", id, { timeInForce: "GTD", expiresAt })).rejects.toMatchObject({ code: "invalid_order_expiry" });
    await expect(act(bob, "place", id, { timeInForce: "GTD", expiresAt: "2036-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "invalid_order_expiry" });
    await verifyConservation();
  });
  it("bounds order and execution history with stable cursors and enforces open-order limits", async () => {
    const id = await market();
    for (let i = 0; i < 51; i++) await act(bob, "place", id, { quantity: "1", timeInForce: "IOC" });
    const first = await snapshot(bob, id);
    expect(first.orders).toHaveLength(50); expect(first.nextCursor).not.toBeNull();
    const second = await tradingSnapshot(bob, id, first.nextCursor!);
    expect(second.orders).toHaveLength(1);
    expect(second.orders[0].sequence).not.toBe(first.orders[49].sequence);
    await expect(tradingSnapshot(bob, id, "1e3")).rejects.toMatchObject({ code: "invalid_request" });
    // Injecting an unreserved order is rejected by the database even before the app limit.
    await expect(connection.db.insert(orders).values({ id: randomUUID(), operationId: randomUUID(), ownerId: ids.get(bob)!, marketId: id, outcome: "YES", side: "buy", price: 1n, quantity: 1n, remaining: 1n, timeInForce: "GTC" })).rejects.toThrow();
    for (let i = 0; i < 100; i++) await act(carol, "place", id, { quantity: "1", price: "1" });
    await expect(act(carol, "place", id, { quantity: "1", price: "1" })).rejects.toMatchObject({ code: "order_limit" });
    await mutateMarket(admin, "close", { id, revision: 0, confirmed: true, operationKey: randomUUID() });
    await verifyConservation();
  });
  it("preserves conservation through a deterministic mixed sequence of trades and cancellations", async () => {
    const id = await market();
    await act(alice, "mint", id, { quantity: "40" }); await act(bob, "mint", id, { quantity: "40" });
    let seed = 2027;
    for (let i = 0; i < 30; i++) {
      seed = (seed*1664525+1013904223) >>> 0;
      const token = i%2 === 0 ? alice : bob;
      const result = await act(token, "place", id, { outcome: seed%2 === 0 ? "YES" : "NO", side: i%3 === 0 ? "sell" : "buy", price: String(1000+seed%8000), quantity: "1", timeInForce: i%4 === 0 ? "IOC" : "GTC" });
      if (i%5 === 0 && (result.order as { status: string }).status === "open") await act(token, "cancel", id, { orderId: (result.order as { id: string }).id });
      await verifyConservation();
    }
    await mutateMarket(admin, "close", { id, revision: 0, confirmed: true, operationKey: randomUUID() });
    expect((await publicTradingSnapshot(id)).book).toEqual([]);
    await verifyConservation();
  });
  it("rejects a session that expires while waiting for the financial lock", async () => {
    const id = await market(); const shortToken = randomToken();
    await connection.db.insert(sessions).values({ userId: ids.get(alice)!, tokenHash: digest(shortToken), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now()+400) });
    let unlock: () => void = () => {};
    let acquired: () => void = () => {};
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const blocker = connection.db.transaction(async tx => { await lockTransactions(tx); acquired(); await release; });
    await ready;
    const pending = expect(act(shortToken, "mint", id)).rejects.toMatchObject({ code: "unauthenticated" });
    await delay(450); unlock(); await blocker; await pending;
    expect((await snapshot(alice, id)).holdings).toEqual([]);
  });
  it("keeps books anonymous, portfolios owner-scoped, and drafts private", async () => {
    const id = await market(); await act(alice, "mint", id); await act(alice, "place", id, { side: "sell" });
    await act(bob, "place", id, { quantity: "1" });
    const publicJson = JSON.stringify(await publicTradingSnapshot(id));
    for (const privateValue of [...ids.values(), "ownerId", "orderId", "handle", "reservedCredits", "trading_admin"]) expect(publicJson).not.toContain(privateValue);
    expect((await snapshot(carol, id)).orders).toEqual([]);
    expect((await snapshot(carol, id)).holdings).toEqual([]);
    expect((await snapshot(carol, id)).fills).toEqual([]);
    expect((await snapshot(alice, id)).fills[0]).toMatchObject({ side: "sell", quantity: "1" });
    const draft = await market({ status: "draft", publishedAt: null });
    await expect(publicTradingSnapshot(draft)).rejects.toMatchObject({ code: "market_missing" });
    await expect(snapshot(alice, draft)).rejects.toMatchObject({ code: "market_missing" });
    await verifyConservation();
  });
  it("rejects forged journals, balance edits, share edits, and mutation of immutable records", async () => {
    const id = await market(); await act(alice, "mint", id);
    const stock = (await connection.db.select().from(holdings).where(eq(holdings.marketId, id)))[0];
    await expect(connection.db.update(holdings).set({ available: 10n }).where(eq(holdings.id, stock.id))).rejects.toThrow();
    await expect(connection.db.update(holdings).set({ outcome: "NO" }).where(eq(holdings.id, stock.id))).rejects.toThrow();
    const wallet = (await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.ownerId, ids.get(alice)!))).find(a => a.kind === "wallet")!;
    await expect(connection.db.update(ledgerAccounts).set({ balance: wallet.balance+1n }).where(eq(ledgerAccounts.id, wallet.id))).rejects.toThrow();
    const op = (await connection.db.select().from(tradingOperations).where(eq(tradingOperations.marketId, id)))[0];
    await expect(connection.db.update(tradingOperations).set({ response: {} }).where(eq(tradingOperations.id, op.id))).rejects.toThrow();
    const movement = (await connection.db.select().from(shareMovements))[0];
    await expect(connection.db.delete(shareMovements).where(eq(shareMovements.id, movement.id))).rejects.toThrow();
    const beforeOutbox = (await connection.db.select().from(tradingOutbox)).length;
    await expect(connection.db.transaction(async tx => {
      const operationId = randomUUID();
      await tx.insert(tradingOperations).values({ id: operationId, ownerId: ids.get(alice), marketId: id, action: "mint", requestHash: "synthetic", response: {} });
      const journalId = randomUUID();
      await tx.insert(journals).values({ id: journalId, operationKey: journalId, requestHash: "synthetic", actorId: ids.get(alice)!, recipientId: ids.get(alice)!, kind: "mint", reason: "trading", amount: 10000n, tradingOperationId: operationId });
      await tx.insert(tradingOutbox).values({ operationId, marketId: id, event: "market.changed", payload: {} });
    })).rejects.toThrow();
    expect((await connection.db.select().from(tradingOutbox)).length).toBe(beforeOutbox);
    const issuance = (await connection.db.select().from(ledgerAccounts)).find(a => a.kind === "issuance")!;
    await expect(connection.db.transaction(async tx => {
      const [j] = await tx.insert(journals).values({ operationKey: randomUUID(), requestHash: "synthetic", actorId: ids.get(alice)!, recipientId: ids.get(alice)!, kind: "credit", reason: "demo_grant", amount: 10000n }).returning();
      await tx.insert(ledgerEntries).values([{ journalId: j.id, accountId: issuance.id, delta: -10000n }, { journalId: j.id, accountId: wallet.id, delta: 10000n }]);
    })).rejects.toThrow();
    const escrow = (await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.marketId, id)))[0];
    await expect(connection.db.transaction(async tx => {
      const operationId = randomUUID(); const journalId = randomUUID();
      await tx.insert(tradingOperations).values({ id: operationId, ownerId: ids.get(alice), marketId: id, action: "mint", requestHash: "synthetic", response: {} });
      await tx.insert(journals).values({ id: journalId, operationKey: journalId, requestHash: "synthetic", actorId: ids.get(alice)!, recipientId: ids.get(alice)!, kind: "mint", reason: "trading", amount: 10000n, tradingOperationId: operationId });
      await tx.insert(ledgerEntries).values([{ journalId, accountId: wallet.id, delta: -10000n }, { journalId, accountId: escrow.id, delta: 10000n }]);
      // Balanced cash without both outcome movements must not mint collateral.
    })).rejects.toThrow();
    const reserved = (await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.ownerId, ids.get(alice)!))).find(a => a.kind === "reserved")!;
    await expect(connection.db.transaction(async tx => {
      const operationId = randomUUID(); const journalId = randomUUID();
      await tx.insert(tradingOperations).values({ id: operationId, ownerId: ids.get(alice), marketId: id, action: "place", requestHash: "synthetic", response: {} });
      await tx.insert(journals).values({ id: journalId, operationKey: journalId, requestHash: "synthetic", actorId: ids.get(alice)!, recipientId: ids.get(alice)!, kind: "reserve", reason: "trading", amount: 1000n, tradingOperationId: operationId });
      await tx.insert(ledgerEntries).values([{ journalId, accountId: wallet.id, delta: -1000n }, { journalId, accountId: reserved.id, delta: 1000n }]);
      // Reservation journals need actual outstanding orders at commit.
    })).rejects.toThrow();
    await expect(connection.db.insert(tradingOutbox).values({ operationId: op.id, marketId: id, event: "market.changed", payload: {} })).rejects.toThrow();
    await expect(connection.db.update(fills).set({ price: 1n })).rejects.toThrow();
    expect(adminId).toBeTruthy(); await verifyConservation();
  });
});
