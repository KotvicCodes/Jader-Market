export type PaymentEvidence = {
  direction: "incoming" | "outgoing";
  reference: string;
  amount: string;
  journalId?: string;
  withdrawalId?: string;
};

export type ExternalRegister = {
  version: 1;
  complete: true;
  reviewedAt: string;
  payments: PaymentEvidence[];
};

/**
 * Validate a complete lifetime receipt register and normalize its target UUIDs.
 * The operator must independently verify transfers; parsing does not establish
 * payment authenticity or correct recipient mapping.
 * @throws An error with the fixed message invalid_external_register for invalid evidence.
 */
export function parseExternalRegister(input: unknown): ExternalRegister {
  const invalid = () => { throw new Error("invalid_external_register"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !["version", "complete", "reviewedAt", "payments"].includes(key)) ||
    value.version !== 1 || value.complete !== true || typeof value.reviewedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.reviewedAt) ||
    !Number.isFinite(Date.parse(value.reviewedAt)) || !Array.isArray(value.payments) || value.payments.length > 100_000) return invalid();
  if (new Date(value.reviewedAt).toISOString().replace(".000Z","Z")!==value.reviewedAt.replace(".000Z","Z")) return invalid();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const references = new Set<string>(), targets = new Set<string>();
  const payments: PaymentEvidence[] = value.payments.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some(key => !["direction", "reference", "amount", "journalId", "withdrawalId"].includes(key)) ||
      (row.direction !== "incoming" && row.direction !== "outgoing") ||
      typeof row.reference !== "string" || row.reference.length<3 || row.reference.length>120 ||
      row.reference!==row.reference.trim() || /[\u0000-\u001f\u007f]/.test(row.reference) ||
      typeof row.amount !== "string" || !/^[1-9]\d{0,10}$/.test(row.amount) || BigInt(row.amount) > 10_000_000_000n ||
      (row.journalId === undefined) === (row.withdrawalId === undefined) ||
      (row.direction === "incoming" && row.journalId === undefined)) return invalid();
    const target = row.journalId ?? row.withdrawalId;
    if (typeof target !== "string" || !uuid.test(target)) return invalid();
    const key = `${row.journalId ? "journal" : "withdrawal"}:${target.toLowerCase()}`;
    const referenceKey = `${row.direction}:${row.reference}`;
    if (references.has(referenceKey) || targets.has(key)) return invalid();
    references.add(referenceKey); targets.add(key);
    return { direction: row.direction as PaymentEvidence["direction"], reference: row.reference, amount: row.amount,
      ...(row.journalId ? { journalId: target.toLowerCase() } : { withdrawalId: target.toLowerCase() }) };
  });
  return { version: 1, complete: true, reviewedAt: value.reviewedAt, payments };
}

/** Map complete, discrepant and internally clean but unchecked reports to CLI exit codes 0, 1 and 2. */
export function reconciliationExitCode(status: "pass" | "fail" | "incomplete") {
  return status === "pass" ? 0 : status === "fail" ? 1 : 2;
}
