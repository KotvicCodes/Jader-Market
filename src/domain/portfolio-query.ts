import { MemberError } from "./identity";

export const portfolioSections = ["holdingsBefore", "ordersBefore", "fillsBefore", "activityBefore", "payoutsBefore"] as const;
export type PortfolioSection = typeof portfolioSections[number];
export type PortfolioQuery = Partial<Record<PortfolioSection, string>>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function activityCursor(input: string) {
  const [at, source, id, extra] = input.split("~");
  if (extra !== undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at ?? "") || !["credit", "shares"].includes(source) || !uuid.test(id ?? "")) throw new MemberError("invalid_request");
  const date = new Date(at);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.toISOString() !== `${at.slice(0, 23)}Z`) throw new MemberError("invalid_request");
  return { at, source, id };
}

export function parsePortfolioQuery(input: Record<string, unknown>): PortfolioQuery {
  const query: PortfolioQuery = {};
  for (const key of portfolioSections) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value || value.length > 100) throw new MemberError("invalid_request");
    if (key === "activityBefore") activityCursor(value);
    else if (key === "holdingsBefore") { if (!uuid.test(value)) throw new MemberError("invalid_request"); }
    else if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) throw new MemberError("invalid_request");
    query[key] = value;
  }
  return query;
}

export function portfolioHref(query: PortfolioQuery, section: PortfolioSection, cursor: string | null) {
  const params = new URLSearchParams();
  for (const key of portfolioSections) {
    const value = key === section ? cursor : query[key];
    if (value) params.set(key, value);
  }
  return `/portfolio${params.size ? `?${params}` : ""}`;
}
