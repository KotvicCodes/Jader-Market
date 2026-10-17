"use client";

import Link from "next/link";
import { useMemo, useSyncExternalStore } from "react";
import type { portfolioSnapshot } from "../db/portfolio";
import { OpenOrderList } from "./open-order-list";
import { TradingRequestFeedback, useTradingRequest } from "./trading-request";
import { pendingTradingMarkets } from "./pending-trading";

type Orders = Awaited<ReturnType<typeof portfolioSnapshot>>["openOrders"];
function MarketOrders({ marketId, orders, ownerId, csrf }: { marketId: string; orders: Orders; ownerId: string; csrf: string }) {
  const market = orders[0];
  const controller = useTradingRequest(ownerId, marketId, csrf, JSON.stringify(orders));
  return <article className="portfolio-market">
    {market ? <><h3><Link href={`/markets/${market.slug}`}>{market.question}</Link></h3><p className="muted">Market: {market.marketStatus}. Unfilled orders can still be cancelled while trading is paused or closed.</p></> : <><h3>Saved request</h3><p className="muted">Market reference: <code className="request-reference">{marketId}</code>. Its open orders have finished or are outside this snapshot. Recover the exact saved request below.</p></>}
    <TradingRequestFeedback controller={controller} />
    <OpenOrderList orders={orders} marketId={marketId} controller={controller} />
  </article>;
}

export function PortfolioOrders({ orders, ownerId, csrf }: { orders: Orders; ownerId: string; csrf: string }) {
  const registry = useMemo(() => pendingTradingMarkets(ownerId), [ownerId]);
  const stored = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getServerSnapshot);
  const groups = new Map<string, Orders>();
  for (const order of orders) {
    const group = groups.get(order.marketId) ?? [];
    group.push(order);
    groups.set(order.marketId, group);
  }
  if (stored !== "unavailable") for (const id of JSON.parse(stored) as string[]) if (!groups.has(id)) groups.set(id, []);
  return <div className="stack">{stored === "unavailable" && <p role="alert" className="error">Saved requests could not be listed. Keep this browser&apos;s data and ask the operator to reconcile any unconfirmed operation.</p>}{!groups.size && <p className="muted">No open orders or saved requests.</p>}{Array.from(groups, ([marketId, group]) => <MarketOrders key={`${ownerId}:${marketId}`} marketId={marketId} orders={group} ownerId={ownerId} csrf={csrf} />)}</div>;
}
