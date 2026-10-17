"use client";

import Link from "next/link";
import { useCallback } from "react";
import type { MarketSnapshot } from "../db/market-snapshot";
import { payoutPolicy } from "../domain/market-admin";
import { formatCredits } from "../domain/trading-values";
import { MarketTrading } from "./market-trading";
import { fetchSnapshot, SnapshotRefreshContext, SnapshotStatus, useLiveSnapshot } from "./live-snapshot";
import { readMarketSnapshot } from "./snapshot-data";

type Details = { id: string; category: string; question: string; description: string; closesAt: string; synthetic: string; resolutionRules: string; resolutionSource: string };
export function MarketLive({ market, initial, ownerId, loadedAt }: { market: Details; initial: MarketSnapshot | null; ownerId: string | null; loadedAt: string }) {
  const load = useCallback((signal: AbortSignal) => fetchSnapshot(`/api/markets/${market.id}/snapshot`, signal, value => readMarketSnapshot(value, ownerId)), [market.id, ownerId]);
  const live = useLiveSnapshot<MarketSnapshot | null>(initial, loadedAt, load);
  const trading = live.data?.trading;
  const resolution = live.data?.resolution;
  const account = live.phase === "session" ? null : live.data?.account;
  const portfolio = account?.portfolio;
  const accountUnavailable = !live.data || live.phase === "session";
  const status = trading?.status ?? "unavailable";
  return <SnapshotRefreshContext.Provider value={live}>
    <SnapshotStatus live={live} label="market" />
    <Link href="/" className="back">← Markets</Link><div className="page-heading"><div><p className="eyebrow">{market.category}</p><h1>{market.question}</h1></div><span className="badge">{status}</span></div>
    {market.synthetic === "yes" && <div className="notice">Synthetic example for testing only. This is not a live prediction or an invitation to trade.</div>}
    {status === "paused" && <div className="notice">The administrator has paused this market. Published terms remain locked.</div>}
    {status === "closed" && <div className="notice">This market is closed. It is awaiting resolution by the administrator.</div>}
    {resolution && <section className="panel"><h2>Final result: {resolution.result}</h2><p className="market-text">{resolution.evidence}</p><p className="muted">Recorded {resolution.createdAt.replace("T", " ").replace(".000Z", " UTC")}. {status === "settling" ? "Collateral payouts are in progress." : "Payouts complete. Private receipts are available in your portfolio."}</p></section>}
    <div className="detail-grid"><div className="stack">
      <section className="panel"><h2>About this market</h2><p className="market-text">{market.description}</p><dl className="metadata"><div><dt>Closing time</dt><dd>{market.closesAt.replace("T", " ").replace(".000Z", " UTC")}</dd></div><div><dt>Oracle</dt><dd>Community administrator</dd></div></dl><p className="muted">These published terms are fixed. The deadline and resolution rules cannot be changed.</p></section>
      <section className="panel"><h2>Resolution rules</h2><p className="notice">{payoutPolicy}</p><p className="market-text">{market.resolutionRules}</p><h3>Source</h3><p className="muted market-text">{market.resolutionSource}</p></section>
      <section className="panel"><h2>Order book</h2>{!trading ? <p className="muted">Order book temporarily unavailable.</p> : trading.book.length ? <><p className="muted">{trading.executable ? "Recorded limit orders. Depth can change before a trade executes." : "Trading is unavailable. Any resting depth shown cannot currently execute."}</p><div className="table-wrap"><table><thead><tr><th>Outcome</th><th>Side</th><th>Price (credits)</th><th>Shares</th></tr></thead><tbody>{trading.book.map(level => <tr key={`${level.outcome}:${level.side}:${level.price}`}><td>{level.outcome}</td><td>{level.side === "buy" ? "Bid" : "Ask"}</td><td>{formatCredits(BigInt(level.price))}</td><td>{level.quantity}</td></tr>)}</tbody></table></div></> : <p className="muted">{market.synthetic === "yes" ? "This fictional browsing example does not accept persistent trades." : trading.executable ? "No resting orders. An executable quote is unavailable." : "Trading is unavailable for this market."}</p>}</section>
    </div><aside className="market-trading-sidebar">{accountUnavailable ? <section className="panel"><h2>Trading temporarily unavailable</h2><p>Please refresh or sign in again. Your balances could not be loaded safely.</p></section> : account && portfolio ? <MarketTrading key={`${account.ownerId}:${market.id}`} marketId={market.id} ownerId={account.ownerId} csrf={account.csrf} closesAt={market.closesAt} synthetic={market.synthetic === "yes"} snapshot={portfolio} quoteKey={JSON.stringify(trading?.book)} /> : <section className="panel"><h2>Trade outcomes</h2>{market.synthetic === "yes" ? <><p className="notice">Browsing example only. This example cannot spend persistent credits.</p><Link href="/demo">Open practice markets →</Link></> : <><p className="muted">Sign in to buy or sell owned outcome shares, mint or burn complete sets, and manage your orders.</p><Link className="button" href="/account">Sign in to trade</Link></>}</section>}</aside></div>
  </SnapshotRefreshContext.Provider>;
}
