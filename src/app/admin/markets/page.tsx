import Link from "next/link";
import { currentMember } from "../../../auth/web";
import { AdminAccess } from "../../../components/admin-access";
import { administratorMarkets } from "../../../db/market-admin";
import { requireAdministrator } from "../../../db/members";
import { MemberError } from "../../../domain/identity";
import { effectiveMarketStatus } from "../../../domain/market-admin";
import { parseMarketQuery } from "../../../domain/market-query";

export const dynamic = "force-dynamic";

export default async function AdminMarkets({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q.trim().slice(0, 120) : "";
  const page = parseMarketQuery({ page: typeof params.page === "string" ? params.page : undefined }).page;
  const status = typeof params.status === "string" && ["draft", "open", "closed"].includes(params.status) ? params.status : "all";
  let member;
  let snapshot;
  let code;
  try {
    member = await currentMember();
    requireAdministrator(member);
    snapshot = await administratorMarkets(member.token, page, query, status);
  } catch (error) { code = error instanceof MemberError ? error.code : "unavailable"; }
  if (!member || !snapshot) return <AdminAccess member={member} code={code} />;
  const pageLink = (value: number) => `/admin/markets?${new URLSearchParams({ q: query, status, page: String(value) })}`;
  return <>
    <Link className="back" href="/admin">← Accounts and credits</Link>
    <div className="page-heading"><div><p className="eyebrow">Operator workspace</p><h1>Market administration</h1><p className="muted">Prepare private drafts, publish fixed terms, and manage availability.</p></div><Link className="button" href="/admin/markets/new">Create draft</Link></div>
    <form className="filters" action="/admin/markets"><label>Find a market<input name="q" defaultValue={query} maxLength={120} placeholder="Search questions" /></label><label>Publication state<select name="status" defaultValue={status}><option value="all">All states</option><option value="draft">Drafts</option><option value="open">Published, including paused or expired</option><option value="closed">Explicitly closed</option></select></label><button type="submit">Search</button></form>
    <section className="panel">{snapshot.items.length ? <div className="table-wrap"><table className="market-table"><thead><tr><th>Question</th><th>Status</th><th>Closes (UTC)</th><th>Controls</th></tr></thead><tbody>{snapshot.items.map(market => <tr key={market.id}><td className="market-question"><Link href={`/admin/markets/${market.id}`}>{market.question}</Link>{market.synthetic === "yes" && <p className="muted">Synthetic example</p>}</td><td><span className="badge">{effectiveMarketStatus(market)}</span></td><td>{market.closesAt.toISOString().replace("T", " ").slice(0, 19)}</td><td><Link href={`/admin/markets/${market.id}`}>Manage →</Link></td></tr>)}</tbody></table></div> : <p className="muted">No matching markets. Create a draft or adjust your filters.</p>}
      <div className="pagination"><span>{snapshot.total} markets · Page {page}</span>{page > 1 && <Link href={pageLink(page - 1)}>Previous</Link>}{page * 20 < snapshot.total && <Link href={pageLink(page + 1)}>Next</Link>}</div>
    </section>
  </>;
}
