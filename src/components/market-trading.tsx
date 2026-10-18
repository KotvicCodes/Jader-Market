"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { tradingSnapshot } from "../db/trading";
import type { TradingAction } from "../domain/trading";
import { ticketRequest, tradingRejections } from "../domain/trading-ticket";
import { creditTicks, formatCredits, maxQuantity } from "../domain/trading-values";
import { TradingRequestFeedback, useTradingRequest } from "./trading-request";
import { OpenOrderList } from "./open-order-list";

type Snapshot = Awaited<ReturnType<typeof tradingSnapshot>>;

export function MarketTrading({ marketId, ownerId, csrf, closesAt, synthetic, snapshot, quoteKey = "" }: {
  marketId: string; ownerId: string; csrf: string; closesAt: string; synthetic: boolean; snapshot: Snapshot; quoteKey?: string;
}) {
  const [action, setAction] = useState<Exclude<TradingAction, "cancel">>(synthetic ? "burn" : "place");
  const [duration, setDuration] = useState("GTC");
  const [deadlinePassed, setDeadlinePassed] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      const remaining = Date.parse(closesAt) - Date.now();
      if (remaining <= 0) setDeadlinePassed(true);
      else timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    }
    check();
    return () => clearTimeout(timer);
  }, [closesAt]);
  const status = deadlinePassed && ["open", "paused"].includes(snapshot.status) ? "closed" : snapshot.status;
  const controller = useTradingRequest(ownerId, marketId, csrf, JSON.stringify({ ...snapshot, status, quoteKey }));
  const { locked, busy, refreshing, review, refresh, setReview, setMessage } = controller;
  const open = status === "open";
  const stock = (outcome: string) => snapshot.holdings.find(h => h.outcome === outcome) ?? { available: "0", reserved: "0" };
  const yes = BigInt(stock("YES").available);
  const no = BigInt(stock("NO").available);
  const pairs = yes < no ? yes : no;
  const canUseTicket = open && (!synthetic || pairs > 0n);

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || !canUseTicket) return;
    try {
      const fields = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
      const request = ticketRequest(marketId, crypto.randomUUID(), fields, closesAt);
      if (request.action === "mint" && BigInt(request.body.quantity) * creditTicks > BigInt(snapshot.availableCredits)) throw new Error(tradingRejections.insufficient_credits);
      if (request.action === "burn" && BigInt(request.body.quantity) > pairs) throw new Error(tradingRejections.insufficient_shares);
      if (request.action === "place") {
        if (request.body.side === "buy" && BigInt(request.body.quantity) * BigInt(request.body.price) > BigInt(snapshot.availableCredits)) throw new Error(tradingRejections.insufficient_credits);
        if (request.body.side === "sell" && BigInt(request.body.quantity) > BigInt(stock(request.body.outcome).available)) throw new Error(tradingRejections.insufficient_shares);
      }
      setMessage(null);
      setReview(request);
    } catch (error) { setMessage({ text: error instanceof Error ? error.message : "Check your trading details.", error: true }); }
  }

  return <div className="stack market-trading">
    <section className="panel" aria-labelledby="trade-heading"><h2 id="trade-heading">Trade outcomes</h2>
      <p className="muted">Your real account credits and shares are used here. The practice demo has a separate balance.</p>
      <dl className="demo-summary"><div><dt>Available credits</dt><dd>{formatCredits(BigInt(snapshot.availableCredits))}</dd></div><div><dt>Reserved credits, all markets and withdrawals</dt><dd>{formatCredits(BigInt(snapshot.reservedCredits))}</dd></div></dl>
      <p className="demo-hint muted">Balances and orders update automatically in active tabs. Check the live update status before trading; limit prices remain binding when depth changes.</p>
      <button type="button" className="secondary-button" disabled={busy || refreshing || Boolean(review)} onClick={refresh}>{refreshing ? "Refreshing…" : "Refresh trading state"}</button>
      {synthetic && <p className="notice">Browsing example only. New orders and minting are disabled. Available legacy pairs can still be burned while open.</p>}
      {!open && <p className="notice">{status === "paused" ? "Trading is paused. You can still cancel open orders." : `This market is ${status}. New trades and complete-set operations are unavailable; any remaining open orders can be cancelled.`}</p>}
      {canUseTicket && <form className="member-form" aria-label="Trading ticket" onSubmit={prepare}>
        <fieldset disabled={locked}>
          <label>Operation<select name="action" value={action} onChange={event => setAction(event.target.value as typeof action)}>
            <option value="place" disabled={synthetic}>Buy or sell shares</option><option value="mint" disabled={synthetic}>Mint complete sets</option><option value="burn">Burn complete sets</option>
          </select></label>
          {action === "place" ? <>
            <div className="trading-fields"><label>Side<select name="side"><option value="buy">Buy</option><option value="sell">Sell owned shares</option></select></label><label>Outcome<select name="outcome"><option value="YES">YES</option><option value="NO">NO</option></select></label></div>
            <label>Limit price in credits per share<input name="price" type="text" inputMode="decimal" placeholder="0.2500" required maxLength={6} /><span>0.0001 to 0.9999. Maximum for buys; minimum for sells.</span></label>
          </> : <p className="muted">{action === "mint" ? "One credit mints a complete set: one YES and one NO share backed by collateral. Minting does not buy from the order book." : `Burn one available YES and one available NO share to return one credit. Available complete sets: ${pairs}.`}</p>}
          <label>{action === "place" ? "Number of shares" : "Number of complete sets"}<input name="quantity" type="number" min="1" max={maxQuantity.toString()} step="1" required /></label>
          {action === "place" && <>
            <label>Order duration<select name="timeInForce" value={duration} onChange={event => setDuration(event.target.value)}><option value="GTC">Until cancelled or market closes</option><option value="GTD">Until a UTC time</option><option value="IOC">Immediate or cancel</option></select></label>
            {duration === "GTD" && <label>Expiry (UTC)<input name="expiresAt" type="datetime-local" max={closesAt.slice(0, 16)} required /><span>Enter UTC, regardless of your device&apos;s time zone.</span></label>}
          </>}
          <button type="submit">Review {action === "place" ? "order" : action === "mint" ? "mint" : "burn"}</button>
        </fieldset>
      </form>}
      <TradingRequestFeedback controller={controller} />
    </section>
    <section className="panel"><h2>Your shares in this market</h2><div className="table-wrap" role="region" aria-label="Your shares in this market" tabIndex={0}><table><caption className="muted">Reserved shares back your open sell orders.</caption><thead><tr><th>Outcome</th><th>Available</th><th>Reserved</th></tr></thead><tbody>{["YES", "NO"].map(outcome => <tr key={outcome}><th scope="row">{outcome}</th><td>{stock(outcome).available}</td><td>{stock(outcome).reserved}</td></tr>)}</tbody></table></div><p className="demo-hint"><Link href="/portfolio">Credit history and payout receipts →</Link></p></section>
    <section className="panel"><h2>Your open orders</h2><OpenOrderList marketId={marketId} orders={snapshot.openOrders} controller={controller} /></section>
    <section className="panel"><h2>Your recent fills</h2><p className="muted">Latest {snapshot.fills.length} fills in this market. Completed fills are final.</p>{!snapshot.fills.length ? <p className="muted">No fills yet.</p> : <div className="table-wrap" role="region" aria-label="Your recent fills" tabIndex={0}><table><thead><tr><th>Side</th><th>Outcome</th><th>Shares</th><th>Price (credits)</th><th>UTC time</th></tr></thead><tbody>{snapshot.fills.map(fill => <tr key={fill.sequence}><td>{fill.side === "buy" ? "Buy" : "Sell"}</td><td>{fill.outcome}</td><td>{fill.quantity}</td><td>{formatCredits(BigInt(fill.price))}</td><td>{fill.createdAt.slice(0, 19).replace("T", " ")}</td></tr>)}</tbody></table></div>}</section>
  </div>;
}
