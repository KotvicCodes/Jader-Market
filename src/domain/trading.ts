import { MemberError } from "./identity";
import { marketUuid } from "./market-admin";

export const creditTicks = 10_000n;
export const maxQuantity = 1_000_000n;
export const maxOpenOrders = 100;
export const maxMarketOrders = 200;
export type Outcome = "YES" | "NO";
export type Side = "buy" | "sell";
export type TradingAction = "mint" | "burn" | "place" | "cancel";

export function integerString(input: unknown, maximum: bigint): bigint {
  if (typeof input !== "string" || !/^[1-9][0-9]{0,9}$/.test(input)) throw new MemberError("invalid_trading_input");
  const value = BigInt(input);
  if (value > maximum) throw new MemberError("invalid_trading_input");
  return value;
}

export function parseTrading(action: TradingAction, input: Record<string, unknown>, now = Date.now()) {
  const operationKey = marketUuid(input.operationKey);
  const marketId = marketUuid(input.marketId);
  if (action === "cancel") return { action, operationKey, marketId, orderId: marketUuid(input.orderId) } as const;
  const quantity = integerString(input.quantity, maxQuantity);
  if (action === "mint") return { action: "mint", operationKey, marketId, quantity } as const;
  if (action === "burn") return { action: "burn", operationKey, marketId, quantity } as const;
  if (input.outcome !== "YES" && input.outcome !== "NO") throw new MemberError("invalid_trading_input");
  if (input.side !== "buy" && input.side !== "sell") throw new MemberError("invalid_trading_input");
  if (input.timeInForce !== "GTC" && input.timeInForce !== "GTD" && input.timeInForce !== "IOC") throw new MemberError("invalid_trading_input");
  const price = integerString(input.price, creditTicks - 1n);
  let expiresAt: Date | null = null;
  if (input.timeInForce === "GTD") {
    if (typeof input.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.expiresAt)) throw new MemberError("invalid_order_expiry");
    expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString().replace(".000Z", "Z") !== input.expiresAt || expiresAt.getTime() <= now) throw new MemberError("invalid_order_expiry");
  } else if (input.expiresAt !== undefined && input.expiresAt !== null) throw new MemberError("invalid_order_expiry");
  return { action: "place", operationKey, marketId, quantity, price, outcome: input.outcome, side: input.side, timeInForce: input.timeInForce, expiresAt } as const;
}
