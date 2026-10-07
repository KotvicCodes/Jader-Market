import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "../../src/db/client";
import { journals, ledgerAccounts, ledgerEntries, users } from "../../src/db/schema";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const connection = createDatabase(url);
let actor: string;
let recipient: string;
let wallet: string;
let funding: string;
let journal: string;

beforeAll(async () => {
  await migrate(connection.db, { migrationsFolder: "drizzle" });
  const suffix = randomUUID().slice(0, 8);
  [actor, recipient] = (await connection.db.insert(users).values([
    { handle: `guard_admin_${suffix}`, passwordHash: "synthetic-unused", role: "admin" },
    { handle: `guard_user_${suffix}`, passwordHash: "synthetic-unused" },
  ]).returning()).map(user => user.id);
  await connection.db.insert(ledgerAccounts).values({ kind: "issuance" }).onConflictDoNothing();
  funding = (await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.kind, "issuance")))[0].id;
  wallet = (await connection.db.insert(ledgerAccounts).values({ kind: "wallet", ownerId: recipient }).returning())[0].id;
});
afterAll(async () => { await connection.client.end(); });

describe("database ledger safeguards", () => {
  it("commits a balanced journal and updates its wallet projection", async () => {
    journal = await connection.db.transaction(async tx => {
      const [record] = await tx.insert(journals).values({ operationKey: randomUUID(), requestHash: "synthetic", actorId: actor, recipientId: recipient, kind: "credit", reason: "demo_grant", amount: 10000n }).returning();
      await tx.insert(ledgerEntries).values([{ journalId: record.id, accountId: funding, delta: -10000n }, { journalId: record.id, accountId: wallet, delta: 10000n }]);
      return record.id;
    });
    expect((await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, wallet)))[0].balance).toBe(10000n);
  });
  it("rejects incomplete journals and participant-issued credits", async () => {
    await expect(connection.db.insert(journals).values({ operationKey: randomUUID(), requestHash: "synthetic", actorId: actor, recipientId: recipient, kind: "credit", reason: "demo_grant", amount: 10000n })).rejects.toThrow();
    await expect(connection.db.transaction(async tx => {
      const [record] = await tx.insert(journals).values({ operationKey: randomUUID(), requestHash: "synthetic", actorId: recipient, recipientId: recipient, kind: "credit", reason: "demo_grant", amount: 10000n }).returning();
      await tx.insert(ledgerEntries).values([{ journalId: record.id, accountId: funding, delta: -10000n }, { journalId: record.id, accountId: wallet, delta: 10000n }]);
    })).rejects.toThrow();
  });
  it("rejects balance edits, history edits, and new lines on a committed journal", async () => {
    await expect(connection.db.update(ledgerAccounts).set({ balance: 50000n }).where(eq(ledgerAccounts.id, wallet))).rejects.toThrow();
    await expect(connection.db.update(journals).set({ reason: "correction" }).where(eq(journals.id, journal))).rejects.toThrow();
    await expect(connection.db.delete(ledgerEntries).where(eq(ledgerEntries.journalId, journal))).rejects.toThrow();
    const [extra] = await connection.db.insert(ledgerAccounts).values({ kind: "reserved", ownerId: recipient }).returning();
    await expect(connection.db.insert(ledgerEntries).values({ journalId: journal, accountId: extra.id, delta: 100n })).rejects.toThrow();
  });
  it("rolls back a debit that would make a wallet negative", async () => {
    await expect(connection.db.transaction(async tx => {
      const [record] = await tx.insert(journals).values({ operationKey: randomUUID(), requestHash: "synthetic", actorId: actor, recipientId: recipient, kind: "debit", reason: "correction", amount: 20000n }).returning();
      await tx.insert(ledgerEntries).values([{ journalId: record.id, accountId: funding, delta: 20000n }, { journalId: record.id, accountId: wallet, delta: -20000n }]);
    })).rejects.toThrow();
    expect((await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, wallet)))[0].balance).toBe(10000n);
  });
});
