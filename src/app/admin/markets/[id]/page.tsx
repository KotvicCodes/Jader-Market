import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";
import { currentMember } from "../../../../auth/web";
import { AdminAccess } from "../../../../components/admin-access";
import { MarketEditor } from "../../../../components/market-editor";
import { MemberForm } from "../../../../components/member-form";
import { administratorMarket } from "../../../../db/market-admin";
import { publicResolution } from "../../../../db/settlement";
import { requireAdministrator } from "../../../../db/members";
import { MemberError } from "../../../../domain/identity";
import { effectiveMarketStatus, payoutPolicy } from "../../../../domain/market-admin";
import { parseMarketQuery } from "../../../../domain/market-query";

export const dynamic = "force-dynamic";

export default async function AdminMarket({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const search = await searchParams;
  const page = parseMarketQuery({ page: typeof search.page === "string" ? search.page : undefined }).page;
  let member;
  let snapshot;
  let code;
  try {
    member = await currentMember();
    requireAdministrator(member);
    if (id !== "new") snapshot = await administratorMarket(member.token, id, page);
  } catch (error) { code = error instanceof MemberError ? error.code : "unavailable"; }
  if (code === "market_missing" || (member?.user.role === "admin" && code === "invalid_request")) notFound();
  if (!member || code) return <AdminAccess member={member} code={code} />;
  if (id === "new") return <><Link className="back" href="/admin/markets">← Market administration</Link><h1>Create a YES/NO market</h1><p className="muted">Drafts are private. Review all terms before publishing; published terms cannot be edited.</p><section className="panel"><MarketEditor csrf={member.csrf} operationKey={randomUUID()} /></section></>;
  if (!snapshot) notFound();
  const { market } = snapshot;
  const resolution = await publicResolution(market.id);
  const status = effectiveMarketStatus(market);
  const reviewing = market.status === "draft" && search.review === "1";
  const actions = market.status === "draft" ? reviewing ? ["publish"] : [] : market.status === "open" ? [...(status !== "closed" ? [market.paused ? "resume" : "pause"] : []), "close"] : [];
  const labels: Record<string, string> = { publish: "Publish market", pause: "Pause market", resume: "Resume market", close: "Close market" };
  return <>
    <Link className="back" href="/admin/markets">← Market administration</Link><div className="page-heading"><div><p className="eyebrow">YES/NO market · Revision {market.revision}</p><h1>{market.question}</h1></div><span className="badge">{status}</span></div>
    <div className="detail-grid"><div className="stack"><section className="panel">{market.status === "draft" && !reviewing ? <><h2>Edit draft</h2><p className="muted">Save changes, then open the publication review to verify the saved terms.</p><MarketEditor key={market.revision} csrf={member.csrf} operationKey={randomUUID()} market={{ id: market.id, revision: market.revision, question: market.question, description: market.description, category: market.category, resolutionRules: market.resolutionRules, resolutionSource: market.resolutionSource, closesAt: market.closesAt.toISOString() }} /></> : <><h2>{reviewing ? "Review saved terms" : "Published terms"}</h2><p className="market-text">{market.description}</p><dl className="metadata"><div><dt>Category</dt><dd>{market.category}</dd></div><div><dt>Closing time (UTC)</dt><dd>{market.closesAt.toISOString().replace("T", " ").replace(".000Z", " UTC")}</dd></div></dl><p className="notice">{payoutPolicy}</p><h3>Resolution rules</h3><p className="market-text">{market.resolutionRules}</p><h3>Source</h3><p className="market-text">{market.resolutionSource}</p><Link className="button" href={reviewing ? `/admin/markets/${market.id}` : `/markets/${market.slug}`}>{reviewing ? "Return to editing" : "View public market"}</Link></>}</section>
    <section className="panel"><h2>Administration history</h2>{snapshot.history.length ? <div className="table-wrap" tabIndex={0}><table><thead><tr><th>Action</th><th>Revision</th><th>Time (UTC)</th></tr></thead><tbody>{snapshot.history.map(event => <tr key={event.id}><td>{event.action}</td><td>{event.revision}</td><td>{event.createdAt.toISOString().replace("T", " ").slice(0, 19)}</td></tr>)}</tbody></table></div> : <p className="muted">No recorded actions on this page.</p>}<div className="pagination"><span>Page {page}</span>{page > 1 && <Link href={`/admin/markets/${id}?page=${page - 1}`}>Previous</Link>}{snapshot.hasNext && <Link href={`/admin/markets/${id}?page=${page + 1}`}>Next</Link>}</div></section></div>
    <aside className="panel market-controls"><h2>Market controls</h2><p className="muted">{market.status === "draft" ? "Publication makes the saved question, deadline, description, and resolution rules public and permanently locks them." : market.status === "closed" ? "Closed markets cannot reopen. Record a final resolution below; the worker will distribute collateral." : market.status === "open" && status === "closed" ? "The deadline has passed. Close the market to release reservations, then record the final resolution." : market.status === "open" ? "Pausing is temporary. Closing is permanent. Neither action changes the published terms." : "The final resolution is recorded. Published terms and the result cannot change."}</p>{market.status === "draft" && !reviewing && <><p className="muted">Save your edits first. The review shows exactly what will be published.</p><Link className="button" href={`/admin/markets/${market.id}?review=1`}>Review publication</Link></>}{actions.map(action => <MemberForm key={`${market.revision}:${action}`} endpoint={`/api/admin/markets/${action}`} csrf={member.csrf} operationKey={randomUUID()} newOperationLabel={false} submitLabel={labels[action]} successText="Market updated."><input type="hidden" name="id" value={market.id} /><input type="hidden" name="revision" value={market.revision} /><label className="checkbox-label"><input type="checkbox" name="confirmed" required />{action === "publish" ? "I reviewed the saved terms and understand they will be locked." : action === "close" ? "I understand this market will permanently stop accepting trades." : `Confirm ${action} for this market.`}</label></MemberForm>)}{market.status === "closed" && <MemberForm key={market.revision} endpoint="/api/admin/markets/resolve" csrf={member.csrf} operationKey={randomUUID()} newOperationLabel={false} submitLabel="Record final resolution" successText="Resolution recorded. Payouts will resume automatically through the worker.">
      <input type="hidden" name="id" value={market.id} /><input type="hidden" name="revision" value={market.revision} />
      <label>Final result<select name="result" required><option value="">Choose a result</option><option value="YES">YES</option><option value="NO">NO</option><option value="invalid">Invalid — refund 0.5 per outcome share</option></select></label>
      <label>Public evidence<textarea name="evidence" minLength={20} maxLength={2000} rows={5} required /><span>This evidence will be public and cannot be changed.</span></label>
      <p className="muted">{payoutPolicy}</p><label className="checkbox-label"><input type="checkbox" name="confirmed" required />I verified the published rules and evidence. This resolution is permanent.</label>
    </MemberForm>}{resolution && <><h3>Final result: {resolution.result}</h3><p className="market-text">{resolution.evidence}</p><p className="muted">{market.status === "settling" ? "Payouts are pending. Keep the maintenance worker running." : "All outcome shares have been settled."}</p></>}<p className="muted">Published open markets accept trading API orders. Pausing blocks new orders and keeps existing reservations. Closing cancels open orders and releases their reservations. Participants can trade through the public market page.</p></aside></div>
  </>;
}
