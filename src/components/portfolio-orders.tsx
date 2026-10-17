"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { portfolioSnapshot } from "../db/portfolio";
import { OpenOrderList } from "./open-order-list";
import { TradingRequestFeedback, useTradingRequest } from "./trading-request";

type Orders = Awaited<ReturnType<typeof portfolioSnapshot>>["openOrders"];
export function PortfolioRefresh() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <button type="button" className="secondary-button" disabled={pending} onClick={() => start(() => router.refresh())}>{pending ? "Refreshing…" : "Refresh portfolio"}</button>;
}

function MarketOrders({ orders, ownerId, csrf }: { orders: Orders; ownerId: string; csrf: string }) {
  const market = orders[0];
  const controller = useTradingRequest(ownerId, market.marketId, csrf);
  return <article className="portfolio-market">
    <h3><Link href={`/markets/${market.slug}`}>{market.question}</Link></h3><p className="muted">Market: {market.marketStatus}. Unfilled orders can still be cancelled while trading is paused or closed.</p>
    <TradingRequestFeedback controller={controller} />
    <OpenOrderList orders={orders} marketId={market.marketId} controller={controller} />
  </article>;
}

export function PortfolioOrders({ orders, ownerId, csrf }: { orders: Orders; ownerId: string; csrf: string }) {
  const groups = new Map<string, Orders>();
  for (const order of orders) {
    const group = groups.get(order.marketId) ?? [];
    group.push(order);
    groups.set(order.marketId, group);
  }
  return <div className="stack">{Array.from(groups, ([marketId, group]) => <MarketOrders key={`${ownerId}:${marketId}`} orders={group} ownerId={ownerId} csrf={csrf} />)}</div>;
}
