import { desc, eq } from "drizzle-orm";
import { holdings, marketPayouts, marketResolutions, markets } from "./schema";
import type { Database, Transaction } from "./transaction-lock";

export async function readPayoutHistory(executor: Database | Transaction, ownerId: string, page: number) {
  const rows = await executor.select({ id: marketPayouts.id, quantity: marketPayouts.quantity, amount: marketPayouts.amount, createdAt: marketPayouts.createdAt,
    outcome: holdings.outcome, result: marketResolutions.result, question: markets.question, slug: markets.slug,
  }).from(marketPayouts).innerJoin(holdings, eq(holdings.id, marketPayouts.holdingId))
    .innerJoin(marketResolutions, eq(marketResolutions.id, marketPayouts.resolutionId)).innerJoin(markets, eq(markets.id, marketResolutions.marketId))
    .where(eq(marketPayouts.ownerId, ownerId)).orderBy(desc(marketPayouts.sequence)).limit(21).offset((page - 1) * 20);
  return { items: rows.slice(0, 20), hasNext: rows.length > 20 };
}
