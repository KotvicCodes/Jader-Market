import Link from "next/link";
import { notFound } from "next/navigation";
import { findPublicMarket } from "../../../db/markets";
import { effectiveMarketStatus } from "../../../domain/market-admin";
import { publicTradingSnapshot } from "../../../db/trading";
import { formatCredits } from "../../../domain/identity";

export const dynamic = "force-dynamic";

export default async function MarketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await findPublicMarket(slug);
  if (result.state === "missing") notFound();
  if (result.state !== "ready") return <div className="empty"><h1>Market temporarily unavailable</h1><p>Please try again later.</p><Link href="/">Back to markets</Link></div>;
  const { market } = result;
  let trading;
  try { trading = await publicTradingSnapshot(market.id); } catch {}
  const status = trading?.status ?? effectiveMarketStatus(market);
  return <>
    <Link href="/" className="back">← Markets</Link><div className="page-heading"><div><p className="eyebrow">{market.category}</p><h1>{market.question}</h1></div><span className="badge">{status}</span></div>
    {market.synthetic === "yes" && <div className="notice">Synthetic example for testing only. This is not a live prediction or an invitation to trade.</div>}
    {status === "paused" && <div className="notice">The administrator has paused this market. Published terms remain locked.</div>}
    {status === "closed" && <div className="notice">This market is closed. It is awaiting resolution by the administrator.</div>}
    <div className="detail-grid"><div className="stack">
      <section className="panel"><h2>About this market</h2><p className="market-text">{market.description}</p><dl className="metadata"><div><dt>Closing time</dt><dd>{market.closesAt.toISOString().replace("T", " ").replace(".000Z", " UTC")}</dd></div><div><dt>Oracle</dt><dd>Community administrator</dd></div></dl><p className="muted">These published terms are fixed. The deadline and resolution rules cannot be changed.</p></section>
      <section className="panel"><h2>Resolution rules</h2><p className="market-text">{market.resolutionRules}</p><h3>Source</h3><p className="muted market-text">{market.resolutionSource}</p></section>
      <section className="panel"><h2>Order book</h2>{!trading ? <p className="muted">Order book temporarily unavailable.</p> : trading.book.length ? <><p className="muted">{trading.executable ? "Recorded limit orders. Depth can change before a trade executes." : "Trading is unavailable. Any resting depth shown cannot currently execute."}</p><div className="table-wrap"><table><thead><tr><th>Outcome</th><th>Side</th><th>Price (credits)</th><th>Shares</th></tr></thead><tbody>{trading.book.map(level => <tr key={`${level.outcome}:${level.side}:${level.price}`}><td>{level.outcome}</td><td>{level.side === "buy" ? "Bid" : "Ask"}</td><td>{formatCredits(BigInt(level.price))}</td><td>{level.quantity}</td></tr>)}</tbody></table></div></> : <p className="muted">{market.synthetic === "yes" ? "This fictional browsing example does not accept persistent trades." : trading.executable ? "No resting orders. An executable quote is unavailable." : "Trading is unavailable for this market."}</p>}</section>
    </div><aside className="panel"><h2>Trade outcomes</h2><p className="muted">{market.synthetic === "yes" ? "This example cannot spend your persistent credits. Use the separate practice markets to try trading." : "On-page trading controls are coming next. The order book reflects persistent trading activity."}</p><button disabled>{market.synthetic === "yes" ? "Browsing example only" : "Trading interface coming next"}</button>{market.synthetic === "yes" && <p className="demo-hint"><Link href="/demo">Open practice markets →</Link></p>}</aside></div>
  </>;
}
