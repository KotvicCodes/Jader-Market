import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { digest, MemberError } from "../domain/identity";
import { effectiveMarketStatus, marketUuid } from "../domain/market-admin";
import { creditTicks, maxMarketOrders, maxOpenOrders, parseTrading, type Outcome, type TradingAction } from "../domain/trading";
import { memberDatabase, readSession, requireMember } from "./members";
import { fills, holdings, journals, ledgerAccounts, ledgerEntries, markets, orders, shareMovements, tradingOperations, tradingOutbox, users } from "./schema";
import { lockTransactions, type Transaction } from "./transaction-lock";

type Order = typeof orders.$inferSelect;
type Context = { id: string; ownerId: string | null; marketId: string };

async function account(tx: Transaction, ownerId: string | null, kind: "wallet" | "reserved" | "escrow", marketId?: string) {
  const [record] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, kind), ownerId ? eq(ledgerAccounts.ownerId, ownerId) : isNull(ledgerAccounts.ownerId), marketId ? eq(ledgerAccounts.marketId, marketId) : isNull(ledgerAccounts.marketId))).for("update");
  if (!record) throw new MemberError("configuration", 503);
  return record;
}

async function holding(tx: Transaction, ownerId: string, marketId: string, outcome: Outcome) {
  await tx.insert(holdings).values({ ownerId, marketId, outcome }).onConflictDoNothing();
  const [record] = await tx.select().from(holdings).where(and(eq(holdings.ownerId, ownerId), eq(holdings.marketId, marketId), eq(holdings.outcome, outcome))).for("update");
  return record;
}

async function transfer(tx: Transaction, ctx: Context, kind: string, recipientId: string, src: string, dst: string, amount: bigint, id = randomUUID()) {
  if (amount === 0n) return id;
  const accounts = await tx.select().from(ledgerAccounts).where(inArray(ledgerAccounts.id, [src, dst])).orderBy(asc(ledgerAccounts.id)).for("update");
  if (accounts.length !== 2) throw new MemberError("configuration", 503);
  if (accounts.find(a => a.id === src)!.balance < amount) throw new MemberError("insufficient_credits", 409);
  await tx.insert(journals).values({ id, operationKey: id, requestHash: digest(ctx.id), tradingOperationId: ctx.id, actorId: ctx.ownerId ?? recipientId, recipientId, kind, reason: "trading", amount });
  await tx.insert(ledgerEntries).values([{ journalId: id, accountId: src, delta: -amount }, { journalId: id, accountId: dst, delta: amount }]);
  return id;
}

async function move(tx: Transaction, ctx: Context, holdingId: string, kind: string, availableDelta: bigint, reservedDelta: bigint, groupId = randomUUID()) {
  await tx.insert(shareMovements).values({ operationId: ctx.id, holdingId, kind, availableDelta, reservedDelta, groupId });
}

function orderView(order: Order) {
  return { id: order.id, outcome: order.outcome, side: order.side, price: order.price.toString(), quantity: order.quantity.toString(), remaining: order.remaining.toString(), timeInForce: order.timeInForce, expiresAt: order.expiresAt?.toISOString() ?? null, status: order.status, reason: order.reason, sequence: order.sequence.toString() };
}

async function event(tx: Transaction, ctx: Context, eventName: string, ownerId: string | null, payload: Record<string, unknown> = {}) {
  await tx.insert(tradingOutbox).values({ operationId: ctx.id, marketId: ctx.marketId, ownerId, event: eventName, payload });
}

async function releaseOrder(tx: Transaction, ctx: Context, order: Order, status: "cancelled" | "expired", reason: string) {
  if (order.status !== "open") return;
  if (order.side === "buy") {
    const reserved = await account(tx, order.ownerId, "reserved");
    const wallet = await account(tx, order.ownerId, "wallet");
    await transfer(tx, ctx, "release", order.ownerId, reserved.id, wallet.id, order.price * order.remaining);
  } else {
    const stock = await holding(tx, order.ownerId, order.marketId, order.outcome);
    await move(tx, ctx, stock.id, "release", order.remaining, -order.remaining);
  }
  await tx.update(orders).set({ status, reason }).where(eq(orders.id, order.id));
  await event(tx, ctx, "order.changed", order.ownerId, { orderId: order.id });
}

async function finishOperation(tx: Transaction, ctx: Context, action: string, requestHash: string, response: Record<string, unknown>) {
  await event(tx, ctx, "market.changed", null);
  await tx.insert(tradingOperations).values({ ...ctx, action, requestHash, response });
}

async function cleanMarket(tx: Transaction, ctx: Context) {
  const stale = await tx.select({ order: orders, suspended: users.suspended, status: markets.status, closesAt: markets.closesAt })
    .from(orders).innerJoin(users, eq(users.id, orders.ownerId)).innerJoin(markets, eq(markets.id, orders.marketId))
    .where(and(eq(orders.marketId, ctx.marketId), eq(orders.status, "open"), or(eq(users.suspended, true), sql`${markets.status} <> 'open'`, sql`${markets.closesAt} <= clock_timestamp()`, sql`${orders.expiresAt} <= clock_timestamp()`)))
    .orderBy(asc(orders.sequence)).for("update", { of: orders });
  for (const record of stale) {
    const suspended = record.suspended;
    await releaseOrder(tx, ctx, record.order, suspended || record.status !== "open" ? "cancelled" : "expired", suspended ? "account_suspended" : record.status !== "open" || record.closesAt.getTime() <= Date.now() ? "market_closed" : "time_expired");
  }
  return stale.length;
}

export async function mutateTrading(token: string, action: TradingAction, input: Record<string, unknown>) {
  // Validate syntax before authentication, but check GTD time after replay lookup.
  const parsed = parseTrading(action, input, 0);
  return memberDatabase().db.transaction(async tx => {
    const member = await readSession(token, tx, true);
    requireMember(member);
    const ctx: Context = { id: parsed.operationKey, ownerId: member.user.id, marketId: parsed.marketId };
    const requestHash = digest(JSON.stringify([member.user.id, parsed], (_, value) => typeof value === "bigint" ? value.toString() : value));
    const [prior] = await tx.select().from(tradingOperations).where(eq(tradingOperations.id, ctx.id));
    if (prior) {
      if (prior.ownerId !== member.user.id || prior.requestHash !== requestHash) throw new MemberError("operation_conflict", 409);
      return prior.response;
    }
    const [market] = await tx.select().from(markets).where(eq(markets.id, ctx.marketId)).for("update");
    if (!market || market.status === "draft") throw new MemberError("market_missing", 404);
    if (parsed.action !== "cancel" && effectiveMarketStatus(market) !== "open") throw new MemberError("trading_closed", 409);
    await cleanMarket(tx, ctx);
    let response: Record<string, unknown>;
    if (parsed.action === "cancel") {
      const [order] = await tx.select().from(orders).where(and(eq(orders.id, parsed.orderId), eq(orders.marketId, ctx.marketId), eq(orders.ownerId, member.user.id))).for("update");
      if (!order) throw new MemberError("order_missing", 404);
      await releaseOrder(tx, ctx, order, "cancelled", "owner_cancelled");
      const [updated] = await tx.select().from(orders).where(eq(orders.id, order.id));
      response = { order: orderView(updated) };
    } else if (parsed.action === "mint" || parsed.action === "burn") {
      await tx.insert(ledgerAccounts).values({ kind: "escrow", marketId: market.id }).onConflictDoNothing();
      const wallet = await account(tx, member.user.id, "wallet");
      const escrow = await account(tx, null, "escrow", market.id);
      const yes = await holding(tx, member.user.id, market.id, "YES");
      const no = await holding(tx, member.user.id, market.id, "NO");
      if (parsed.action === "burn" && (yes.available < parsed.quantity || no.available < parsed.quantity)) throw new MemberError("insufficient_shares", 409);
      const mint = parsed.action === "mint";
      const journalId = await transfer(tx, ctx, parsed.action, member.user.id, mint ? wallet.id : escrow.id, mint ? escrow.id : wallet.id, parsed.quantity * creditTicks);
      for (const stock of [yes, no]) await move(tx, ctx, stock.id, parsed.action, mint ? parsed.quantity : -parsed.quantity, 0n, journalId);
      await event(tx, ctx, "portfolio.changed", member.user.id);
      response = { operationKey: ctx.id, action: parsed.action, quantity: parsed.quantity.toString() };
    } else {
      if (parsed.expiresAt && (parsed.expiresAt <= new Date() || parsed.expiresAt > market.closesAt)) throw new MemberError("invalid_order_expiry");
      const [{ count: own }] = await tx.select({ count: sql<number>`count(*)::integer` }).from(orders).where(and(eq(orders.ownerId, member.user.id), eq(orders.status, "open")));
      const [{ count: all }] = await tx.select({ count: sql<number>`count(*)::integer` }).from(orders).where(and(eq(orders.marketId, market.id), eq(orders.status, "open")));
      if (own >= maxOpenOrders || all >= maxMarketOrders) throw new MemberError("order_limit", 409);
      if (parsed.side === "buy") {
        const wallet = await account(tx, member.user.id, "wallet");
        const reserved = await account(tx, member.user.id, "reserved");
        await transfer(tx, ctx, "reserve", member.user.id, wallet.id, reserved.id, parsed.price * parsed.quantity);
      } else {
        const stock = await holding(tx, member.user.id, market.id, parsed.outcome);
        if (stock.available < parsed.quantity) throw new MemberError("insufficient_shares", 409);
        await move(tx, ctx, stock.id, "reserve", -parsed.quantity, parsed.quantity);
      }
      const [taker] = await tx.insert(orders).values({ id: ctx.id, operationId: ctx.id, ownerId: member.user.id, marketId: market.id, outcome: parsed.outcome, side: parsed.side, price: parsed.price, quantity: parsed.quantity, remaining: parsed.quantity, timeInForce: parsed.timeInForce, expiresAt: parsed.expiresAt }).returning();
      const candidates = await tx.select().from(orders).where(and(eq(orders.marketId, market.id), eq(orders.outcome, parsed.outcome), eq(orders.status, "open"), eq(orders.side, parsed.side === "buy" ? "sell" : "buy"), parsed.side === "buy" ? sql`${orders.price} <= ${parsed.price}` : sql`${orders.price} >= ${parsed.price}`))
        .orderBy(parsed.side === "buy" ? asc(orders.price) : desc(orders.price), asc(orders.sequence)).limit(maxMarketOrders).for("update");
      const executed: Record<string, unknown>[] = [];
      for (const maker of candidates) {
        if (taker.remaining === 0n) break;
        // Recheck time as matching runs; the deferred guards also check at commit.
        if (maker.expiresAt && maker.expiresAt.getTime() <= Date.now()) { await releaseOrder(tx, ctx, maker, "expired", "time_expired"); continue; }
        if (maker.ownerId === taker.ownerId) {
          await releaseOrder(tx, ctx, taker, "cancelled", "self_trade");
          taker.status = "cancelled"; taker.reason = "self_trade";
          break;
        }
        const quantity = maker.remaining < taker.remaining ? maker.remaining : taker.remaining;
        const buyer = taker.side === "buy" ? taker : maker;
        const seller = taker.side === "sell" ? taker : maker;
        const buyerReserved = await account(tx, buyer.ownerId, "reserved");
        const sellerWallet = await account(tx, seller.ownerId, "wallet");
        const sellerStock = await holding(tx, seller.ownerId, market.id, parsed.outcome);
        const buyerStock = await holding(tx, buyer.ownerId, market.id, parsed.outcome);
        const id = randomUUID();
        await tx.insert(fills).values({ id, operationId: ctx.id, marketId: market.id, buyOrderId: buyer.id, sellOrderId: seller.id, makerOrderId: maker.id, outcome: parsed.outcome, price: maker.price, quantity });
        await transfer(tx, ctx, "trade", seller.ownerId, buyerReserved.id, sellerWallet.id, maker.price * quantity, id);
        await move(tx, ctx, sellerStock.id, "trade", 0n, -quantity, id);
        await move(tx, ctx, buyerStock.id, "trade", quantity, 0n, id);
        const improvement = (buyer.price - maker.price) * quantity;
        if (improvement > 0n) {
          const buyerWallet = await account(tx, buyer.ownerId, "wallet");
          await transfer(tx, ctx, "release", buyer.ownerId, buyerReserved.id, buyerWallet.id, improvement);
        }
        maker.remaining -= quantity; taker.remaining -= quantity;
        maker.status = maker.remaining === 0n ? "filled" : "open";
        taker.status = taker.remaining === 0n ? "filled" : "open";
        await tx.update(orders).set({ remaining: maker.remaining, status: maker.status }).where(eq(orders.id, maker.id));
        await tx.update(orders).set({ remaining: taker.remaining, status: taker.status }).where(eq(orders.id, taker.id));
        const fill = { id, price: maker.price.toString(), quantity: quantity.toString(), outcome: parsed.outcome };
        executed.push(fill);
        await event(tx, ctx, "trade.executed", null, { price: fill.price, quantity: fill.quantity, outcome: fill.outcome });
        for (const order of [maker, taker]) await event(tx, ctx, "order.changed", order.ownerId, { orderId: order.id });
      }
      if (parsed.timeInForce === "IOC" && taker.status === "open") {
        await releaseOrder(tx, ctx, taker, "cancelled", "ioc_remainder");
        taker.status = "cancelled"; taker.reason = "ioc_remainder";
      }
      await event(tx, ctx, "order.changed", member.user.id, { orderId: taker.id });
      response = { order: orderView(taker), fills: executed };
    }
    await finishOperation(tx, ctx, parsed.action, requestHash, response);
    return response;
  });
}

// Called inside the same locked transaction as administrative close/suspension.
export async function cancelTradingOrders(tx: Transaction, filter: { marketId?: string; ownerId?: string }, reason: string) {
  const pending = await tx.select().from(orders).where(and(eq(orders.status, "open"), filter.marketId ? eq(orders.marketId, filter.marketId) : undefined, filter.ownerId ? eq(orders.ownerId, filter.ownerId) : undefined)).orderBy(asc(orders.sequence)).for("update");
  const contexts = new Map<string, Context>();
  for (const order of pending) {
    let ctx = contexts.get(order.marketId);
    if (!ctx) { ctx = { id: randomUUID(), ownerId: null, marketId: order.marketId }; contexts.set(order.marketId, ctx); }
    await releaseOrder(tx, ctx, order, "cancelled", reason);
  }
  for (const ctx of contexts.values()) await finishOperation(tx, ctx, "maintenance", digest(reason), { cancelled: true });
  return pending.length;
}

export async function expireTradingOrders() {
  return memberDatabase().db.transaction(async tx => {
    await lockTransactions(tx);
    const stale = await tx.selectDistinct({ marketId: orders.marketId }).from(orders).innerJoin(markets, eq(markets.id, orders.marketId)).innerJoin(users, eq(users.id, orders.ownerId)).where(and(eq(orders.status, "open"), or(eq(users.suspended, true), sql`${markets.status} <> 'open'`, sql`${markets.closesAt} <= clock_timestamp()`, sql`${orders.expiresAt} <= clock_timestamp()`))).orderBy(asc(orders.marketId)).limit(20);
    let expired = 0;
    for (const { marketId } of stale) {
      await tx.select({ id: markets.id }).from(markets).where(eq(markets.id, marketId)).for("update");
      const ctx: Context = { id: randomUUID(), ownerId: null, marketId };
      const count = await cleanMarket(tx, ctx);
      if (count) { expired += count; await finishOperation(tx, ctx, "maintenance", digest("expiry"), { expired: count }); }
    }
    return expired;
  });
}

export async function tradingSnapshot(token: string, inputMarketId: string, before?: string, beforeFill?: string) {
  const marketId = marketUuid(inputMarketId);
  const cursor = before === undefined ? undefined : integerCursor(before);
  const fillCursor = beforeFill === undefined ? undefined : integerCursor(beforeFill);
  return memberDatabase().db.transaction(async tx => {
    const session = await readSession(token, tx);
    requireMember(session);
    const [market] = await tx.select({ status: markets.status, paused: markets.paused, closesAt: markets.closesAt }).from(markets).where(eq(markets.id, marketId));
    if (!market || market.status === "draft") throw new MemberError("market_missing", 404);
    const balances = await tx.select({ kind: ledgerAccounts.kind, balance: ledgerAccounts.balance }).from(ledgerAccounts).where(eq(ledgerAccounts.ownerId, session.user.id));
    const stock = await tx.select({ outcome: holdings.outcome, available: holdings.available, reserved: holdings.reserved }).from(holdings).where(and(eq(holdings.ownerId, session.user.id), eq(holdings.marketId, marketId)));
    const history = await tx.select().from(orders).where(and(eq(orders.ownerId, session.user.id), eq(orders.marketId, marketId), cursor ? lt(orders.sequence, cursor) : undefined)).orderBy(desc(orders.sequence)).limit(51);
    const ownOrders = tx.select({ id: orders.id }).from(orders).where(eq(orders.ownerId, session.user.id));
    const executions = await tx.select({ sequence: fills.sequence, outcome: fills.outcome, price: fills.price, quantity: fills.quantity, createdAt: fills.createdAt,
      side: sql<string>`CASE WHEN ${fills.buyOrderId} IN (${ownOrders}) THEN 'buy' ELSE 'sell' END`,
      orderId: sql<string>`CASE WHEN ${fills.buyOrderId} IN (${ownOrders}) THEN ${fills.buyOrderId} ELSE ${fills.sellOrderId} END`,
    }).from(fills).where(and(eq(fills.marketId, marketId), or(inArray(fills.buyOrderId, ownOrders), inArray(fills.sellOrderId, ownOrders)), fillCursor ? lt(fills.sequence, fillCursor) : undefined)).orderBy(desc(fills.sequence)).limit(51);
    return { status: effectiveMarketStatus(market), availableCredits: (balances.find(a => a.kind === "wallet")?.balance ?? 0n).toString(), reservedCredits: (balances.find(a => a.kind === "reserved")?.balance ?? 0n).toString(), holdings: stock.map(h => ({ outcome: h.outcome, available: h.available.toString(), reserved: h.reserved.toString() })), orders: history.slice(0, 50).map(orderView), fills: executions.slice(0, 50).map(fill => ({ ...fill, sequence: fill.sequence.toString(), price: fill.price.toString(), quantity: fill.quantity.toString(), createdAt: fill.createdAt.toISOString() })), nextFillCursor: executions.length > 50 ? executions[49].sequence.toString() : null, nextCursor: history.length > 50 ? history[49].sequence.toString() : null };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

function integerCursor(input: string) {
  if (!/^[1-9][0-9]{0,18}$/.test(input) || BigInt(input) > 9_223_372_036_854_775_807n) throw new MemberError("invalid_request");
  return BigInt(input);
}

export async function publicTradingSnapshot(inputMarketId: string, before?: string) {
  const marketId = marketUuid(inputMarketId);
  const cursor = before === undefined ? undefined : integerCursor(before);
  return memberDatabase().db.transaction(async tx => {
    const [market] = await tx.select({ status: markets.status, paused: markets.paused, closesAt: markets.closesAt }).from(markets).where(eq(markets.id, marketId));
    if (!market || market.status === "draft") throw new MemberError("market_missing", 404);
    const status = effectiveMarketStatus(market);
    const book = status === "closed" ? [] : await tx.select({ outcome: orders.outcome, side: orders.side, price: orders.price, quantity: sql<string>`sum(${orders.remaining})::text` }).from(orders).innerJoin(users, eq(users.id, orders.ownerId)).where(and(eq(orders.marketId, marketId), eq(orders.status, "open"), eq(users.suspended, false), or(isNull(orders.expiresAt), gt(orders.expiresAt, new Date())))).groupBy(orders.outcome, orders.side, orders.price).orderBy(asc(orders.outcome), asc(orders.side), sql`CASE WHEN ${orders.side} = 'buy' THEN -${orders.price} ELSE ${orders.price} END`);
    const history = await tx.select({ outcome: fills.outcome, price: fills.price, quantity: fills.quantity, sequence: fills.sequence, createdAt: fills.createdAt }).from(fills).where(and(eq(fills.marketId, marketId), cursor ? lt(fills.sequence, cursor) : undefined)).orderBy(desc(fills.sequence)).limit(51);
    return { status, executable: status === "open", book: book.map(level => ({ ...level, price: level.price.toString() })), trades: history.slice(0, 50).map(fill => ({ ...fill, price: fill.price.toString(), quantity: fill.quantity.toString(), sequence: fill.sequence.toString(), createdAt: fill.createdAt.toISOString() })), nextCursor: history.length > 50 ? history[49].sequence.toString() : null };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
