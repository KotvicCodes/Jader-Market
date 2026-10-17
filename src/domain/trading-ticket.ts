import type { Outcome, Side } from "./trading";
import { creditTicks, formatCredits, maxQuantity } from "./trading-values";

type Identity = { marketId: string; operationKey: string };
export type TradingRequest =
  | { action: "mint" | "burn"; body: Identity & { quantity: string } }
  | { action: "place"; body: Identity & { quantity: string; price: string; outcome: Outcome; side: Side; timeInForce: "GTC" | "GTD" | "IOC"; expiresAt?: string } }
  | { action: "cancel"; body: Identity & { orderId: string } };

export function ticketRequest(marketId: string, operationKey: string, fields: Record<string, string>, closesAt: string, now = Date.now()): TradingRequest {
  const { action, quantity } = fields;
  if (!/^[1-9][0-9]{0,6}$/.test(quantity ?? "") || BigInt(quantity) > maxQuantity) throw new Error("Enter 1 to 1,000,000 whole shares or complete sets.");
  const body = { marketId, operationKey, quantity };
  if (action === "mint" || action === "burn") return { action, body };
  if (action !== "place" || (fields.outcome !== "YES" && fields.outcome !== "NO") || (fields.side !== "buy" && fields.side !== "sell")) throw new Error("Choose a trading action, outcome and side.");
  if (!/^(?:0|0?\.[0-9]{1,4})$/.test(fields.price ?? "")) throw new Error("Enter a limit price from 0.0001 to 0.9999 credits, with at most four decimal places.");
  const [, fraction = ""] = fields.price.split(".");
  const price = BigInt(fraction.padEnd(4, "0"));
  if (price < 1n || price >= creditTicks) throw new Error("The limit price must be between 0.0001 and 0.9999 credits.");
  const timeInForce = fields.timeInForce;
  if (timeInForce !== "GTC" && timeInForce !== "GTD" && timeInForce !== "IOC") throw new Error("Choose how long the order stays active.");
  let expiresAt: string | undefined;
  if (timeInForce === "GTD") {
    const input = fields.expiresAt ?? "";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(input)) throw new Error("Enter an expiry in UTC before the market closes.");
    expiresAt = `${input.length === 16 ? `${input}:00` : input}Z`;
    const expiry = new Date(expiresAt);
    if (!Number.isFinite(expiry.getTime()) || expiry.toISOString().replace(".000Z", "Z") !== expiresAt || expiry.getTime() <= now || expiry.getTime() > Date.parse(closesAt)) throw new Error("The UTC expiry must be in the future and no later than market closing.");
  }
  return { action: "place", body: { ...body, price: price.toString(), outcome: fields.outcome, side: fields.side, timeInForce, ...(expiresAt ? { expiresAt } : {}) } };
}

export function requestSummary(request: TradingRequest): string[] {
  if (request.action === "cancel") return ["Cancel this order's unfilled remainder. Completed fills stay final; remaining reserved credits or shares are released.", `Order reference: ${request.body.orderId}`];
  if (request.action === "mint" || request.action === "burn") {
    const { quantity } = request.body;
    const amount = formatCredits(BigInt(quantity) * creditTicks);
    return request.action === "mint"
      ? [`Mint ${quantity} complete sets: receive ${quantity} YES and ${quantity} NO shares.`, `Cost: ${amount} credits from your available balance, locked as market collateral.`]
      : [`Burn ${quantity} available YES and ${quantity} available NO shares.`, `Return: ${amount} credits from market collateral. Shares reserved in orders cannot be burned.`];
  }
  // Narrow the request explicitly because mint/burn share a union member.
  if (request.action !== "place") return [];
  const { side, outcome, quantity, price, timeInForce, expiresAt } = request.body;
  const total = formatCredits(BigInt(price) * BigInt(quantity));
  return [
    `${side === "buy" ? "Buy" : "Sell"} ${quantity} ${outcome} shares at a ${side === "buy" ? "maximum" : "minimum"} of ${formatCredits(BigInt(price))} credits per share.`,
    side === "buy" ? `Reserve up to ${total} credits. Better execution prices return the difference to your available balance.` : `Reserve ${quantity} owned ${outcome} shares. Minimum proceeds if fully filled: ${total} credits.`,
    timeInForce === "IOC" ? "Immediate or cancel: fill available matching shares now and cancel any remainder." : timeInForce === "GTD" ? `Keep the unfilled remainder open until ${expiresAt?.replace("T", " ").replace("Z", " UTC")}, cancellation or market closure.` : "Keep the unfilled remainder open until cancellation or market closure.",
    "Fees: 0 credits. Matching may be partial or absent. Displayed depth can change before confirmation.",
  ];
}

// Only explicit transaction rejections prove that this operation did not commit.
// Authentication failures and transport/server errors can follow an earlier commit.
export const tradingRejections: Record<string, string> = {
  insufficient_credits: "You do not have enough available credits. Reduce the amount or wait for reserved credits to be released.",
  insufficient_shares: "You do not have enough available shares. Cancel a resting sell order to release shares, or mint complete sets.",
  trading_closed: "This market is paused or closed. Refresh the market to check its current status.",
  trading_unavailable: "This synthetic browsing example does not accept minting or new orders.",
  invalid_trading_input: "Check the whole-share quantity, limit price and order duration.",
  invalid_order_expiry: "The expiry must be in the future and no later than market closing. Enter the time in UTC.",
  order_limit: "The account or market has reached its open-order limit. Cancel an existing order first.",
  order_missing: "This order is unavailable to your account. Refresh to check your open orders.",
  market_missing: "This market is unavailable. Return to the market list.",
};

export function tradingResult(request: TradingRequest, data: Record<string, unknown>): string {
  if (request.action === "mint" || request.action === "burn") {
    if (data.operationKey !== request.body.operationKey || data.action !== request.action || data.quantity !== request.body.quantity) throw new Error("Unrecognized result");
    return `${request.action === "mint" ? "Minted" : "Burned"} ${data.quantity} complete sets.`;
  }
  const order = data.order as { id?: unknown; status?: unknown; quantity?: unknown; remaining?: unknown; reason?: unknown } | undefined;
  if (!order || order.id !== (request.action === "cancel" ? request.body.orderId : request.body.operationKey) || !["open", "filled", "cancelled", "expired"].includes(String(order.status)) || !/^[1-9][0-9]{0,6}$/.test(String(order.quantity)) || !/^(0|[1-9][0-9]{0,6})$/.test(String(order.remaining))) throw new Error("Unrecognized result");
  const filled = BigInt(String(order.quantity)) - BigInt(String(order.remaining));
  if (filled < 0n) throw new Error("Unrecognized result");
  const reason = order.reason === "self_trade" ? " Matching your own order is prevented." : "";
  if (order.status === "open") return `Order saved: ${filled} of ${order.quantity} shares filled; ${order.remaining} remain open and reserved.`;
  if (order.status === "filled") return `Order filled: ${filled} of ${order.quantity} shares.${request.action === "cancel" ? " It completed before cancellation; no shares remained to cancel." : ""}`;
  return `Order ${order.status}: ${filled} of ${order.quantity} shares filled; the unfilled ${order.remaining} shares are no longer reserved.${reason}`;
}
