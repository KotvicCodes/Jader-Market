import Link from "next/link";
import { randomUUID } from "node:crypto";
import { currentMember } from "../../auth/web";
import { MemberForm } from "../../components/member-form";
import { WithdrawalList } from "../../components/withdrawal-list";
import { withdrawalSnapshot } from "../../db/withdrawals";
import { parseMarketQuery } from "../../domain/market-query";

export const dynamic = "force-dynamic";

export default async function WithdrawalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const page = parseMarketQuery({ page: typeof params.page === "string" ? params.page : undefined }).page;
  let member;
  let snapshot;
  try {
    member = await currentMember();
    if (member) snapshot = await withdrawalSnapshot(member.token, page);
  } catch { return <div className="empty"><h1>Withdrawals temporarily unavailable</h1><p>Please refresh or sign in again.</p></div>; }
  if (!member || !snapshot) return <div className="empty"><h1>Sign in to view withdrawals</h1><p>Your requests and payment references are private.</p><Link className="button" href="/account">Sign in</Link></div>;
  return <>
    <Link href="/portfolio" className="back">← Portfolio</Link>
    <h1>Offline withdrawals</h1>
    <p className="muted">Arrange payment details privately with your administrator. A request reserves credits; it does not send a payment or promise a completion time.</p>
    <section className="panel"><h2>Request a withdrawal</h2><p>Only available credits can be withdrawn. Reserved credits cannot be traded or withdrawn again. You can cancel until payment processing starts.</p>
      <MemberForm endpoint="/api/withdrawals/request" csrf={member.csrf} operationKey={randomUUID()} newOperationLabel="Start a different withdrawal request" submitLabel="Request withdrawal and reserve credits" successText="Request recorded. Credits are reserved until payment or cancellation.">
        <label>Amount in credits<input name="amount" type="number" min="0.0001" max="1000000" step="0.0001" required /></label>
        <label className="checkbox-label"><input type="checkbox" name="confirmed" required />Reserve these credits for an offline withdrawal.</label>
      </MemberForm>
    </section>
    <WithdrawalList items={snapshot.items} csrf={member.csrf} />
    <div className="pagination"><span>Page {page}</span>{page > 1 && <Link href={`/withdrawals?page=${page - 1}`}>Previous</Link>}{snapshot.hasNext && <Link href={`/withdrawals?page=${page + 1}`}>Next</Link>}</div>
  </>;
}
