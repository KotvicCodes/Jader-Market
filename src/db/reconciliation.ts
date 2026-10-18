import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { parseExternalRegister, type ExternalRegister } from "../domain/reconciliation";
import type { Database, Transaction } from "./transaction-lock";
import { assertDatabaseReady } from "./readiness";
import { reconciliationChecks } from "./reconciliation-checks";
import version from "../../package.json" with { type: "json" };

export type ReconciliationCheck = {
  name: string;
  discrepancies: string;
  samples: Record<string, string | null>[];
  truncated: boolean;
};

/** Count every failing row and retain at most 25 deterministic samples in the report. */
async function check(tx: Transaction, name: string, query: SQL): Promise<ReconciliationCheck> {
  const [result] = await tx.execute(sql`
    WITH failures AS MATERIALIZED (${query})
    SELECT count(*)::text AS count, (SELECT coalesce(jsonb_agg(to_jsonb(sample)), '[]'::jsonb)
      FROM (SELECT * FROM failures ORDER BY id,to_jsonb(failures)::text LIMIT 25) sample) AS samples FROM failures`);
  return { name, discrepancies: result.count as string, samples: result.samples as ReconciliationCheck["samples"], truncated: BigInt(result.count as string)>25n };
}

/** Match lifetime receipt evidence in both directions without exposing payment references in failures. */
function externalPayments(register: ExternalRegister) {
  return sql`
    WITH evidence AS (
      SELECT ordinality::text AS evidence_row, p->>'direction' AS direction, p->>'reference' AS reference,
        p->>'amount' AS amount, CASE WHEN p ? 'journalId' THEN 'journal:' || (p->>'journalId')
          ELSE 'withdrawal:' || (p->>'withdrawalId') END AS target
      FROM jsonb_array_elements(${JSON.stringify(register.payments)}::jsonb) WITH ORDINALITY AS input(p,ordinality)
    ), recorded AS (
      SELECT 'journal:' || j.id::text AS target, CASE WHEN j.kind='credit' THEN 'incoming' ELSE 'outgoing' END AS direction,
        j.amount::text AS amount, NULL::text AS reference
      FROM journals j WHERE j.reason IN ('offline_credit','offline_debit') AND j.withdrawal_operation_id IS NULL
      UNION ALL
      SELECT 'withdrawal:' || w.id::text, 'outgoing', w.amount::text, o.reference
      FROM withdrawals w JOIN withdrawal_operations o ON o.withdrawal_id=w.id AND o.action='pay' WHERE w.status='paid'
    )
    SELECT coalesce(r.target,'evidence-row:' || e.evidence_row) AS id, e.evidence_row,
      CASE WHEN r.target IS NULL THEN 'external_payment_not_recorded' WHEN e.target IS NULL THEN 'recorded_payment_not_verified'
        WHEN r.direction<>e.direction THEN 'direction_mismatch' WHEN r.amount<>e.amount THEN 'amount_mismatch' ELSE 'reference_mismatch' END AS problem,
      r.amount AS recorded_amount, e.amount AS verified_amount
    FROM recorded r FULL JOIN evidence e USING(target)
    WHERE r.target IS NULL OR e.target IS NULL OR r.direction<>e.direction OR r.amount<>e.amount
      OR (r.reference IS NOT NULL AND r.reference<>e.reference)`;
}

/**
 * Report accounting discrepancies from one read-only repeatable-read snapshot.
 * A complete pass requires a supplied independent receipt register. The report
 * omits authentication secrets and payment references, performs no repairs and
 * takes no application advisory lock while financial writes continue.
 * @throws If the register, database readiness or query execution is invalid/unavailable.
 */
export async function reconcileDatabase(db: Database, externalInput?: ExternalRegister) {
  const register = externalInput === undefined ? undefined : parseExternalRegister(externalInput);
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '10s'`);
    await assertDatabaseReady(tx);
    const [snapshot] = await tx.execute(sql`SELECT transaction_timestamp() AS at, pg_current_snapshot()::text AS snapshot, current_database() AS database`);
    const snapshotAt = new Date(snapshot.at as string | Date).toISOString();
    if (register && Date.parse(register.reviewedAt)>Date.parse(snapshotAt)) throw new Error("invalid_external_register");
    const checks: ReconciliationCheck[] = [];
    for (const [name, query] of Object.entries(reconciliationChecks)) checks.push(await check(tx,name,query));
    const internalDiscrepancies = checks.reduce((sum,c) => sum+BigInt(c.discrepancies),0n);
    const externalCheck = register ? await check(tx,"external_payments",externalPayments(register)) : undefined;
    if (externalCheck) checks.push(externalCheck);
    const discrepancies = internalDiscrepancies+BigInt(externalCheck?.discrepancies ?? "0");
    const [summary] = await tx.execute(sql`SELECT
      (SELECT count(*)::text FROM ledger_accounts) AS ledger_accounts,
      (SELECT count(*)::text FROM journals) AS journals,
      (SELECT count(*)::text FROM holdings) AS holdings,
      (SELECT count(*)::text FROM orders WHERE status='open') AS open_orders,
      (SELECT count(*)::text FROM market_payouts) AS payout_receipts,
      (SELECT count(*)::text FROM markets WHERE status='settling') AS settling_markets,
      (SELECT count(*)::text FROM withdrawals WHERE status='requested') AS requested_withdrawals,
      (SELECT count(*)::text FROM withdrawals WHERE status='processing') AS processing_withdrawals,
      (SELECT coalesce(sum(amount),0)::text FROM journals WHERE reason='offline_credit') AS recorded_incoming,
      (SELECT coalesce(sum(amount),0)::text FROM journals WHERE reason='offline_debit' OR (reason='withdrawal' AND kind='debit')) AS recorded_outgoing`);
    return {
      reportVersion: 1, applicationVersion: version.version, snapshotAt, snapshot: snapshot.snapshot as string,
      database: snapshot.database as string, amountUnit: "ticks (10000 per credit)",
      status: discrepancies>0n ? "fail" as const : register ? "pass" as const : "incomplete" as const,
      internalStatus: internalDiscrepancies>0n ? "fail" : "pass",
      externalStatus: externalCheck ? BigInt(externalCheck.discrepancies)>0n ? "fail" : "pass" : "not_checked",
      externalEvidence: register ? { reviewedAt: register.reviewedAt, paymentCount: register.payments.length,
        sha256: createHash("sha256").update(JSON.stringify(register)).digest("hex") } : null,
      discrepancies: discrepancies.toString(), summary, checks,
      action: discrepancies>0n ? "Stop external payments and new credit issuance. Follow docs/OPERATOR_RECONCILIATION.md before resuming."
        : !register ? "Internal checks passed. Verify external payments with an independent complete receipt register before payment clearance."
        : "Checks passed for this snapshot and supplied evidence. Preserve the report and follow the payment runbook.",
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
