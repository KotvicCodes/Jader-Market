import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseTrading } from "../../src/domain/trading";
import { requestSummary, ticketRequest, tradingResult } from "../../src/domain/trading-ticket";

const marketId = randomUUID();
const key = randomUUID();
const close = "2035-12-31T12:00:00.000Z";
const fields = { action: "place", quantity: "3", price: "0.2501", outcome: "YES", side: "buy", timeInForce: "GTC" };

describe("participant trading ticket", () => {
  it("converts decimal limits exactly and produces a valid server request", () => {
    const request = ticketRequest(marketId, key, fields, close);
    expect(request.body).toMatchObject({ quantity: "3", price: "2501" });
    expect(parseTrading(request.action, request.body)).toMatchObject({ quantity: 3n, price: 2501n });
    expect(requestSummary(request).join(" ")).toContain("0.7503 credits");
    const low = ticketRequest(marketId, key, { ...fields, price: ".0001", quantity: "1000000" }, close);
    expect(requestSummary(low).join(" ")).toContain("100.00 credits");
  });
  it.each(["1", "1.0", "0", "0.00001", "-0.25", "1e-1", "0,25", " 0.25", "0.25 ", "NaN"])("rejects invalid limit prices: %s", price => {
    expect(() => ticketRequest(marketId, key, { ...fields, price }, close)).toThrow();
  });
  it.each(["0", "01", "1.5", "1000001", "1e3", "-1"])("rejects invalid whole shares: %s", quantity => {
    expect(() => ticketRequest(marketId, key, { ...fields, quantity }, close)).toThrow();
  });
  it("treats datetime-local fields explicitly as UTC and rejects rolled/late/past dates", () => {
    const now = Date.parse("2035-01-01T00:00:00Z");
    const request = ticketRequest(marketId, key, { ...fields, timeInForce: "GTD", expiresAt: "2035-12-31T12:00" }, close, now);
    expect(request.body).toHaveProperty("expiresAt", "2035-12-31T12:00:00Z");
    expect(parseTrading(request.action, request.body, now)).toMatchObject({ expiresAt: new Date(close) });
    for (const expiresAt of ["2035-02-30T12:00", "2035-12-31T12:01", "2034-12-31T12:00", "2035-02-02T12:00Z", ""]) {
      expect(() => ticketRequest(marketId, key, { ...fields, timeInForce: "GTD", expiresAt }, close, now)).toThrow();
    }
  });
  it("explains mint/burn backing and sell reservations without guaranteeing a fill", () => {
    for (const action of ["mint", "burn"] as const) {
      const request = ticketRequest(marketId, key, { action, quantity: "3" }, close);
      expect(parseTrading(action, request.body)).toMatchObject({ quantity: 3n });
      expect(requestSummary(request).join(" ")).toContain("3.00 credits");
    }
    const summary = requestSummary(ticketRequest(marketId, key, { ...fields, side: "sell", timeInForce: "IOC" }, close)).join(" ");
    expect(summary).toContain("Reserve 3 owned YES shares");
    expect(summary).toContain("Minimum proceeds if fully filled: 0.7503 credits");
    expect(summary).toContain("cancel any remainder");
    expect(summary).toContain("Matching may be partial or absent");
  });
  it("reports partial fills, self-trade prevention and cancellation races truthfully", () => {
    const request = ticketRequest(marketId, key, fields, close);
    const order = { id: key, quantity: "3", remaining: "1", status: "open" };
    expect(tradingResult(request, { order })).toContain("2 of 3 shares filled; 1 remain open and reserved");
    expect(tradingResult(request, { order: { ...order, status: "cancelled", reason: "self_trade" } })).toContain("Matching your own order is prevented");
    expect(tradingResult({ action: "cancel", body: { marketId, operationKey: randomUUID(), orderId: key } }, { order: { ...order, status: "filled", remaining: "0" } })).toContain("completed before cancellation");
    expect(() => tradingResult(request, { order: { ...order, id: randomUUID() } })).toThrow();
    expect(() => tradingResult(request, { order: { ...order, remaining: "4" } })).toThrow();
  });
});
