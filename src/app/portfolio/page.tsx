import Link from "next/link";
import { currentMember } from "../../auth/web";
import { accountSnapshot } from "../../db/members";
import { formatCredits } from "../../domain/identity";
import { parseMarketQuery } from "../../domain/market-query";

export const dynamic = "force-dynamic";
const reasons: Record<string, string> = { demo_grant: "Admin credit grant", offline_credit: "Confirmed offline credit", offline_debit: "Confirmed offline debit", correction: "Admin correction" };

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const page = parseMarketQuery({ page: typeof params.page === "string" ? params.page : undefined }).page;
  let snapshot;
  try {
    const member = await currentMember();
    if (member) snapshot = await accountSnapshot(member.token, page);
  } catch { return <div className="empty"><h1>Balance temporarily unavailable</h1><p>Please refresh or sign in again.</p></div>; }
  if (!snapshot) return <><h1>Portfolio</h1><div className="empty"><h2>Sign in to view your balance</h2><p>Your credits and history are private.</p><Link className="button" href="/account">Sign in</Link></div></>;
  return <>
    <div className="page-heading"><div><p className="eyebrow">Your private portfolio</p><h1>Credits</h1><p className="muted">{snapshot.session.user.handle} · Balances persist when you reload or sign in again.</p></div><span className="badge">Internal credits</span></div>
    <div className="balance-grid"><section className="panel"><p className="muted">Available credits</p><strong>{formatCredits(snapshot.available)}</strong></section><section className="panel"><p className="muted">Reserved credits</p><strong>{formatCredits(snapshot.reserved)}</strong></section></div>
    <div className="notice">Only administrators issue credits. The practice markets use a separate temporary balance. Actual bet payouts will be connected when trading and resolution are available.</div>
    <section className="panel"><h2>Balance history</h2>{snapshot.history.length ? <div className="table-wrap"><table><thead><tr><th>Date (UTC)</th><th>Activity</th><th>Credit change</th><th>Receipt</th></tr></thead><tbody>{snapshot.history.map(record => <tr key={record.id}><td>{record.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{reasons[record.reason] ?? "Balance adjustment"}</td><td className={record.kind === "credit" ? "success" : "error"}>{record.kind === "credit" ? "+" : "-"}{formatCredits(record.amount)}</td><td><code>{record.id.slice(0, 8)}</code></td></tr>)}</tbody></table></div> : <p className="muted">No credit adjustments yet. Your administrator can grant credits or confirm an offline adjustment.</p>}</section>
    <div className="pagination"><span>Page {page}</span>{page > 1 && <Link href={`/portfolio?page=${page - 1}`}>Previous</Link>}{snapshot.hasNext && <Link href={`/portfolio?page=${page + 1}`}>Next</Link>}</div>
  </>;
}
