import Link from "next/link";
import { listMarkets } from "../db/markets";
import { parseMarketQuery } from "../domain/market-query";
import { effectiveMarketStatus } from "../domain/market-admin";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string,string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = parseMarketQuery({ q: typeof params.q === "string" ? params.q : undefined, category: typeof params.category === "string" ? params.category : undefined, page: typeof params.page === "string" ? params.page : undefined });
  const result = await listMarkets(query);
  const pageLink = (page: number) => `/?${new URLSearchParams({ q: query.query, category: query.category, page: String(page) })}`;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Community predictions</p><h1>Markets</h1><p className="muted">Browse questions and the rules that will determine their outcome.</p></div><span className="badge">Trading not enabled yet</span></div>
    <div className="notice">Want to try the interface? <Link href="/demo" className="demo-link">Open demo markets →</Link> Practice with fictional credits, no account or database needed.</div>
    <form className="filters" action="/"><label>Search markets<input name="q" defaultValue={query.query} placeholder="Search questions" maxLength={120} /></label><label>Category<select name="category" defaultValue={query.category}><option value="all">All categories</option><option value="technology">Technology</option><option value="science">Science</option><option value="community">Community</option></select></label><button type="submit">Search</button></form>
    {result.state !== "ready" ? <div className="empty"><h2>Markets are not available yet</h2><p>{result.state === "unconfigured" ? "The operator needs to configure the database and apply migrations." : "The market service is temporarily unavailable. Please try again later."}</p></div> : result.items.length === 0 ? <div className="empty"><h2>No markets found</h2><p>Try another search or category. Only published markets appear here.</p></div> : <div className="grid">{result.items.map(market => <article className="card" key={market.id}><div className="card-top"><span>{market.category}{market.synthetic === "yes" ? " · Synthetic example" : ""}</span><span className="badge">{effectiveMarketStatus(market)}</span></div><h2><Link href={`/markets/${market.slug}`}>{market.question}</Link></h2><div className="quote-row"><span className="quote yes">YES <span>No quote</span></span><span className="quote no">NO <span>No quote</span></span></div><div className="card-bottom"><span>Closes {market.closesAt.toLocaleDateString("en-GB", { timeZone: "UTC" })} UTC</span><Link href={`/markets/${market.slug}`}>View market →</Link></div></article>)}</div>}
    {result.state === "ready" && <div className="pagination"><span>{result.total} markets</span>{query.page > 1 && <Link href={pageLink(query.page - 1)}>Previous</Link>}{query.page * query.pageSize < result.total && <Link href={pageLink(query.page + 1)}>Next</Link>}</div>}
  </>;
}
