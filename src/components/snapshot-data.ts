import type { MarketSnapshot } from "../db/market-snapshot";
import type { portfolioSnapshot } from "../db/portfolio";
import { SnapshotSessionError } from "./live-snapshot";

export type PortfolioSnapshot = Awaited<ReturnType<typeof portfolioSnapshot>> & { csrf: string };
type Check = (value: unknown) => boolean;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str: Check = v => typeof v === "string";
const nullable = (check: Check): Check => v => v === null || check(v);
const integer: Check = v => typeof v === "string" && /^-?\d{1,40}$/.test(v);
const date: Check = v => typeof v === "string" && Number.isFinite(Date.parse(v));
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const fields = (shape: Record<string, Check>): Check => v => object(v) && Object.entries(shape).every(([key, check]) => check(v[key]));
const list = (check: Check): Check => v => Array.isArray(v) && v.every(check);
const status = oneOf("open", "paused", "closed", "settling", "proposed", "resolved", "void", "cancelled");
const outcome = oneOf("YES", "NO"), side = oneOf("buy", "sell");
const order = fields({ id: str, outcome, side, price: integer, quantity: integer, remaining: integer, status: str, reason: nullable(str), timeInForce: oneOf("GTC", "GTD", "IOC"), expiresAt: nullable(date), sequence: integer });
const market = { slug: str, question: str };
const portfolioOrder = fields({ ...market, marketId: str, marketStatus: status, createdAt: date });
const completeOrder: Check = v => order(v) && portfolioOrder(v);
const fill = fields({ outcome, side, quantity: integer, price: integer, createdAt: date, sequence: integer });
const page = (item: Check) => fields({ items: list(item), nextCursor: nullable(str) });
const privateTrading = fields({ status, availableCredits: integer, reservedCredits: integer, holdings: list(fields({ outcome, available: integer, reserved: integer })), openOrders: list(order), orders: list(order), fills: list(fill), nextCursor: nullable(str), nextFillCursor: nullable(str) });
const publicTrading = fields({ status, executable: oneOf(true, false), book: list(fields({ outcome, side, price: integer, quantity: integer })), trades: list(fields({ outcome, price: integer, quantity: integer, sequence: integer, createdAt: date })), nextCursor: nullable(str) });
const portfolio = fields({
  loadedAt: date, csrf: str, member: fields({ id: str, handle: str }), availableCredits: integer, orderReservedCredits: integer, withdrawalReservedCredits: integer, reservedCredits: integer,
  holdings: page(fields({ ...market, id: str, marketId: str, status, outcome, available: integer, reserved: integer, total: integer })),
  openOrders: list(completeOrder), orders: page(completeOrder),
  fills: page(v => fill(v) && fields({ ...market, id: str, total: integer })(v)),
  activity: page(fields({ id: str, source: oneOf("credit", "shares"), createdAt: date, kind: str, reason: str, marketId: nullable(str), slug: nullable(str), question: nullable(str), outcome: nullable(outcome), availableCredits: integer, orderReserved: integer, withdrawalReserved: integer, availableShares: integer, reservedShares: integer })),
  payouts: page(fields({ ...market, id: str, sequence: integer, quantity: integer, amount: integer, outcome, result: oneOf("YES", "NO", "invalid"), createdAt: date })),
});

export function readPortfolioSnapshot(value: unknown, ownerId: string): PortfolioSnapshot {
  if (!portfolio(value)) throw new Error("Invalid portfolio snapshot");
  const result = value as PortfolioSnapshot;
  if (result.member.id !== ownerId) throw new SnapshotSessionError();
  return result;
}
export function readMarketSnapshot(value: unknown, ownerId: string | null): MarketSnapshot {
  if (!fields({ loadedAt: date, trading: publicTrading, resolution: nullable(fields({ result: oneOf("YES", "NO", "invalid"), evidence: str, createdAt: date })), account: nullable(fields({ ownerId: str, csrf: str, portfolio: privateTrading })) })(value)) throw new Error("Invalid market snapshot");
  const result = value as MarketSnapshot;
  if ((result.account?.ownerId ?? null) !== ownerId) throw new SnapshotSessionError();
  return result;
}
