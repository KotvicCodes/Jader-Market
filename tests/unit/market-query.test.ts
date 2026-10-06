import { describe, expect, it } from "vitest";
import { parseMarketQuery } from "../../src/domain/market-query";

describe("market query boundaries", () => {
  it("bounds untrusted pagination and unknown categories", () => {
    for (const page of ["0", "-3", "1.5", "Infinity", "10001", "not-a-page"]) {
      expect(parseMarketQuery({ page, category: "private" })).toMatchObject({ page: 1, category: "all" });
    }
    expect(parseMarketQuery({ page: "2", category: "science" })).toMatchObject({ page: 2, category: "science" });
  });
  it("trims and limits search text", () => {
    expect(parseMarketQuery({ q: "  launch  " }).query).toBe("launch");
    expect(parseMarketQuery({ q: "a".repeat(1000) }).query).toHaveLength(120);
  });
});
