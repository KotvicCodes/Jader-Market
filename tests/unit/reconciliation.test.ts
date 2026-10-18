import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { parseExternalRegister,reconciliationExitCode } from "../../src/domain/reconciliation";

const receipt = () => ({ direction: "incoming",reference: "synthetic-receipt",amount: "10000",journalId: randomUUID() });
const register = () => ({ version: 1,complete: true,reviewedAt: "2026-10-17T12:00:00Z",payments: [receipt()] });

describe("independent external payment evidence",() => {
  it("requires explicit completeness and exact positive integer ticks",() => {
    const input = register();
    expect(parseExternalRegister(input)).toEqual(input);
    expect(parseExternalRegister({ ...register(),payments: [] }).payments).toEqual([]);
    expect(parseExternalRegister({ ...register(),payments: [{ ...receipt(),amount: "10000000000" }] }).payments[0].amount).toBe("10000000000");
  });

  it.each(["0","-1","1.5","01","1e4","10000000001","9007199254740993",10000,null])("rejects ambiguous/out-of-range amounts: %s",amount => {
    expect(() => parseExternalRegister({ ...register(),payments: [{ ...receipt(),amount }] })).toThrow("invalid_external_register");
  });

  it("rejects incomplete, extra-field and malformed evidence without returning its contents",() => {
    for (const input of [null,[],{}, { ...register(),complete: false }, { ...register(),version: 2 },
      { ...register(),reviewedAt: "yesterday" }, { ...register(),reviewedAt: "2026-02-30T12:00:00Z" }, { ...register(),privateNote: "private-synthetic-detail" },
      { ...register(),payments: [{ ...receipt(),journalId: "invalid" }] },
      { ...register(),payments: [{ ...receipt(),withdrawalId: randomUUID() }] },
      { ...register(),payments: [{ direction: "incoming",reference: "ref",amount: "1",withdrawalId: randomUUID() }] },
      { ...register(),payments: [{ ...receipt(),reference: "ref\nprivate-detail" }] },
      { ...register(),payments: [{ ...receipt(),reference: " ref " }] },
      { ...register(),payments: [{ ...receipt(),reference: "xy" }] },
      { ...register(),payments: [{ ...receipt(),direction: "transfer" }] },
      { ...register(),payments: [{ ...receipt(),direction: ["incoming"] }] },
      { ...register(),payments: [{ ...receipt(),accountNumber: "private-synthetic-detail" }] },
    ]) expect(() => parseExternalRegister(input)).toThrow("invalid_external_register");
  });

  it("rejects reused references and case-aliased targets so one transfer cannot clear two records",() => {
    const a = receipt();
    expect(() => parseExternalRegister({ ...register(),payments: [a,{ ...receipt(),reference: a.reference }] })).toThrow();
    expect(() => parseExternalRegister({ ...register(),payments: [a,{ ...a,reference: "other-receipt",journalId: a.journalId.toUpperCase() }] })).toThrow();
    expect(parseExternalRegister({ ...register(),payments: [{ direction: "outgoing",reference: "valid payment / reference",amount: "1",withdrawalId: randomUUID() }] }).payments).toHaveLength(1);
  });

  it("uses different exit codes for clearance, discrepancies and unchecked payments",() => {
    expect([reconciliationExitCode("pass"),reconciliationExitCode("fail"),reconciliationExitCode("incomplete")]).toEqual([0,1,2]);
  });
});
