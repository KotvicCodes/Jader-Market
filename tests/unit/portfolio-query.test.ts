import { describe, expect, it } from "vitest";
import { activityCursor, parsePortfolioQuery, portfolioHref } from "../../src/domain/portfolio-query";
const id = "11111111-1111-4111-8111-111111111111";

describe("independent portfolio history cursors", () => {
  it("preserves microseconds and accepts cursor limits without accepting an owner override", () => {
    const cursor = `2035-01-02T03:04:05.123456Z~shares~${id}`;
    expect(activityCursor(cursor)).toEqual({ at: "2035-01-02T03:04:05.123456Z", source: "shares", id });
    expect(parsePortfolioQuery({ activityBefore: cursor, holdingsBefore: id, fillsBefore: "9223372036854775807", ownerId: id })).toEqual({ activityBefore: cursor, holdingsBefore: id, fillsBefore: "9223372036854775807" });
  });
  it.each(["2035-02-30T00:00:00.000001Z", "2035-01-01T25:00:00.000001Z", "0000-01-01T00:00:00.000000Z", "2035-01-01T00:00:00.001Z"])("rejects invalid or imprecise dates: %s", at => {
    expect(() => activityCursor(`${at}~credit~${id}`)).toThrow();
  });
  it.each(["0", "-1", "01", "1e3", "9223372036854775808", ["1", "2"], ""])("rejects malformed or duplicate cursors: %s", ordersBefore => {
    expect(() => parsePortfolioQuery({ ordersBefore })).toThrow();
  });
  it("changes only the selected section and omits unknown query parameters from links", () => {
    const href = portfolioHref({ ordersBefore: "25", fillsBefore: "10" }, "ordersBefore", "5");
    expect(href).toBe("/portfolio?ordersBefore=5&fillsBefore=10");
    expect(portfolioHref({ ordersBefore: "25", fillsBefore: "10" }, "ordersBefore", null)).toBe("/portfolio?fillsBefore=10");
    expect(portfolioHref({ ordersBefore: "25" }, "ordersBefore", null)).toBe("/portfolio");
    for (const cursor of [`2035-01-01T00:00:00.123456Z~other~${id}`, `2035-01-01T00:00:00.123456Z~shares~${id}~extra`]) expect(() => parsePortfolioQuery({ activityBefore: cursor })).toThrow();
  });
});
