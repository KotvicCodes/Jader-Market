import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { holdings, ledgerAccounts, ledgerEntries, orders, shareMovements, tradingOperations } from "../../src/db/schema";
import type { Database, Transaction } from "../../src/db/transaction-lock";

// Upgrade fixtures must write the historical columns, independently of the
// current Drizzle schema and services, which require the latest migration.
export async function legacyJournal(tx: Transaction, row: { id?: string; operationKey: string; requestHash: string; actorId: string; recipientId: string; kind: string; reason: string; amount: bigint; tradingOperationId?: string }) {
  const id = row.id ?? randomUUID();
  await tx.execute(sql`INSERT INTO journals (id,operation_key,request_hash,actor_id,recipient_id,kind,reason,amount,trading_operation_id)
    VALUES (${id},${row.operationKey},${row.requestHash},${row.actorId},${row.recipientId},${row.kind},${row.reason},${row.amount},${row.tradingOperationId ?? null})`);
  return { id };
}

export async function legacyCredit(db: Database, adminId: string, ownerId: string, amount: bigint) {
  return db.transaction(async tx => {
    const accounts = await tx.select().from(ledgerAccounts);
    const issuance = accounts.find(row => row.kind === "issuance")!;
    const wallet = accounts.find(row => row.kind === "wallet" && row.ownerId === ownerId)!;
    const journal = await legacyJournal(tx, { operationKey: randomUUID(), requestHash: "legacy-credit", actorId: adminId, recipientId: ownerId, kind: "credit", reason: "correction", amount });
    await tx.insert(ledgerEntries).values([{ journalId: journal.id, accountId: issuance.id, delta: -amount }, { journalId: journal.id, accountId: wallet.id, delta: amount }]);
  });
}

export async function legacyMintAndAsk(db: Database, ownerId: string, marketId: string) {
  const [escrow] = await db.insert(ledgerAccounts).values({ kind: "escrow", marketId }).returning();
  const stock = await db.insert(holdings).values([{ ownerId, marketId, outcome: "YES" }, { ownerId, marketId, outcome: "NO" }]).returning();
  await db.transaction(async tx => {
    const id = randomUUID(), journalId = randomUUID();
    const [wallet] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, "wallet"), eq(ledgerAccounts.ownerId, ownerId)));
    await legacyJournal(tx, { id: journalId, operationKey: journalId, requestHash: "legacy-mint", actorId: ownerId, recipientId: ownerId, kind: "mint", reason: "trading", amount: 50000n, tradingOperationId: id });
    await tx.insert(ledgerEntries).values([{ journalId, accountId: wallet.id, delta: -50000n }, { journalId, accountId: escrow.id, delta: 50000n }]);
    await tx.insert(shareMovements).values(stock.map(row => ({ operationId: id, groupId: journalId, holdingId: row.id, kind: "mint", availableDelta: 5n, reservedDelta: 0n })));
    await tx.insert(tradingOperations).values({ id, ownerId, marketId, action: "mint", requestHash: "legacy-mint", response: {} });
  });
  return db.transaction(async tx => {
    const id = randomUUID(); const yes = stock.find(row => row.outcome === "YES")!;
    await tx.insert(orders).values({ id, operationId: id, ownerId, marketId, outcome: "YES", side: "sell", price: 3000n, quantity: 2n, remaining: 2n, timeInForce: "GTC" });
    await tx.insert(shareMovements).values({ operationId: id, groupId: id, holdingId: yes.id, kind: "reserve", availableDelta: -2n, reservedDelta: 2n });
    await tx.insert(tradingOperations).values({ id, ownerId, marketId, action: "place", requestHash: "legacy-order", response: {} });
    return id;
  });
}
