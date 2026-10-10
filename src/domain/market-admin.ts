import { MemberError } from "./identity";

export const marketActions = ["create", "edit", "publish", "pause", "resume", "close"] as const;
export type MarketAction = typeof marketActions[number];

export function marketUuid(input: unknown): string {
  if (typeof input !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input)) throw new MemberError("invalid_request");
  return input.toLowerCase();
}

export function marketRevision(input: unknown) {
  if (typeof input !== "string" && typeof input !== "number") throw new MemberError("invalid_request");
  if (typeof input === "string" && !/^\d+$/.test(input)) throw new MemberError("invalid_request");
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_000_000_000) throw new MemberError("invalid_request");
  return value;
}

function text(input: unknown, minimum: number, maximum: number) {
  if (typeof input !== "string") throw new MemberError("invalid_market_terms");
  const value = input.trim();
  if (value.length < minimum || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new MemberError("invalid_market_terms");
  return value;
}

export function parseMarketTerms(input: Record<string, unknown>) {
  const question = text(input.question, 10, 240);
  const description = text(input.description, 10, 600);
  const resolutionRules = text(input.resolutionRules, 20, 1200);
  const resolutionSource = text(input.resolutionSource, 5, 400);
  if (typeof input.category !== "string" || !["technology", "science", "community"].includes(input.category)) throw new MemberError("invalid_market_terms");
  // Explicit UTC only. Reject normalized invalid dates, including February 30.
  if (typeof input.closesAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.closesAt)) throw new MemberError("invalid_market_deadline");
  const closesAt = new Date(input.closesAt);
  if (!Number.isFinite(closesAt.getTime()) || closesAt.toISOString().replace(".000Z", "Z") !== input.closesAt) throw new MemberError("invalid_market_deadline");
  return { question, description, resolutionRules, resolutionSource, category: input.category, closesAt };
}

export function effectiveMarketStatus(market: { status: string; paused: boolean; closesAt: Date }, now = Date.now()) {
  if (market.status !== "open") return market.status;
  if (market.closesAt.getTime() <= now) return "closed";
  return market.paused ? "paused" : "open";
}
