"use client";

import type { tradingSnapshot } from "../db/trading";
import { formatCredits } from "../domain/trading-values";
import type { TradingController } from "./trading-request";

type Orders = Awaited<ReturnType<typeof tradingSnapshot>>["openOrders"];
export function OpenOrderList({ marketId, orders, controller }: { marketId: string; orders: Orders; controller: TradingController }) {
  if (!orders.length) return <p className="muted">No open orders in this market.</p>;
  return <div className="stack">{orders.map(order => <article className="open-order" key={order.id}>
    <h3>{order.side === "buy" ? "Buy" : "Sell"} {order.outcome} · {formatCredits(BigInt(order.price))} credits</h3><p>{(BigInt(order.quantity) - BigInt(order.remaining)).toString()} of {order.quantity} shares filled; {order.remaining} remain open.</p>
    <p className="muted">Reserved: {order.side === "buy" ? `${formatCredits(BigInt(order.price) * BigInt(order.remaining))} credits` : `${order.remaining} ${order.outcome} shares`}.{order.expiresAt && ` Expires ${order.expiresAt.slice(0, 19).replace("T", " ")} UTC.`}</p>
    <p className="muted">Order reference: <code className="request-reference">{order.id}</code></p>
    <button type="button" className="secondary-button" disabled={controller.locked} onClick={() => { controller.setMessage(null); controller.setReview({ action: "cancel", body: { marketId, operationKey: crypto.randomUUID(), orderId: order.id } }); }}>Cancel remaining {order.remaining} shares</button>
  </article>)}</div>;
}
