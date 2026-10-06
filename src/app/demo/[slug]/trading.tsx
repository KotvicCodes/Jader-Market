"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { formatDemoCredits, initialDemoWallet, simulateTrade, type DemoAction, type DemoMarket, type DemoOutcome } from "../../../domain/demo";

export function DemoTrading({ market }: { market: DemoMarket }) {
  const [wallet, setWallet] = useState(initialDemoWallet);
  const [outcome, setOutcome] = useState<DemoOutcome>("yes");
  const [action, setAction] = useState<DemoAction>("buy");
  const [quantity, setQuantity] = useState("10");
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const price = outcome === "yes" ? market.yesPrice : 100 - market.yesPrice;
  const shares = Number(quantity);
  const validQuantity = Number.isSafeInteger(shares) && shares > 0 && shares <= 10_000;
  const cost = validQuantity ? shares * price : 0;
  const canTrade = validQuantity && (action === "buy" ? cost <= wallet.balance : shares <= wallet[outcome]);
  const points = market.history.map((value, index) => `${20 + index * 460 / (market.history.length - 1)},${180 - value * 1.6}`).join(" ");

  function trade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = simulateTrade(wallet, outcome, action, shares, market.yesPrice);
    setWallet(result.wallet);
    setMessage({ text: result.error ?? `${action === "buy" ? "Bought" : "Sold"} ${shares} ${outcome.toUpperCase()} shares for ${formatDemoCredits(cost)} demo credits.`, error: Boolean(result.error) });
  }

  return <div className="detail-grid">
    <div className="stack">
      <section className="panel"><div className="card-top"><h2>Sample price history</h2><span className="badge">Fictional data</span></div><div className="demo-probability"><strong>{market.yesPrice}%</strong><span className="muted">YES · fixed demo quote</span></div><svg className="demo-chart" viewBox="0 0 500 200" role="img" aria-label={`Fictional YES probability history, ending at ${market.yesPrice} percent`}><line x1="20" x2="480" y1="20" y2="20" className="chart-grid" /><line x1="20" x2="480" y1="100" y2="100" className="chart-grid" /><line x1="20" x2="480" y1="180" y2="180" className="chart-grid" /><polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinejoin="round" /><circle cx="480" cy={180 - market.yesPrice * 1.6} r="5" fill="var(--accent)" /></svg><div className="card-bottom"><span>Earlier sample</span><span>Latest sample</span></div></section>
      <section className="panel"><h2>Your demo positions</h2><div className="table-wrap"><table><thead><tr><th>Outcome</th><th>Shares</th><th>Value at sample price</th><th>Payout if it wins</th></tr></thead><tbody>{(["yes", "no"] as const).map(side => <tr key={side}><td className={side === "yes" ? "success" : "error"}>{side.toUpperCase()}</td><td>{wallet[side]}</td><td>{formatDemoCredits(wallet[side] * (side === "yes" ? market.yesPrice : 100 - market.yesPrice))} credits</td><td>{formatDemoCredits(wallet[side] * 100)} credits</td></tr>)}</tbody></table></div><p className="muted demo-hint">A winning share pays 1 credit; a losing share pays 0. This demo previews positions and does not settle a result.</p></section>
      <section className="panel"><h2>About this market</h2><p>{market.description}</p><dl className="metadata"><div><dt>Oracle</dt><dd>Community administrator</dd></div><div><dt>Deadline</dt><dd>Illustrative event deadline</dd></div></dl><h3>Resolution rules</h3><p>{market.rules}</p><h3>Source</h3><p className="muted">{market.source}</p></section>
    </div>
    <aside className="panel demo-ticket"><h2>Practice trade</h2><div className="demo-balance"><span className="muted">Available demo credits</span><strong>{formatDemoCredits(wallet.balance)}</strong></div>
      <form className="demo-form" onSubmit={trade}><fieldset><legend>Action</legend><div className="demo-toggle">{(["buy", "sell"] as const).map(value => <button type="button" key={value} aria-pressed={action === value} onClick={() => { setAction(value); setMessage(undefined); }}>{value === "buy" ? "Buy" : "Sell"}</button>)}</div></fieldset><fieldset><legend>Outcome</legend><div className="demo-toggle">{(["yes", "no"] as const).map(side => <button type="button" className={side} key={side} aria-pressed={outcome === side} onClick={() => { setOutcome(side); setMessage(undefined); }}>{side.toUpperCase()} · {formatDemoCredits(side === "yes" ? market.yesPrice : 100 - market.yesPrice)}</button>)}</div></fieldset>
        <label>Number of shares<input type="number" min="1" max="10000" step="1" required value={quantity} onChange={event => { setQuantity(event.target.value); setMessage(undefined); }} /></label>
        <dl className="demo-summary"><div><dt>Price per share</dt><dd>{formatDemoCredits(price)} credits</dd></div><div><dt>{action === "buy" ? "Total cost" : "You receive"}</dt><dd>{validQuantity ? formatDemoCredits(cost) : "0.00"} credits</dd></div>{action === "buy" && <div><dt>Payout if {outcome.toUpperCase()} wins</dt><dd>{formatDemoCredits(validQuantity ? shares * 100 : 0)} credits</dd></div>}</dl>
        {!canTrade && <p className="error" role="status">{!validQuantity ? "Enter 1 to 10,000 whole shares." : action === "buy" ? "Not enough demo credits for this quantity." : `You hold ${wallet[outcome]} ${outcome.toUpperCase()} shares. Buy shares before selling them.`}</p>}
        <button type="submit" disabled={!canTrade}>{action === "buy" ? "Buy" : "Sell"} {outcome.toUpperCase()} with demo credits</button>
      </form>
      <div aria-live="polite">{message && <p className={`${message.error ? "error" : "success"} demo-hint`}>{message.text}</p>}</div>
      <p className="muted demo-hint">Sample prices stay fixed. This practice trade does not submit an order to another participant.</p><button type="button" className="secondary-button" onClick={() => { setWallet(initialDemoWallet()); setMessage({ text: "Demo reset to 1,000 credits and no shares.", error: false }); }}>Reset demo</button>
    </aside>
  </div>;
}
