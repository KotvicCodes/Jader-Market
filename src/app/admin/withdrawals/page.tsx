import Link from "next/link";
import { currentMember } from "../../../auth/web";
import { AdminAccess } from "../../../components/admin-access";
import { WithdrawalList } from "../../../components/withdrawal-list";
import { withdrawalSnapshot } from "../../../db/withdrawals";
import { MemberError } from "../../../domain/identity";
import { parseMarketQuery } from "../../../domain/market-query";

export const dynamic = "force-dynamic";

export default async function AdminWithdrawals({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const page = parseMarketQuery({ page: typeof params.page === "string" ? params.page : undefined }).page;
  const active = params.view !== "all";
  let member;
  let snapshot;
  let code;
  try {
    member = await currentMember();
    if (member) snapshot = await withdrawalSnapshot(member.token, page, true, active);
  } catch (error) { code = error instanceof MemberError ? error.code : "unavailable"; }
  if (!member || !snapshot || code) return <AdminAccess member={member} code={code} />;
  const pageLink = (value: number) => `/admin/withdrawals?view=${active ? "active" : "all"}&page=${value}`;
  return <>
    <Link href="/admin" className="back">← Administration</Link><h1>Offline withdrawal queue</h1>
    <p className="notice">Start processing and verify the saved state before sending money. Check the withdrawal reference in your external payment records before every transfer. If a response is lost, refresh and reconcile; do not send another payment. Uncertain transfers must remain processing.</p>
    <p><Link href="/admin/withdrawals">Active requests</Link> · <Link href="/admin/withdrawals?view=all">All requests and history</Link></p>
    <WithdrawalList items={snapshot.items} csrf={member.csrf} administrator />
    <div className="pagination"><span>Page {page}</span>{page > 1 && <Link href={pageLink(page - 1)}>Previous</Link>}{snapshot.hasNext && <Link href={pageLink(page + 1)}>Next</Link>}</div>
  </>;
}
