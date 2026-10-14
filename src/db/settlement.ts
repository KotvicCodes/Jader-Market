import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { digest, MemberError } from "../domain/identity";
import { memberDatabase, readSession, requireMember } from "./members";
import { recordMarketChange } from "./events";
import { holdings, ledgerAccounts, marketPayouts, marketResolutions, markets, tradingOutbox } from "./schema";
import { readPayoutHistory } from "./payout-history";
import { lockTransactions } from "./transaction-lock";
import { finishOperation, move, transfer } from "./trading";

// One bounded transaction per pass. Remaining shares are the durable work queue;
// every receipt consumes its shares and pays from escrow in the same commit.
export async function settleMarkets() {
  return memberDatabase().db.transaction(async tx => {
    await lockTransactions(tx);
    const [market] = await tx.select().from(markets).where(eq(markets.status, "settling")).orderBy(asc(markets.id)).limit(1).for("update");
    if (!market) return 0;
    const [resolution] = await tx.select().from(marketResolutions).where(eq(marketResolutions.marketId, market.id));
    const pending = await tx.select().from(holdings).where(and(eq(holdings.marketId, market.id), gt(holdings.available, 0n))).orderBy(asc(holdings.id)).limit(20).for("update");
    for (const stock of pending) {
      const quantity = stock.available > 1_000_000n ? 1_000_000n : stock.available;
      const rate = resolution.result === "invalid" ? 5000n : resolution.result === stock.outcome ? 10000n : 0n;
      const amount = quantity * rate;
      const ctx = { id: randomUUID(), ownerId: resolution.actorId, marketId: market.id };
      let journalId: string | null = null;
      if (amount > 0n) {
        // The entitlement belongs to the holder even if their login is suspended.
        const [escrow] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, "escrow"), eq(ledgerAccounts.marketId, market.id)));
        const [wallet] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, "wallet"), eq(ledgerAccounts.ownerId, stock.ownerId)));
        if (!escrow || !wallet) throw new MemberError("configuration", 503);
        journalId = await transfer(tx, ctx, "payout", stock.ownerId, escrow.id, wallet.id, amount);
      }
      await move(tx, ctx, stock.id, "payout", -quantity, 0n, ctx.id);
      await tx.insert(marketPayouts).values({ id: ctx.id, resolutionId: resolution.id, holdingId: stock.id, ownerId: stock.ownerId, quantity, amount, journalId });
      await tx.insert(tradingOutbox).values({ operationId: ctx.id, marketId: market.id, ownerId: stock.ownerId, event: "portfolio.changed", payload: {} });
      await finishOperation(tx, ctx, "settle", digest(JSON.stringify([resolution.id, stock.id, quantity.toString()])), { receiptId: ctx.id });
    }
    const [remaining] = await tx.select({ id: holdings.id }).from(holdings).where(and(eq(holdings.marketId, market.id), sql`${holdings.available} + ${holdings.reserved} > 0`)).limit(1);
    if (!remaining) {
      await tx.update(markets).set({ status: resolution.result === "invalid" ? "void" : "resolved", revision: market.revision + 1 }).where(eq(markets.id, market.id));
      await recordMarketChange(tx, market.id, resolution.actorId, digest(`settled:${resolution.id}`), true);
    }
    return pending.length;
  });
}

export async function payoutHistory(token: string, page: number) {
  return memberDatabase().db.transaction(async tx => {
    const session = await readSession(token, tx);
    requireMember(session);
    return readPayoutHistory(tx, session.user.id, page);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function publicResolution(marketId: string) {
  const [resolution] = await memberDatabase().db.select({ result: marketResolutions.result, evidence: marketResolutions.evidence, createdAt: marketResolutions.createdAt }).from(marketResolutions).where(eq(marketResolutions.marketId, marketId));
  return resolution ?? null;
}
