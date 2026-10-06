// Fictional, fixed-price scenarios. Never use this module for actual trading.
export const demoMarkets = [
  {
    slug: "freshman-progression-2027",
    question: "Will at least half of the freshman class progress to their second year in 2027?",
    category: "community",
    description: "A fictional freshman class faces its first-year assessments. YES requires at least 50% of the starting class to advance. The demo starts with a deliberately low 2% YES price; this is a sample scenario, not a forecast based on student data.",
    rules: "The administrator fixes the cohort to students enrolled at the start of the 2026/27 academic year. Resolve YES if at least 50% of that cohort are officially approved to progress to their second year by 31 December 2027, 23:59 UTC. Otherwise resolve NO. Withdrawals and students repeating their first year remain in the denominator and do not count as advancing. Missing or unverifiable aggregate results make the market invalid.",
    source: "The sole administrator's confirmation of the aggregate progression count.",
    yesPrice: 2,
    history: [18, 15, 13, 10, 8, 6, 5, 4, 3, 3, 2, 2],
  },
  {
    slug: "community-game-night",
    question: "Will at least 10 people join the next community game night?",
    category: "community",
    description: "A fictional community is planning a Friday game night. Try buying YES if you expect a good turnout, or NO if you expect fewer than 10 players.",
    rules: "The administrator counts distinct players who join before the event ends. At least 10 means YES; fewer means NO. A cancelled event is invalid.",
    source: "The administrator's attendance count.",
    yesPrice: 62,
    history: [45, 48, 46, 51, 50, 55, 53, 58, 60, 57, 61, 62],
  },
  {
    slug: "prototype-launch",
    question: "Will the community launch its project before the deadline?",
    category: "technology",
    description: "A fictional team is preparing its first release. This example shows a simple binary market with a clearly defined release deadline.",
    rules: "Resolve YES if the administrator can open the published release before the agreed deadline. Otherwise resolve NO. A withdrawn project is invalid.",
    source: "The administrator's release check.",
    yesPrice: 74,
    history: [52, 57, 55, 60, 64, 61, 67, 65, 70, 72, 71, 74],
  },
  {
    slug: "weather-station",
    question: "Will the community weather station record at least 25°C?",
    category: "science",
    description: "A fictional weather station supplies the result for this example. Practice comparing the cost of a position with its possible payout.",
    rules: "Resolve YES if the station's maximum reading on the agreed day is at least 25°C. Otherwise resolve NO. Missing station data makes the market invalid.",
    source: "The administrator's station reading.",
    yesPrice: 38,
    history: [49, 46, 48, 44, 42, 45, 40, 41, 37, 39, 36, 38],
  },
] as const;

export type DemoMarket = typeof demoMarkets[number];
export type DemoOutcome = "yes" | "no";
export type DemoAction = "buy" | "sell";
export type DemoWallet = { balance: number; yes: number; no: number };

// One credit is 100 units. Integer arithmetic avoids fractional balance drift.
export function initialDemoWallet(): DemoWallet {
  return { balance: 100_000, yes: 0, no: 0 };
}

export function simulateTrade(wallet: DemoWallet, outcome: DemoOutcome, action: DemoAction, quantity: number, yesPrice: number): { wallet: DemoWallet; error?: string } {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10_000) {
    return { wallet, error: "Enter a whole number of shares between 1 and 10,000." };
  }
  if (!Number.isSafeInteger(yesPrice) || yesPrice < 1 || yesPrice > 99) {
    return { wallet, error: "This demo quote is unavailable." };
  }
  const price = outcome === "yes" ? yesPrice : 100 - yesPrice;
  const cost = price * quantity;
  if (action === "buy" && cost > wallet.balance) return { wallet, error: "Not enough demo credits. Reduce the quantity or reset the demo." };
  if (action === "sell" && quantity > wallet[outcome]) return { wallet, error: "You can only sell shares you hold in this demo." };
  const direction = action === "buy" ? 1 : -1;
  return { wallet: { ...wallet, balance: wallet.balance - direction * cost, [outcome]: wallet[outcome] + direction * quantity } };
}

export function formatDemoCredits(units: number) {
  return (units / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
