import { and, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { effectiveMarketStatus } from "../domain/market-admin";
import { activityCursor, parsePortfolioQuery } from "../domain/portfolio-query";
import { maxOpenOrders } from "../domain/trading";
import { memberDatabase, readSession, requireMember } from "./members";
import { fills, holdings, ledgerAccounts, marketPayouts, marketResolutions, markets, orders } from "./schema";
import type { Transaction } from "./transaction-lock";

const pageSize = 20;
type Order = typeof orders.$inferSelect;
const marketFields = { marketId: markets.id, slug: markets.slug, question: markets.question, marketStatus: markets.status, paused: markets.paused, closesAt: markets.closesAt };
function orderView(row: { order: Order; market: { marketId: string; slug: string; question: string; marketStatus: typeof markets.$inferSelect.status; paused: boolean; closesAt: Date } }) {
  const { order, market } = row;
  return { id: order.id, marketId: market.marketId, slug: market.slug, question: market.question, marketStatus: effectiveMarketStatus({ ...market, status: market.marketStatus }), outcome: order.outcome, side: order.side, price: order.price.toString(), quantity: order.quantity.toString(), remaining: order.remaining.toString(), status: order.status, reason: order.reason, timeInForce: order.timeInForce, expiresAt: order.expiresAt?.toISOString() ?? null, createdAt: order.createdAt.toISOString(), sequence: order.sequence.toString() };
}
function page<T>(rows: T[], cursor: (item: T) => string) {
  const items = rows.slice(0, pageSize);
  return { items, nextCursor: rows.length > pageSize ? cursor(items[pageSize - 1]) : null };
}

type ActivityRow = {
  id: string; source: "credit" | "shares"; at: string; kind: string; reason: string;
  market_id: string | null; slug: string | null; question: string | null; outcome: "YES" | "NO" | null;
  available_credits: string; order_reserved: string; withdrawal_reserved: string; available_shares: string; reserved_shares: string;
};
async function activityHistory(tx: Transaction, ownerId: string, before?: string) {
  const cursor = before ? activityCursor(before) : undefined;
  // Read actual owner-scoped entries: a buyer's trade journal names the seller as
  // recipient, and filtering journals.recipient_id would silently omit spending.
  const rows = await tx.execute<ActivityRow>(sql`
    WITH activity AS (
      SELECT j.id, j.created_at, 'credit'::text AS source, j.kind, j.reason, t.market_id,
        NULL::text AS outcome,
        sum(CASE WHEN a.kind='wallet' THEN e.delta ELSE 0 END)::text AS available_credits,
        sum(CASE WHEN a.kind='reserved' THEN e.delta ELSE 0 END)::text AS order_reserved,
        sum(CASE WHEN a.kind='withdrawal_reserved' THEN e.delta ELSE 0 END)::text AS withdrawal_reserved,
        '0'::text AS available_shares, '0'::text AS reserved_shares
      FROM journals j JOIN ledger_entries e ON e.journal_id=j.id JOIN ledger_accounts a ON a.id=e.account_id
      LEFT JOIN trading_operations t ON t.id=j.trading_operation_id
      WHERE a.owner_id=${ownerId}::uuid
      GROUP BY j.id, t.market_id
      UNION ALL
      SELECT s.id, t.created_at, 'shares'::text, s.kind, 'trading'::text, h.market_id, h.outcome,
        '0'::text, '0'::text, '0'::text, s.available_delta::text, s.reserved_delta::text
      FROM share_movements s JOIN holdings h ON h.id=s.holding_id JOIN trading_operations t ON t.id=s.operation_id
      WHERE h.owner_id=${ownerId}::uuid
    )
    SELECT activity.id, activity.source, to_char(activity.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      activity.kind, activity.reason, activity.market_id, m.slug, m.question, activity.outcome,
      activity.available_credits, activity.order_reserved, activity.withdrawal_reserved, activity.available_shares, activity.reserved_shares
    FROM activity LEFT JOIN markets m ON m.id=activity.market_id
    ${cursor ? sql`WHERE (activity.created_at, activity.source, activity.id) < (${cursor.at}::timestamptz, ${cursor.source}::text, ${cursor.id}::uuid)` : sql``}
    ORDER BY activity.created_at DESC, activity.source DESC, activity.id DESC LIMIT ${pageSize + 1}
  `);
  return page(rows.map(row => ({ id: row.id, source: row.source, createdAt: row.at, kind: row.kind, reason: row.reason, marketId: row.market_id, slug: row.slug, question: row.question, outcome: row.outcome, availableCredits: row.available_credits, orderReserved: row.order_reserved, withdrawalReserved: row.withdrawal_reserved, availableShares: row.available_shares, reservedShares: row.reserved_shares })), item => `${item.createdAt}~${item.source}~${item.id}`);
}

export async function portfolioSnapshot(token: string, input: Record<string, unknown> = {}) {
  const query = parsePortfolioQuery(input);
  return memberDatabase().db.transaction(async tx => {
    const session = await readSession(token, tx);
    requireMember(session);
    const ownerId = session.user.id;
    const balances = await tx.select({ kind: ledgerAccounts.kind, balance: ledgerAccounts.balance }).from(ledgerAccounts).where(eq(ledgerAccounts.ownerId, ownerId));
    const balance = (kind: string) => balances.find(a => a.kind === kind)?.balance ?? 0n;
    const stock = await tx.select({ id: holdings.id, outcome: holdings.outcome, available: holdings.available, reserved: holdings.reserved, market: marketFields }).from(holdings).innerJoin(markets, eq(markets.id, holdings.marketId))
      .where(and(eq(holdings.ownerId, ownerId), or(gt(holdings.available, 0n), gt(holdings.reserved, 0n)), query.holdingsBefore ? lt(holdings.id, query.holdingsBefore) : undefined)).orderBy(desc(holdings.id)).limit(pageSize + 1);
    const readOrders = () => tx.select({ order: orders, market: marketFields }).from(orders).innerJoin(markets, eq(markets.id, orders.marketId));
    const openOrders = await readOrders().where(and(eq(orders.ownerId, ownerId), eq(orders.status, "open"))).orderBy(desc(orders.sequence)).limit(maxOpenOrders);
    const orderHistory = await readOrders().where(and(eq(orders.ownerId, ownerId), query.ordersBefore ? lt(orders.sequence, BigInt(query.ordersBefore)) : undefined)).orderBy(desc(orders.sequence)).limit(pageSize + 1);
    const ownOrders = tx.select({ id: orders.id }).from(orders).where(eq(orders.ownerId, ownerId));
    const executions = await tx.select({ id: fills.id, sequence: fills.sequence, outcome: fills.outcome, price: fills.price, quantity: fills.quantity, createdAt: fills.createdAt, market: marketFields,
      side: sql<"buy" | "sell">`CASE WHEN ${fills.buyOrderId} IN (${ownOrders}) THEN 'buy' ELSE 'sell' END`,
    }).from(fills).innerJoin(markets, eq(markets.id, fills.marketId)).where(and(or(inArray(fills.buyOrderId, ownOrders), inArray(fills.sellOrderId, ownOrders)), query.fillsBefore ? lt(fills.sequence, BigInt(query.fillsBefore)) : undefined)).orderBy(desc(fills.sequence)).limit(pageSize + 1);
    const payouts = await tx.select({ id: marketPayouts.id, sequence: marketPayouts.sequence, quantity: marketPayouts.quantity, amount: marketPayouts.amount, createdAt: marketPayouts.createdAt, outcome: holdings.outcome, result: marketResolutions.result, slug: markets.slug, question: markets.question }).from(marketPayouts).innerJoin(holdings, eq(holdings.id, marketPayouts.holdingId)).innerJoin(marketResolutions, eq(marketResolutions.id, marketPayouts.resolutionId)).innerJoin(markets, eq(markets.id, marketResolutions.marketId)).where(and(eq(marketPayouts.ownerId, ownerId), query.payoutsBefore ? lt(marketPayouts.sequence, BigInt(query.payoutsBefore)) : undefined)).orderBy(desc(marketPayouts.sequence)).limit(pageSize + 1);
    const activity = await activityHistory(tx, ownerId, query.activityBefore);
    return {
      member: { id: ownerId, handle: session.user.handle }, loadedAt: new Date().toISOString(),
      availableCredits: balance("wallet").toString(), orderReservedCredits: balance("reserved").toString(), withdrawalReservedCredits: balance("withdrawal_reserved").toString(), reservedCredits: (balance("reserved") + balance("withdrawal_reserved")).toString(),
      holdings: page(stock.map(h => ({ id: h.id, marketId: h.market.marketId, slug: h.market.slug, question: h.market.question, status: effectiveMarketStatus({ ...h.market, status: h.market.marketStatus }), outcome: h.outcome, available: h.available.toString(), reserved: h.reserved.toString(), total: (h.available + h.reserved).toString() })), h => h.id),
      openOrders: openOrders.map(orderView), orders: page(orderHistory.map(orderView), o => o.sequence),
      fills: page(executions.map(f => ({ id: f.id, sequence: f.sequence.toString(), slug: f.market.slug, question: f.market.question, side: f.side, outcome: f.outcome, price: f.price.toString(), quantity: f.quantity.toString(), total: (f.price * f.quantity).toString(), createdAt: f.createdAt.toISOString() })), f => f.sequence),
      activity,
      payouts: page(payouts.map(p => ({ ...p, sequence: p.sequence.toString(), quantity: p.quantity.toString(), amount: p.amount.toString(), createdAt: p.createdAt.toISOString() })), p => p.sequence),
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
