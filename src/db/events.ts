import { randomUUID } from "node:crypto";
import { tradingOperations, tradingOutbox } from "./schema";
import type { Transaction } from "./transaction-lock";

export async function recordMarketChange(tx: Transaction, marketId: string, actorId: string, requestHash: string, isPublic: boolean) {
  const id = randomUUID();
  await tx.insert(tradingOperations).values({ id, marketId, ownerId: actorId, action: "maintenance", requestHash, response: {} });
  await tx.insert(tradingOutbox).values({ operationId: id, marketId, ownerId: isPublic ? null : actorId, event: isPublic ? "market.changed" : "market.admin.changed", payload: {} });
}

export async function recordCreditChange(tx: Transaction, journalId: string, ownerId: string) {
  await tx.insert(tradingOutbox).values({ journalId, ownerId, event: "portfolio.changed", payload: {} });
}
