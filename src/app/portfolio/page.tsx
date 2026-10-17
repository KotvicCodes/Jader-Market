import Link from "next/link";
import { currentMember } from "../../auth/web";
import { PortfolioLive } from "../../components/portfolio-live";
import { portfolioSnapshot } from "../../db/portfolio";
import { MemberError } from "../../domain/identity";
import { parsePortfolioQuery } from "../../domain/portfolio-query";

export const dynamic = "force-dynamic";

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let member, snapshot, query;
  try {
    member = await currentMember();
    query = parsePortfolioQuery(await searchParams);
    if (member) snapshot = await portfolioSnapshot(member.token, query);
  } catch (error) {
    if (error instanceof MemberError && error.code === "invalid_request") return <div className="empty"><h1>Invalid portfolio link</h1><p>The history cursor is invalid.</p><Link href="/portfolio">Open the latest portfolio</Link></div>;
    return <div className="empty"><h1>Portfolio temporarily unavailable</h1><p>Please refresh or sign in again.</p></div>;
  }
  if (!member || !snapshot) return <><h1>Portfolio</h1><div className="empty"><h2>Sign in to view your balance</h2><p>Your credits, positions and history are private.</p><Link className="button" href="/account">Sign in</Link></div></>;
  return <PortfolioLive key={`${snapshot.member.id}:${JSON.stringify(query)}`} initial={{ ...snapshot, csrf: member.csrf }} query={query} />;
}
