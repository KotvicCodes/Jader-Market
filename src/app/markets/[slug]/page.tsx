import Link from "next/link";
import { notFound } from "next/navigation";
import { findPublicMarket } from "../../../db/markets";
import { currentMember } from "../../../auth/web";
import { marketSnapshot } from "../../../db/market-snapshot";
import { MarketLive } from "../../../components/market-live";

export const dynamic = "force-dynamic";

export default async function MarketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await findPublicMarket(slug);
  if (result.state === "missing") notFound();
  if (result.state !== "ready") return <div className="empty"><h1>Market temporarily unavailable</h1><p>Please try again later.</p><Link href="/">Back to markets</Link></div>;
  const { market } = result;
  let member;
  let initial = null;
  try { member = await currentMember(); initial = await marketSnapshot(market.id, member); } catch {}
  return <MarketLive key={`${member?.user.id ?? "anonymous"}:${market.id}`} market={{ ...market, closesAt: market.closesAt.toISOString() }} initial={initial} ownerId={member?.user.id ?? null} loadedAt={initial?.loadedAt ?? new Date().toISOString()} />;
}
