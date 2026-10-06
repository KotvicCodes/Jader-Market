import Link from "next/link";
import { notFound } from "next/navigation";
import { demoMarkets } from "../../../domain/demo";
import { DemoTrading } from "./trading";

export default async function DemoMarketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const market = demoMarkets.find(market => market.slug === slug);
  if (!market) notFound();
  return <>
    <Link href="/demo" className="back">← Demo markets</Link>
    <div className="page-heading"><div><p className="eyebrow">{market.category}</p><h1>{market.question}</h1></div><span className="badge">Demo market</span></div>
    <div className="notice">Fictional scenario with fixed sample prices. Trades fill instantly for practice, using temporary credits. Reloading or leaving this market resets your balance and positions.</div>
    <DemoTrading key={market.slug} market={market} />
  </>;
}
