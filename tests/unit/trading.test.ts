import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { integerString, parseTrading } from "../../src/domain/trading";
const base = { operationKey: randomUUID(), marketId: randomUUID(), quantity: "5", outcome: "YES", side: "buy", price: "2500", timeInForce: "GTC" };

describe("exact trading inputs", () => {
  it("accepts whole shares and bounded integer ticks", () => {
    expect(parseTrading("place", base)).toMatchObject({ quantity: 5n, price: 2500n, expiresAt: null });
    expect(parseTrading("mint", { ...base, quantity: "1000000" })).toMatchObject({ quantity: 1000000n });
  });
  it.each([0, 1, 1.5, "0", "01", "-1", "1.5", "1e3", " 1", "1000001", "99999999999999999999999", null])("rejects malformed or excessive shares: %s", quantity => {
    expect(() => parseTrading("mint", { ...base, quantity })).toThrow();
  });
  it.each(["0", "10000", "10001", "0.25", 2500])("rejects invalid prices: %s", price => {
    expect(() => parseTrading("place", { ...base, price })).toThrow();
  });
  it("requires explicit valid future GTD expiry and rejects expiry on other policies", () => {
    const now = Date.parse("2030-01-01T00:00:00Z");
    expect(parseTrading("place", { ...base, timeInForce: "GTD", expiresAt: "2030-01-02T00:00:00Z" }, now)).toMatchObject({ expiresAt: new Date("2030-01-02Z") });
    for (const expiresAt of [undefined, "2030-02-30T00:00:00Z", "2030-01-01T00:00:00Z", "2030-01-02T00:00:00", "2030-01-02T01:00:00+01:00"]) expect(() => parseTrading("place", { ...base, timeInForce: "GTD", expiresAt }, now)).toThrow();
    expect(() => parseTrading("place", { ...base, expiresAt: "2030-01-02T00:00:00Z" }, now)).toThrow();
  });
  it("rejects unknown order policies, side and outcome", () => {
    for (const change of [{ timeInForce: "market" }, { side: "short" }, { outcome: "MAYBE" }]) expect(() => parseTrading("place", { ...base, ...change })).toThrow();
    expect(() => integerString("10", 9n)).toThrow();
  });
});
