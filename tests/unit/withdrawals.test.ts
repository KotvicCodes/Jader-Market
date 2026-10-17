import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWithdrawal, withdrawalTransition } from "../../src/domain/withdrawals";

const operationKey = randomUUID();
const id = randomUUID();
const previousOperationId = randomUUID();
describe("offline withdrawal policy", () => {
  it("requires explicit confirmation, exact credit amounts and valid request identifiers", () => {
    expect(parseWithdrawal("request", { operationKey, amount: "12.3456", confirmed: true }).amount).toBe(123456n);
    for (const amount of [12, "0", "-1", "1.00001", "1000001"]) expect(() => parseWithdrawal("request", { operationKey, amount, confirmed: true })).toThrow();
    expect(() => parseWithdrawal("request", { operationKey, amount: "1" })).toThrow();
    expect(() => parseWithdrawal("pay", { operationKey, id, confirmed: true, reference: "opaque-reference" })).toThrow();
  });
  it("only permits the documented transitions and keeps uncertain transfers reserved", () => {
    expect(withdrawalTransition("requested", "start", true, false, false)).toBe("processing");
    expect(withdrawalTransition("requested", "cancel", false, true, false)).toBe("cancelled");
    expect(withdrawalTransition("processing", "pay", true, false, false)).toBe("paid");
    expect(withdrawalTransition("processing", "release", true, false, true)).toBe("cancelled");
    for (const action of ["pay", "release", "start"] as const) expect(() => withdrawalTransition("processing", action, false, true, true)).toThrow();
    expect(() => withdrawalTransition("processing", "cancel", false, true, false)).toThrow();
    expect(() => withdrawalTransition("processing", "release", true, false, false)).toThrow();
    expect(() => withdrawalTransition("requested", "pay", true, false, false)).toThrow();
    for (const status of ["paid", "cancelled"] as const) for (const action of ["start", "cancel", "pay", "release"] as const) expect(() => withdrawalTransition(status, action, true, true, true)).toThrow();
  });
  it("bounds private verification details and normalizes the idempotent request", () => {
    const base = { id, operationKey, previousOperationId, confirmed: true };
    expect(parseWithdrawal("pay", { ...base, reference: "  synthetic-transfer-1  " }).reference).toBe("synthetic-transfer-1");
    expect(parseWithdrawal("release", { ...base, note: "Verified the transfer was never sent.", verifiedNotSent: true }).verifiedNotSent).toBe(true);
    for (const note of ["short", "x".repeat(401), "verification\u0000with control character"]) expect(() => parseWithdrawal("release", { ...base, note })).toThrow();
    for (const reference of ["ab", "x".repeat(121), "transfer\nreference"]) expect(() => parseWithdrawal("pay", { ...base, reference })).toThrow();
  });
});
