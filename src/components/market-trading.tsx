"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { tradingSnapshot } from "../db/trading";
import type { TradingAction } from "../domain/trading";
import { requestSummary, ticketRequest, tradingRejections, tradingResult, type TradingRequest } from "../domain/trading-ticket";
import { creditTicks, formatCredits, maxQuantity } from "../domain/trading-values";
import { pendingTradingStore } from "./pending-trading";

type Snapshot = Awaited<ReturnType<typeof tradingSnapshot>>;

export function MarketTrading({ marketId, ownerId, csrf, closesAt, synthetic, snapshot }: {
  marketId: string; ownerId: string; csrf: string; closesAt: string; synthetic: boolean; snapshot: Snapshot;
}) {
  const router = useRouter();
  const store = useMemo(() => pendingTradingStore(ownerId, marketId), [ownerId, marketId]);
  const saved = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const [action, setAction] = useState<Exclude<TradingAction, "cancel">>(synthetic ? "burn" : "place");
  const [duration, setDuration] = useState("GTC");
  const [review, setReview] = useState<TradingRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [refreshing, startRefresh] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
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
  const open = status === "open";
  const locked = !saved.ready || saved.error || Boolean(saved.request) || busy || refreshing || Boolean(review);
  const stock = (outcome: string) => snapshot.holdings.find(h => h.outcome === outcome) ?? { available: "0", reserved: "0" };
  const yes = BigInt(stock("YES").available);
  const no = BigInt(stock("NO").available);
  const pairs = yes < no ? yes : no;
  const canUseTicket = open && (!synthetic || pairs > 0n);

  function refresh() { startRefresh(() => router.refresh()); }
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

  async function send(request: TradingRequest) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let persisted = false;
    try {
      // Persist before sending. A blocked storage write must not submit a trade.
      store.save(request);
      persisted = true;
      setReview(null);
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(`/api/trading/${request.action}`, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify(request.body),
      });
      const data: Record<string, unknown> = await response.json();
      if (!response.ok) {
        const code = typeof data.error === "string" ? data.error : "unavailable";
        if (response.status >= 400 && response.status < 500 && Object.hasOwn(tradingRejections, code)) {
          store.clear(request);
          setMessage({ text: tradingRejections[code], error: true });
          refresh();
          return;
        }
        const explanation = code === "unauthenticated" ? "Your session ended. Sign in, return here and retry this same request."
          : code === "invalid_csrf" ? "Refresh this page to renew your session details, then retry this same request."
          : code === "rate_limited" ? "Too many requests. Wait a minute, then retry this same request."
          : code === "operation_conflict" ? "This reference conflicts with a saved operation. Ask the operator to reconcile it before continuing."
          : "The server could not confirm the result. Retry this same request to recover its saved result.";
        setMessage({ text: explanation, error: true });
        return;
      }
      const text = tradingResult(request, data);
      store.clear(request);
      setMessage({ text, error: false });
      refresh();
    } catch {
      setMessage({ text: persisted ? "The result is unconfirmed. Keep its reference and retry the same request. New actions stay blocked until it is confirmed." : "The request was not sent. Browser session storage must be available to save its recovery reference. Enable it, then confirm again.", error: true });
    } finally {
      clearTimeout(timer);
      sending.current = false;
      setBusy(false);
    }
  }

  return <div className="stack market-trading">
    <section className="panel" aria-labelledby="trade-heading"><h2 id="trade-heading">Trade outcomes</h2>
      <p className="muted">Your real account credits and shares are used here. The practice demo has a separate balance.</p>
      <dl className="demo-summary"><div><dt>Available credits</dt><dd>{formatCredits(BigInt(snapshot.availableCredits))}</dd></div><div><dt>Reserved credits, all markets and withdrawals</dt><dd>{formatCredits(BigInt(snapshot.reservedCredits))}</dd></div></dl>
      <p className="demo-hint muted">Balances and orders update after your actions. Use Refresh market to see other participants&apos; changes.</p>
      <button type="button" className="secondary-button" disabled={busy || refreshing || Boolean(review)} onClick={refresh}>{refreshing ? "Refreshing…" : "Refresh market"}</button>
      {synthetic && <p className="notice">Browsing example only. New orders and minting are disabled. Available legacy pairs can still be burned while open.</p>}
      {!open && <p className="notice">{status === "paused" ? "Trading is paused. You can still cancel open orders." : `This market is ${status}. New trades and complete-set operations are unavailable; any remaining open orders can be cancelled.`}</p>}
      {saved.error && <p role="alert" className="error">The browser could not read the saved request. New actions are blocked to avoid repeating a trade. Keep this browser&apos;s data and ask the operator to reconcile any unconfirmed request; do not clear storage to retry.</p>}
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
      {review && <section className="notice trading-review" aria-label="Review trading request" tabIndex={-1} ref={node => node?.focus()}>
        <h3>Review before confirming</h3>{requestSummary(review).map(line => <p key={line}>{line}</p>)}
        <div className="trading-actions"><button type="button" disabled={busy} onClick={() => void send(review)}>Confirm {review.action === "place" ? "order" : review.action === "cancel" ? "cancellation" : review.action}</button><button type="button" className="secondary-button" disabled={busy} onClick={() => setReview(null)}>Back to editing</button></div>
      </section>}
      {saved.request && <section className="notice" aria-label="Unconfirmed trading request"><h3>{busy ? "Submitting request…" : "Confirm an earlier request"}</h3>
        {requestSummary(saved.request).map(line => <p key={line}>{line}</p>)}<p>Request reference: <code className="request-reference">{saved.request.body.operationKey}</code></p>
        <p>Retrying uses the exact same details and reference. A completed operation will return its saved result without spending again.</p>
        <button type="button" disabled={busy || refreshing} onClick={() => void send(saved.request!)}>{busy ? "Waiting for confirmation…" : "Retry same request"}</button><p className="demo-hint"><Link href="/account">Sign in or check your account →</Link></p>
      </section>}
      {message && <p role={message.error ? "alert" : "status"} className={message.error ? "error" : "success"}>{message.text}</p>}
      <noscript><p className="notice">Enable JavaScript to review and submit trading requests.</p></noscript>
    </section>
    <section className="panel"><h2>Your shares in this market</h2><div className="table-wrap"><table><caption className="muted">Reserved shares back your open sell orders.</caption><thead><tr><th>Outcome</th><th>Available</th><th>Reserved</th></tr></thead><tbody>{["YES", "NO"].map(outcome => <tr key={outcome}><th scope="row">{outcome}</th><td>{stock(outcome).available}</td><td>{stock(outcome).reserved}</td></tr>)}</tbody></table></div><p className="demo-hint"><Link href="/portfolio">Credit history and payout receipts →</Link></p></section>
    <section className="panel"><h2>Your open orders</h2>{!snapshot.openOrders.length ? <p className="muted">No open orders in this market.</p> : <div className="stack">{snapshot.openOrders.map(order => <article className="open-order" key={order.id}>
      <h3>{order.side === "buy" ? "Buy" : "Sell"} {order.outcome} · {formatCredits(BigInt(order.price))} credits</h3><p>{(BigInt(order.quantity) - BigInt(order.remaining)).toString()} of {order.quantity} shares filled; {order.remaining} remain open.</p>
      <p className="muted">Reserved: {order.side === "buy" ? `${formatCredits(BigInt(order.price) * BigInt(order.remaining))} credits` : `${order.remaining} ${order.outcome} shares`}.{order.expiresAt && ` Expires ${order.expiresAt.slice(0, 19).replace("T", " ")} UTC.`}</p>
      <p className="muted">Order reference: <code className="request-reference">{order.id}</code></p>
      <button type="button" className="secondary-button" disabled={locked} onClick={() => { setMessage(null); setReview({ action: "cancel", body: { marketId, operationKey: crypto.randomUUID(), orderId: order.id } }); }}>Cancel remaining {order.remaining} shares</button>
    </article>)}</div>}</section>
    <section className="panel"><h2>Your recent fills</h2><p className="muted">Latest {snapshot.fills.length} fills in this market. Completed fills are final.</p>{!snapshot.fills.length ? <p className="muted">No fills yet.</p> : <div className="table-wrap"><table><thead><tr><th>Side</th><th>Outcome</th><th>Shares</th><th>Price (credits)</th><th>UTC time</th></tr></thead><tbody>{snapshot.fills.map(fill => <tr key={fill.sequence}><td>{fill.side === "buy" ? "Buy" : "Sell"}</td><td>{fill.outcome}</td><td>{fill.quantity}</td><td>{formatCredits(BigInt(fill.price))}</td><td>{fill.createdAt.slice(0, 19).replace("T", " ")}</td></tr>)}</tbody></table></div>}</section>
  </div>;
}
