import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, getDatabase } from "../../src/db/client";
import { adjustCredits } from "../../src/db/members";
import { portfolioSnapshot } from "../../src/db/portfolio";
import { marketSnapshot } from "../../src/db/market-snapshot";
import { mutateMarket } from "../../src/db/market-admin";
import { mutateTrading } from "../../src/db/trading";
import { mutateWithdrawal } from "../../src/db/withdrawals";
import { settleMarkets } from "../../src/db/settlement";
import { ledgerAccounts, markets, sessions, users } from "../../src/db/schema";
import { digest, encryptSecret, randomToken } from "../../src/domain/identity";
import type { TradingAction } from "../../src/domain/trading";
import type { PortfolioQuery, PortfolioSection } from "../../src/domain/portfolio-query";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const name = `jader_portfolio_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
const isolated = new URL(url); isolated.pathname = `/${name}`;
process.env.DATABASE_URL = isolated.toString();
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
const connection = createDatabase(isolated.toString());
const admin = randomToken(), alice = randomToken(), bob = randomToken(), stranger = randomToken();
const ids = new Map<string, string>();
let created = false;
const terms = { question: "Will the fictional portfolio rehearsal pass?", description: "Synthetic portfolio verification market.", category: "community", resolutionRules: "Resolve YES if the fictional record confirms success, otherwise NO.", resolutionSource: "Synthetic rehearsal record", closesAt: new Date("2035-12-31T12:00:00Z"), status: "open" as const, publishedAt: new Date() };

beforeAll(async () => {
  await control.client.unsafe(`CREATE DATABASE "${name}"`); created = true;
  await migrate(connection.db, { migrationsFolder: "drizzle" });
  await connection.db.insert(ledgerAccounts).values({ kind: "issuance" });
  for (const [handle, token] of [["portfolio_admin", admin], ["alice", alice], ["bob", bob], ["stranger", stranger]]) {
    const [user] = await connection.db.insert(users).values({ handle, passwordHash: "unused-test-hash", role: token === admin ? "admin" : "participant", mfaSecret: token === admin ? encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") : null }).returning();
    ids.set(token, user.id);
    await connection.db.insert(ledgerAccounts).values([{ kind: "wallet", ownerId: user.id }, { kind: "reserved", ownerId: user.id }]);
    await connection.db.insert(sessions).values({ userId: user.id, tokenHash: digest(token), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now() + 3600000) });
  }
  for (const token of [alice, bob]) await adjustCredits(admin, { recipientId: ids.get(token), amount: "100", kind: "credit", reason: "demo_grant", operationKey: randomUUID(), confirmed: true });
});
afterAll(async () => {
  await connection.client.end(); await getDatabase()?.client.end();
  if (created) await control.client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await control.client.end();
});
async function market() { const [row] = await connection.db.insert(markets).values({ ...terms, slug: randomUUID() }).returning(); return row.id; }
const act = (token: string, action: TradingAction, marketId: string, fields = {}) => mutateTrading(token, action, { marketId, operationKey: randomUUID(), quantity: "5", price: "2500", side: "sell", outcome: "YES", timeInForce: "GTC", ...fields });
async function allPages<K extends "activity" | "holdings" | "orders" | "fills" | "payouts">(token: string, key: K, cursorKey: PortfolioSection) {
  const items: Array<Awaited<ReturnType<typeof portfolioSnapshot>>[K]["items"][number]> = [];
  const query: PortfolioQuery = {};
  for (let attempts = 0; attempts < 100; attempts++) {
    const result = (await portfolioSnapshot(token, query))[key];
    items.push(...result.items as typeof items);
    if (!result.nextCursor) return items;
    query[cursorKey] = result.nextCursor;
  }
  throw new Error("Unbounded pagination");
}

describe("complete private portfolio", () => {
  it("reconciles cross-market positions and all owner credit/share movements, including buyer spending", async () => {
    const first = await market(), second = await market();
    await act(alice, "mint", first);
    await act(alice, "mint", second, { quantity: "3" });
    const placed = await act(alice, "place", first, { quantity: "3" });
    const ask = placed.order as { id: string };
    const purchased = await act(bob, "place", first, { side: "buy", price: "3000", quantity: "2", timeInForce: "IOC" });
    const purchase = purchased.order as { id: string };
    const partial = await portfolioSnapshot(alice);
    expect(partial.holdings.items).toHaveLength(4);
    expect(partial.openOrders[0]).toMatchObject({ id: ask.id, remaining: "1", quantity: "3" });
    expect(partial.holdings.items.find(h => h.marketId === first && h.outcome === "YES")).toMatchObject({ available: "2", reserved: "1", total: "3" });
    await act(alice, "cancel", first, { orderId: ask.id });
    await act(alice, "burn", first, { quantity: "1" });
    await act(alice, "place", second, { quantity: "1", side: "buy", outcome: "NO", price: "2000" });
    await mutateWithdrawal(alice, "request", { amount: "1", operationKey: randomUUID(), confirmed: true });
    const snapshot = await portfolioSnapshot(alice);
    expect(snapshot).toMatchObject({ availableCredits: "923000", orderReservedCredits: "2000", withdrawalReservedCredits: "10000", reservedCredits: "12000" });
    const history = await allPages(alice, "activity", "activityBefore");
    const sum = (column: "availableCredits" | "orderReserved" | "withdrawalReserved") => history.reduce((total, row) => total + BigInt(row[column]), 0n).toString();
    expect(sum("availableCredits")).toBe(snapshot.availableCredits);
    expect(sum("orderReserved")).toBe(snapshot.orderReservedCredits);
    expect(sum("withdrawalReserved")).toBe(snapshot.withdrawalReservedCredits);
    for (const holding of snapshot.holdings.items) {
      const movements = history.filter(a => a.marketId === holding.marketId && a.outcome === holding.outcome);
      expect(movements.reduce((sum, a) => sum + BigInt(a.availableShares), 0n).toString()).toBe(holding.available);
      expect(movements.reduce((sum, a) => sum + BigInt(a.reservedShares), 0n).toString()).toBe(holding.reserved);
    }
    const buyer = await portfolioSnapshot(bob, { ownerId: ids.get(alice) });
    expect(buyer.member.id).toBe(ids.get(bob));
    expect(buyer.availableCredits).toBe("995000");
    expect(buyer.fills.items[0]).toMatchObject({ side: "buy", quantity: "2", total: "5000" });
    const buyerHistory = await allPages(bob, "activity", "activityBefore");
    expect(buyerHistory.find(a => a.source === "credit" && a.kind === "trade")).toMatchObject({ orderReserved: "-5000" });
    const json = JSON.stringify(buyer);
    for (const value of [ask.id, ids.get(alice)!, admin, "requestHash", "csrfHash", "tokenHash", "sellOrderId", "makerOrderId"]) expect(json).not.toContain(value);
    expect(json).toContain(purchase.id);
    const empty = await portfolioSnapshot(stranger);
    for (const key of ["holdings", "orders", "fills", "activity", "payouts"] as const) expect(empty[key].items).toEqual([]);
    expect(empty.openOrders).toEqual([]);
  });

  it("keeps old open orders visible while history cursors page independently and new records arrive", async () => {
    const id = await market();
    const old = await act(bob, "place", id, { quantity: "1", side: "buy", price: "1" });
    for (let i = 0; i < 22; i++) await act(bob, "place", id, { quantity: "1", side: "buy", timeInForce: "IOC" });
    const first = await portfolioSnapshot(bob);
    expect(first.orders.items).toHaveLength(20);
    expect(first.orders.items.some(o => o.id === (old.order as { id: string }).id)).toBe(false);
    expect(first.openOrders.some(o => o.id === (old.order as { id: string }).id)).toBe(true);
    await act(bob, "mint", id, { quantity: "1" });
    const second = await portfolioSnapshot(bob, { ordersBefore: first.orders.nextCursor, activityBefore: first.activity.nextCursor });
    expect(second.orders.items.every(o => BigInt(o.sequence) < BigInt(first.orders.nextCursor!))).toBe(true);
    expect(second.orders.items.map(o => o.id).some(id => first.orders.items.some(o => o.id === id))).toBe(false);
    expect(second.openOrders.some(o => o.id === (old.order as { id: string }).id)).toBe(true);
    expect((await portfolioSnapshot(bob, { ordersBefore: first.orders.nextCursor })).activity.items[0].kind).toBe("mint");
    const activity = await allPages(bob, "activity", "activityBefore");
    expect(new Set(activity.map(a => `${a.source}:${a.id}`)).size).toBe(activity.length);
    const [counts] = await connection.db.execute(sql`SELECT (SELECT count(DISTINCT j.id) FROM journals j JOIN ledger_entries e ON e.journal_id=j.id JOIN ledger_accounts a ON a.id=e.account_id WHERE a.owner_id=${ids.get(bob)}::uuid) + (SELECT count(*) FROM share_movements s JOIN holdings h ON h.id=s.holding_id WHERE h.owner_id=${ids.get(bob)}::uuid) AS total`);
    expect(activity.length).toBe(Number(counts.total));
  });

  it("pages holdings and fills completely without leaking the other side's orders", async () => {
    const id = await market();
    await act(alice, "mint", id, { quantity: "21" });
    await act(alice, "place", id, { quantity: "21" });
    for (let i = 0; i < 21; i++) await act(bob, "place", id, { quantity: "1", side: "buy", timeInForce: "IOC" });
    const executions = await allPages(bob, "fills", "fillsBefore");
    expect(executions.filter(f => f.slug && f.quantity === "1")).toHaveLength(21);
    expect(new Set(executions.map(f => f.id)).size).toBe(executions.length);
    for (let i = 0; i < 10; i++) await act(alice, "mint", await market(), { quantity: "1" });
    const first = await portfolioSnapshot(alice);
    expect(first.holdings.items).toHaveLength(20);
    expect(first.holdings.nextCursor).not.toBeNull();
    const all = await allPages(alice, "holdings", "holdingsBefore");
    expect(all.length).toBeGreaterThan(20);
    expect(new Set(all.map(h => h.id)).size).toBe(all.length);
  });

  it("preserves winning and zero-credit losing receipts, removes settled positions, and pages payouts", async () => {
    const settledMarkets: string[] = [];
    for (let i = 0; i < 11; i++) {
      const id = await market(); settledMarkets.push(id);
      await act(bob, "mint", id, { quantity: "1" });
      await mutateMarket(admin, "close", { id, revision: 0, operationKey: randomUUID(), confirmed: true });
      await mutateMarket(admin, "resolve", { id, revision: 1, operationKey: randomUUID(), result: "YES", evidence: "Synthetic records confirm the fictional YES result.", confirmed: true });
      await settleMarkets();
    }
    const result = await portfolioSnapshot(bob);
    expect(result.payouts.items).toHaveLength(20);
    expect(result.payouts.nextCursor).not.toBeNull();
    const payouts = await allPages(bob, "payouts", "payoutsBefore");
    expect(payouts).toHaveLength(22);
    expect(payouts.filter(p => p.amount === "0")).toHaveLength(11);
    const positions = await allPages(bob, "holdings", "holdingsBefore");
    expect(positions.some(p => settledMarkets.includes(p.marketId))).toBe(false);
    const activity = await allPages(bob, "activity", "activityBefore");
    expect(activity.filter(a => a.source === "shares" && a.kind === "payout")).toHaveLength(22);
  });

  it("keeps balances, holdings and history consistent during concurrent financial writes", async () => {
    await adjustCredits(admin, { recipientId: ids.get(stranger), amount: "5", kind: "credit", reason: "demo_grant", operationKey: randomUUID(), confirmed: true });
    const id = await market();
    const writes = Array.from({ length: 4 }, () => act(stranger, "mint", id, { quantity: "1" }));
    const reads = Array.from({ length: 8 }, () => portfolioSnapshot(stranger));
    const snapshots = await Promise.all(reads);
    await Promise.all(writes);
    for (const snapshot of snapshots) {
      expect(snapshot.activity.nextCursor).toBeNull();
      const available = snapshot.activity.items.reduce((sum, row) => sum + BigInt(row.availableCredits), 0n);
      expect(available.toString()).toBe(snapshot.availableCredits);
      for (const holding of snapshot.holdings.items) {
        const movements = snapshot.activity.items.filter(a => a.source === "shares" && a.outcome === holding.outcome);
        expect(movements.reduce((sum, a) => sum + BigInt(a.availableShares), 0n).toString()).toBe(holding.available);
      }
    }
  });

  it("rejects invalid cursors and revoked sessions", async () => {
    await expect(portfolioSnapshot(bob, { activityBefore: "invalid" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(portfolioSnapshot(bob, { fillsBefore: "9223372036854775808" })).rejects.toMatchObject({ code: "invalid_request" });
    await connection.db.delete(sessions).where(eq(sessions.tokenHash, digest(stranger)));
    await expect(portfolioSnapshot(stranger)).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("refreshes public depth, private trading and resolution together without exposing another owner", async () => {
    const id = await market();
    await act(alice, "mint", id, { quantity: "3" });
    await act(alice, "place", id, { quantity: "3" });
    await act(bob, "place", id, { side: "buy", quantity: "1", timeInForce: "IOC" });
    const member = { token: alice, csrf: "synthetic-csrf", user: { id: ids.get(alice)! } };
    const current = await marketSnapshot(id, member);
    expect(current.trading.book).toMatchObject([{ quantity: "2" }]);
    expect(current.account?.portfolio.openOrders).toMatchObject([{ remaining: "2" }]);
    expect(current.account?.portfolio.holdings.find(h => h.outcome === "YES")?.reserved).toBe("2");
    expect(JSON.stringify(current)).not.toContain(ids.get(bob));
    const anonymous = await marketSnapshot(id);
    expect(anonymous.account).toBeNull();
    expect(JSON.stringify(anonymous)).not.toContain(member.user.id);
    await mutateMarket(admin, "close", { id, revision: 0, operationKey: randomUUID(), confirmed: true });
    await mutateMarket(admin, "resolve", { id, revision: 1, operationKey: randomUUID(), result: "YES", evidence: "Synthetic evidence confirms the fictional YES result.", confirmed: true });
    await settleMarkets();
    const settled = await marketSnapshot(id, member);
    expect(settled.trading.status).toBe("resolved");
    expect(settled.resolution?.result).toBe("YES");
    expect(settled.account?.portfolio.openOrders).toEqual([]);
    expect(settled.account?.portfolio.holdings.every(h => h.available === "0" && h.reserved === "0")).toBe(true);
  });
});
