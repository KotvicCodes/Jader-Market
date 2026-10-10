import { describe, expect, it } from "vitest";
import { effectiveMarketStatus, marketRevision, parseMarketTerms } from "../../src/domain/market-admin";

const terms = { question: "Will the fictional launch happen?", description: "A synthetic test question.", resolutionRules: "Resolve YES only on a verified launch, otherwise NO.", resolutionSource: "Fictional launch record", category: "technology", closesAt: "2035-12-31T12:00:00Z" };

describe("market terms and deadlines", () => {
  it("trims terms and validates bounded, explicit UTC deadlines", () => {
    expect(parseMarketTerms({ ...terms, question: ` ${terms.question} ` }).question).toBe(terms.question);
    for (const closesAt of ["2035-02-30T12:00:00Z", "2035-12-31T12:00", "2035-12-31T12:00:00+01:00", "invalid"]) expect(() => parseMarketTerms({ ...terms, closesAt })).toThrow();
    for (const value of [{ question: "short" }, { resolutionRules: "vague" }, { category: "other" }, { description: "x".repeat(601) }, { question: "a\u0000broken question" }]) expect(() => parseMarketTerms({ ...terms, ...value })).toThrow();
  });
  it("rejects missing, malformed, and unbounded revisions", () => {
    expect(marketRevision("4")).toBe(4);
    for (const revision of [undefined, "", "1e2", " 2", -1, 1.5, 2_000_000_001]) expect(() => marketRevision(revision)).toThrow();
  });
  it("closes exactly at the deadline even when paused and preserves terminal statuses", () => {
    const market = { status: "open", paused: false, closesAt: new Date(1000) };
    expect(effectiveMarketStatus(market, 999)).toBe("open");
    expect(effectiveMarketStatus({ ...market, paused: true }, 999)).toBe("paused");
    expect(effectiveMarketStatus({ ...market, paused: true }, 1000)).toBe("closed");
    expect(effectiveMarketStatus({ ...market, status: "resolved" }, 1000)).toBe("resolved");
  });
});
