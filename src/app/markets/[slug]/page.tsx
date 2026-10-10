import Link from "next/link";
import { notFound } from "next/navigation";
import { findPublicMarket } from "../../../db/markets";
import { effectiveMarketStatus } from "../../../domain/market-admin";

export const dynamic = "force-dynamic";

export default async function MarketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await findPublicMarket(slug);
  if (result.state === "missing") notFound();
  if (result.state !== "ready") return <div className="empty"><h1>Market temporarily unavailable</h1><p>Please try again later.</p><Link href="/">Back to markets</Link></div>;
  const { market } = result;
  const status = effectiveMarketStatus(market);
  return <>
    <Link href="/" className="back">← Markets</Link><div className="page-heading"><div><p className="eyebrow">{market.category}</p><h1>{market.question}</h1></div><span className="badge">{status}</span></div>
    {market.synthetic === "yes" && <div className="notice">Synthetic example for testing only. This is not a live prediction or an invitation to trade.</div>}
    {status === "paused" && <div className="notice">The administrator has paused this market. Published terms remain locked.</div>}
    {status === "closed" && <div className="notice">This market is closed. It is awaiting resolution by the administrator.</div>}
    <div className="detail-grid"><div className="stack"><section className="panel"><h2>About this market</h2><p className="market-text">{market.description}</p><dl className="metadata"><div><dt>Closing time</dt><dd>{market.closesAt.toISOString().replace("T", " ").replace(".000Z", " UTC")}</dd></div><div><dt>Oracle</dt><dd>Community administrator</dd></div></dl><p className="muted">These published terms are fixed. The deadline and resolution rules cannot be changed.</p></section><section className="panel"><h2>Resolution rules</h2><p className="market-text">{market.resolutionRules}</p><h3>Source</h3><p className="muted market-text">{market.resolutionSource}</p></section><section className="panel"><h2>Order book</h2><p className="muted">No executable orders. The trading engine will be connected next.</p></section></div><aside className="panel"><h2>Trade outcomes</h2><div className="quote-row"><span className="quote yes">YES <span>No quote</span></span><span className="quote no">NO <span>No quote</span></span></div><p className="muted" style={{ marginTop: 20 }}>Accounts and credits are available. Community trading and oracle payouts will follow in later releases.</p><button disabled>Trading not enabled</button></aside></div>
  </>;
}
