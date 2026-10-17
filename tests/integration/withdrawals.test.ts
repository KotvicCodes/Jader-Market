import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, getDatabase } from "../../src/db/client";
import { accountSnapshot, adjustCredits, manageParticipant } from "../../src/db/members";
import { mutateWithdrawal, withdrawalSnapshot } from "../../src/db/withdrawals";
import { mutateTrading, tradingSnapshot } from "../../src/db/trading";
import { journals, ledgerAccounts, ledgerEntries, markets, sessions, tradingOutbox, users, withdrawalOperations, withdrawals } from "../../src/db/schema";
import { digest, encryptSecret, randomToken } from "../../src/domain/identity";
import type { WithdrawalAction } from "../../src/domain/withdrawals";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const name = `jader_withdrawals_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
const isolated = new URL(url); isolated.pathname = `/${name}`;
process.env.DATABASE_URL = isolated.toString();
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
const connection = createDatabase(isolated.toString());
const admin = randomToken();
const ids = new Map<string, string>();
let created = false;
let legacy: string;

beforeAll(async () => {
  await control.client.unsafe(`CREATE DATABASE "${name}"`); created = true;
  const previous = mkdtempSync(join(tmpdir(), "jader-withdrawal-upgrade-"));
  try {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 5);
    mkdirSync(join(previous, "meta"));
    writeFileSync(join(previous, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(`drizzle/${entry.tag}.sql`, join(previous, `${entry.tag}.sql`));
    await migrate(connection.db, { migrationsFolder: previous });
  } finally { rmSync(previous, { recursive: true, force: true }); }
  await connection.db.insert(ledgerAccounts).values({ kind: "issuance" });
  await person(admin, "admin");
  legacy = await person();
  const wallet = (await connection.db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.ownerId, ids.get(legacy)!), eq(ledgerAccounts.kind, "wallet"))))[0].id;
  const issuance = (await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.kind, "issuance")))[0].id;
  // Preserve an old confirmed offline debit across the migration, without using
  // current-schema insert helpers against the previous schema.
  for (const [kind, amount, reason] of [["credit", 1000000, "demo_grant"], ["debit", 100000, "offline_debit"]] as const) {
    await connection.db.transaction(async tx => {
      const id = randomUUID(); const delta = kind === "credit" ? amount : -amount;
      await tx.execute(sql`INSERT INTO journals (id,operation_key,request_hash,actor_id,recipient_id,kind,reason,amount) VALUES (${id},${id},'synthetic',${ids.get(admin)},${ids.get(legacy)},${kind},${reason},${amount})`);
      await tx.insert(ledgerEntries).values([{ journalId: id, accountId: wallet, delta: BigInt(delta) }, { journalId: id, accountId: issuance, delta: BigInt(-delta) }]);
    });
  }
  await migrate(connection.db, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  await connection.client.end(); await getDatabase()?.client.end();
  if (created) await control.client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await control.client.end();
});
async function person(token = randomToken(), role = "participant") {
  const [user] = await connection.db.insert(users).values({ handle: `withdraw_${randomUUID().replaceAll("-", "").slice(0, 14)}`, passwordHash: "unused-synthetic-hash", role, mfaSecret: role === "admin" ? encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") : null }).returning();
  ids.set(token, user.id);
  await connection.db.insert(ledgerAccounts).values([{ kind: "wallet", ownerId: user.id }, { kind: "reserved", ownerId: user.id }]);
  await connection.db.insert(sessions).values({ userId: user.id, tokenHash: digest(token), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now() + 3600000) });
  return token;
}
async function funded() {
  const token = await person();
  await adjustCredits(admin, { recipientId: ids.get(token), amount: "100", kind: "credit", reason: "demo_grant", operationKey: randomUUID(), confirmed: true });
  return token;
}
const request = (token: string, amount = "20", operationKey = randomUUID()) => mutateWithdrawal(token, "request", { amount, operationKey, confirmed: true });
const act = (token: string, action: WithdrawalAction, row: Record<string, unknown>, extra = {}) => mutateWithdrawal(token, action, { id: row.id, previousOperationId: row.lastOperationId, operationKey: randomUUID(), confirmed: true, note: "Synthetic verification confirms no payment was sent.", ...extra });
async function conserved() {
  expect((await connection.db.execute(sql`SELECT sum(balance)::text AS total FROM ledger_accounts`))[0].total).toBe("0");
  const bad = await connection.db.execute(sql`SELECT a.id FROM ledger_accounts a WHERE a.kind='withdrawal_reserved' AND a.balance<>(SELECT coalesce(sum(w.amount),0) FROM withdrawals w WHERE w.owner_id=a.owner_id AND w.status IN ('requested','processing'))`);
  expect(bad).toHaveLength(0);
}

describe("reserved offline withdrawals", () => {
  it("upgrades existing balances and retains historical confirmed offline debits", async () => {
    const snapshot = await accountSnapshot(legacy);
    expect(snapshot.available).toBe(900000n);
    expect(snapshot.history.some(row => row.reason === "offline_debit")).toBe(true);
    expect(snapshot.withdrawalReserved).toBe(0n);
    await expect(adjustCredits(admin, { recipientId: ids.get(legacy), amount: "1", kind: "debit", reason: "offline_debit", operationKey: randomUUID(), confirmed: true })).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("reserves once under concurrent retries and isolates private requests", async () => {
    const alice = await funded(); const bob = await funded(); const key = randomUUID();
    const rows = await Promise.all(Array.from({ length: 4 }, () => request(alice, "20", key)));
    expect(rows.every(row => row.id === key)).toBe(true);
    expect(await accountSnapshot(alice)).toMatchObject({ available: 800000n, reserved: 200000n, withdrawalReserved: 200000n });
    expect((await withdrawalSnapshot(alice)).items).toHaveLength(1);
    expect((await withdrawalSnapshot(bob)).items).toHaveLength(0);
    await expect(act(bob, "cancel", rows[0])).rejects.toMatchObject({ code: "withdrawal_missing" });
    await expect(request(alice, "21", key)).rejects.toMatchObject({ code: "operation_conflict" });
    await expect(request(bob, "20", key)).rejects.toMatchObject({ code: "operation_conflict" });
    const events = await connection.db.select().from(tradingOutbox).where(eq(tradingOutbox.ownerId, ids.get(alice)!));
    expect(events).toHaveLength(2);
    expect(events.every(event => event.marketId === null && event.operationId === null && event.event === "portfolio.changed")).toBe(true);
    await conserved();
  });
  it("serializes withdrawals against other withdrawals and trading", async () => {
    const alice = await funded();
    const attempts = await Promise.allSettled([request(alice, "80"), request(alice, "80")]);
    expect(attempts.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(await accountSnapshot(alice)).toMatchObject({ available: 200000n, withdrawalReserved: 800000n });
    const bob = await funded();
    const [market] = await connection.db.insert(markets).values({ slug: randomUUID(), question: "Will the synthetic test event happen?", description: "Synthetic withdrawal and trading race.", category: "community", resolutionRules: "Resolve YES on the synthetic record, otherwise NO.", resolutionSource: "Synthetic record", closesAt: new Date("2035-12-31T12:00:00Z"), status: "open", publishedAt: new Date() }).returning();
    const race = await Promise.allSettled([request(bob, "80"), mutateTrading(bob, "mint", { marketId: market.id, quantity: "80", operationKey: randomUUID() })]);
    expect(race.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect((await accountSnapshot(bob)).available).toBe(200000n);
    const snapshot = await tradingSnapshot(alice, market.id);
    expect(snapshot.reservedCredits).toBe("800000");
    await expect(adjustCredits(admin, { recipientId: ids.get(alice), amount: "30", kind: "debit", reason: "correction", operationKey: randomUUID(), confirmed: true })).rejects.toMatchObject({ code: "insufficient_credits" });
    await conserved();
  });
  it("allows owner cancellation before processing and releases once", async () => {
    const alice = await funded(); const row = await request(alice);
    const operationKey = randomUUID();
    const cancelled = await act(alice, "cancel", row, { operationKey });
    expect(cancelled.status).toBe("cancelled");
    expect(await act(alice, "cancel", row, { operationKey })).toEqual(cancelled);
    expect(await accountSnapshot(alice)).toMatchObject({ available: 1000000n, withdrawalReserved: 0n });
    await expect(act(admin, "start", row)).rejects.toMatchObject({ code: "withdrawal_stale" });
    await expect(act(alice, "cancel", cancelled)).rejects.toMatchObject({ code: "withdrawal_transition" });
    await conserved();
  });
  it("requires recent administrator MFA for processing and preserves uncertain transfers", async () => {
    const alice = await funded(); const row = await request(alice);
    await expect(act(alice, "start", row)).rejects.toMatchObject({ code: "forbidden" });
    await expect(act(admin, "pay", row, { reference: "not-yet-processing" })).rejects.toMatchObject({ code: "withdrawal_transition" });
    await connection.db.update(sessions).set({ authenticatedAt: new Date(Date.now() - 11 * 60000) }).where(eq(sessions.tokenHash, digest(admin)));
    await expect(act(admin, "start", row)).rejects.toMatchObject({ code: "reauth_required" });
    await connection.db.update(sessions).set({ authenticatedAt: new Date() }).where(eq(sessions.tokenHash, digest(admin)));
    const processing = await act(admin, "start", row);
    expect(processing.status).toBe("processing");
    await expect(act(alice, "cancel", processing)).rejects.toMatchObject({ code: "withdrawal_transition" });
    await expect(act(admin, "release", processing)).rejects.toMatchObject({ code: "withdrawal_transition" });
    expect(await accountSnapshot(alice)).toMatchObject({ available: 800000n, withdrawalReserved: 200000n });
    expect((await withdrawalSnapshot(alice)).items[0].status).toBe("processing");
    expect((await withdrawalSnapshot(admin, 1, true, true)).items.some(item => item.id === row.id)).toBe(true);
    await expect(withdrawalSnapshot(alice, 1, true)).rejects.toMatchObject({ code: "forbidden" });
    await conserved();
  });
  it("confirms completed payments exactly once, including suspended owners", async () => {
    const alice = await funded(); const row = await request(alice); const processing = await act(admin, "start", row);
    await manageParticipant(admin, ids.get(alice)!, "suspend");
    await expect(request(alice)).rejects.toMatchObject({ code: "unauthenticated" });
    const operationKey = randomUUID(); const reference = `synthetic-${randomUUID()}`;
    const paid = await Promise.all(Array.from({ length: 3 }, () => act(admin, "pay", processing, { operationKey, reference })));
    expect(paid.every(item => item.status === "paid")).toBe(true);
    const wallet = (await connection.db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.ownerId, ids.get(alice)!), eq(ledgerAccounts.kind, "wallet"))))[0];
    expect(wallet.balance).toBe(800000n);
    const payments = await connection.db.select().from(journals).where(eq(journals.withdrawalOperationId, operationKey));
    expect(payments).toHaveLength(1); expect(payments[0].kind).toBe("debit");
    const bob = await funded(); const second = await act(admin, "start", await request(bob));
    await expect(act(admin, "pay", second, { reference })).rejects.toMatchObject({ code: "withdrawal_reference_used" });
    expect((await accountSnapshot(bob)).withdrawalReserved).toBe(200000n);
    await conserved();
  });
  it("only releases a processing withdrawal after explicit unpaid verification", async () => {
    const alice = await funded(); const processing = await act(admin, "start", await request(alice));
    await expect(act(alice, "release", processing, { verifiedNotSent: true })).rejects.toMatchObject({ code: "forbidden" });
    const operationKey = randomUUID();
    const released = await act(admin, "release", processing, { operationKey, verifiedNotSent: true });
    expect(released.status).toBe("cancelled");
    expect(await act(admin, "release", processing, { operationKey, verifiedNotSent: true })).toEqual(released);
    expect(await accountSnapshot(alice)).toMatchObject({ available: 1000000n, withdrawalReserved: 0n });
    expect((await withdrawalSnapshot(alice)).items[0].history.map(event => event.action)).toEqual(["release", "start", "request"]);
    await conserved();
  });
  it("rolls back failed requests without creating history or reservations", async () => {
    const alice = await funded();
    await expect(request(alice, "101")).rejects.toMatchObject({ code: "insufficient_credits" });
    expect((await withdrawalSnapshot(alice)).items).toHaveLength(0);
    expect(await accountSnapshot(alice)).toMatchObject({ available: 1000000n, reserved: 0n });
    await conserved();
  });
  it("bounds active requests and paginates private history", async () => {
    const alice = await funded(); const rows = [];
    for (let i = 0; i < 20; i++) rows.push(await request(alice, "1"));
    await expect(request(alice, "1")).rejects.toMatchObject({ code: "withdrawal_limit" });
    await act(alice, "cancel", rows[0]); await request(alice, "1");
    const first = await withdrawalSnapshot(alice); const next = await withdrawalSnapshot(alice, 2);
    expect(first.items).toHaveLength(20); expect(first.hasNext).toBe(true);
    expect(next.items).toHaveLength(1); expect(next.hasNext).toBe(false);
    expect(new Set([...first.items, ...next.items].map(row => row.id)).size).toBe(21);
    await conserved();
  });
  it("rejects database tampering and bypassing the reserved workflow", async () => {
    const alice = await funded(); const row = await request(alice);
    await expect(connection.db.update(withdrawals).set({ status: "paid", lastOperationId: randomUUID() }).where(eq(withdrawals.id, row.id as string))).rejects.toThrow();
    await expect(connection.db.update(withdrawals).set({ amount: 1n }).where(eq(withdrawals.id, row.id as string))).rejects.toThrow();
    await expect(connection.db.delete(withdrawals).where(eq(withdrawals.id, row.id as string))).rejects.toThrow();
    await expect(connection.db.update(withdrawalOperations).set({ reference: "changed" }).where(eq(withdrawalOperations.id, row.id as string))).rejects.toThrow();
    await expect(connection.db.insert(withdrawals).values({ id: randomUUID(), ownerId: ids.get(alice)!, amount: 10000n, status: "requested", lastOperationId: randomUUID() })).rejects.toThrow();
    const [wallet] = await connection.db.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.ownerId, ids.get(alice)!), eq(ledgerAccounts.kind, "wallet")));
    const [issuance] = await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.kind, "issuance"));
    await expect(connection.db.transaction(async tx => {
      const [journal] = await tx.insert(journals).values({ operationKey: randomUUID(), requestHash: "synthetic", actorId: ids.get(admin)!, recipientId: ids.get(alice)!, kind: "debit", reason: "offline_debit", amount: 10000n }).returning();
      await tx.insert(ledgerEntries).values([{ journalId: journal.id, accountId: wallet.id, delta: -10000n }, { journalId: journal.id, accountId: issuance.id, delta: 10000n }]);
    })).rejects.toThrow();
    await conserved();
  });
});
