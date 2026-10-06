import Link from "next/link";
import { demoMarkets } from "../../domain/demo";
import { parseMarketQuery } from "../../domain/market-query";

export default async function DemoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = parseMarketQuery({ q: typeof params.q === "string" ? params.q : undefined, category: typeof params.category === "string" ? params.category : undefined });
  const items = demoMarkets.filter(market => (query.category === "all" || market.category === query.category) && `${market.question} ${market.description}`.toLowerCase().includes(query.query.toLowerCase()));
  return <>
    <div className="page-heading"><div><p className="eyebrow">Try Jader-Market</p><h1>Demo markets</h1><p className="muted">Open a question, choose YES or NO, and try a practice trade.</p></div><span className="badge">1,000 practice credits per market</span></div>
    <div className="notice">Fictional markets and sample prices. Practice trades use temporary demo credits and reset when you leave or reload a market. No account or database needed.</div>
    <form className="filters" action="/demo"><label>Search demo markets<input name="q" defaultValue={query.query} placeholder="Search questions" maxLength={120} /></label><label>Category<select name="category" defaultValue={query.category}><option value="all">All categories</option><option value="technology">Technology</option><option value="science">Science</option><option value="community">Community</option></select></label><button type="submit">Search</button></form>
    {items.length ? <div className="grid">{items.map(market => <article className="card" key={market.slug}><div className="card-top"><span>{market.category}</span><span className="badge">Demo</span></div><h2><Link href={`/demo/${market.slug}`}>{market.question}</Link></h2><div className="demo-probability"><strong>{market.yesPrice}%</strong><span className="muted">Sample YES probability</span></div><div className="quote-row"><Link className="quote yes" href={`/demo/${market.slug}`}>YES <span>{(market.yesPrice / 100).toFixed(2)} credits</span></Link><Link className="quote no" href={`/demo/${market.slug}`}>NO <span>{((100 - market.yesPrice) / 100).toFixed(2)} credits</span></Link></div><div className="card-bottom"><span>Fictional scenario</span><Link href={`/demo/${market.slug}`}>Try market →</Link></div></article>)}</div> : <div className="empty"><h2>No demo markets found</h2><p>Try another search or category.</p><Link href="/demo">Show all demo markets</Link></div>}
    <div className="pagination"><span>{items.length} demo markets</span><Link href="/">Back to community markets</Link></div>
  </>;
}
