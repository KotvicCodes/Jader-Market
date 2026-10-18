# Operator reconciliation

Readiness item 5 is implemented in version 0.1.12, stacked on PR #11. The trusted-host command checks accounting and compares independently verified external receipts without changing the database. Deployment, backup/recovery, browser and load acceptance remain launch gates.

## Run and preserve a report

Use the pinned Node.js version and an installed checkout with current migrations. `DATABASE_URL` selects the database. The command needs SELECT on application tables and `drizzle.__drizzle_migrations`, plus schema USAGE; it does not need `AUTH_SECRET`, an application login, database ownership or write privileges. Use a dedicated operator/read-only connection when available. This does not provision the production roles required by item 6.

```sh
npm run reconcile -- --help
npm run reconcile
```

The second command checks internal accounting, prints JSON, and exits **2** when internal checks pass because external payments have not been checked. For a complete reconciliation, supply the private independent register described below. To save machine-readable JSON without npm's script banner, use npm's silent option:

```sh
umask 077
mkdir -p exports
npm run --silent reconcile -- --external-register /private/market-receipts.json > exports/reconciliation.json
```

Check the process exit status and report `status`; a file being created does not mean reconciliation succeeded. Shell redirection can create an empty file when input, connection, schema or query execution fails. Reports identify the database, app version, snapshot timestamp/identifier and normalized register SHA-256. Keep the report, matching register and supporting receipts together in protected operator storage. Never commit real registers, reports or payment evidence.

Exit codes:

- **0 — pass:** internal checks and the supplied complete external register match this snapshot.
- **1 — fail:** discrepancies exist, including an externally sent payment without a recorded confirmation or a recorded payment without external evidence.
- **2 — incomplete:** internal checks pass, but no external register was supplied. This is useful for routine internal checks and provides no external-payment clearance.
- **3 — unavailable:** invalid arguments/register, missing configuration/migrations/guards, query timeout, or another execution failure. No report or clearance is issued; stderr contains a generic message without driver details or input contents.

Each check reports the exact number of failing rows as a decimal string, at most 25 deterministic samples, and a `truncated` flag. The overall discrepancy count sums failed checks; one incident can fail several checks. All money, share quantities and aggregate counts stay exact decimal strings. Samples contain record IDs and accounting facts, not handles, credentials, free-text notes or payment references. Reports still contain private financial information and need restricted access. Null sample values identify missing records.

## What is checked

Every query runs in one read-only repeatable-read transaction. Trading and worker commits cannot mix states within the report. The command takes no financial write lock and performs no repairs. Each statement has a 30-second timeout; inability to finish causes exit 3 rather than a partial pass. Run at a suitable operator interval for the database size; this is a full-history scan, not a browser polling endpoint.

Checks cover:

- Required wallet/reserved accounts and issuance account; accounting record links, including missing users, markets and withdrawal parents.
- Account balances against ledger entries; journal balance, amount and source/destination accounts.
- Holdings against available/reserved share movements; complete-set mint/burn evidence; movement signs, operation kinds and fill/payout links independently of current totals.
- Open buy-order credit reservations and open sell-order share reservations, including missing accounts/holdings. Expired orders still stored as open retain their reservation until maintenance releases it.
- Requested/processing withdrawal reservations and complete withdrawal transition/journal history.
- Placement operations against durable orders, order quantities against fills, maker/taker sequence and operation identity, and fill credit/share transfers. Open orders on explicitly closed/synthetic markets or suspended accounts fail; elapsed deadlines and order expiry can await normal maintenance with their reservations intact.
- Per-market escrow against outstanding YES/NO supply. Unresolved pairs require 10000 ticks collateral per pair. During settlement, remaining winning shares require 10000 ticks each, losing shares zero, and invalid-result shares 5000 ticks each.
- Resolution lifecycle, payout amounts, journals and consumed shares, including zero-credit losing receipts and partial payout batches. A valid unfinished settlement is reported in the summary and can pass accounting checks; this is not a worker health check.
- Payment-reference uniqueness and external payment matching.

Required migration/schema/trigger readiness must pass first. The command does not certify all database constraints or detect an attacker rewriting every matching source record consistently. It also does not certify worker progress, bank-account solvency, payment authenticity or correct market resolution. Those require independent evidence and the remaining operational gates.

## Independent external receipt register

Prepare a UTF-8 JSON file from independently verified bank/cash/payment records. This must cover **all confirmed incoming and sent outgoing marketplace transfers since inception** that belong to this database. Do not create it by exporting the app's journals and treating that as payment evidence. Do not include pending/unverified incoming transfers as confirmed receipts. An explicitly complete empty register is valid for a database with no external transfers.

Stop new offline-credit posting and external-payment processing while assembling the register and running the report. Trading can continue because it does not change the external-transfer register. Resolve in-flight payment uncertainty independently before claiming the register is complete. Resume payment processing only after interpreting the report and any outstanding `processing` withdrawals.

```json
{
  "version": 1,
  "complete": true,
  "reviewedAt": "2026-10-17T12:00:00Z",
  "payments": [
    {
      "direction": "incoming",
      "reference": "synthetic-receipt-001",
      "amount": "250000",
      "journalId": "11111111-1111-4111-8111-111111111111"
    },
    {
      "direction": "outgoing",
      "reference": "synthetic-payment-001",
      "amount": "100000",
      "withdrawalId": "22222222-2222-4222-8222-222222222222"
    }
  ]
}
```

The IDs and references above are synthetic. Each row uses exactly one target: `journalId` for an incoming `offline_credit` journal or historical direct `offline_debit`; `withdrawalId` for a current outgoing withdrawal. Amounts are positive integer **ticks**, 10000 per credit, using the agreed offline currency/credit conversion. Confirm the intended account/recipient independently when mapping each receipt to its target ID. Incoming journal references were not stored by the application, so their authenticity and mapping require this operator verification. Demo grants and corrections are not external receipts; independently investigate any correction affecting real-value backing.

References are trimmed strings of 3–120 characters without control characters. Use opaque identifiers, not personal bank details. A reference cannot be reused within one direction; a target cannot be reused at all, including UUID case aliases. For paid withdrawals the supplied reference must exactly match the administrator's stored payment confirmation. Amount, direction, missing evidence and unexpected external payments are checked in both directions. A sent payment targeting a still-processing/cancelled/unknown withdrawal fails as `external_payment_not_recorded`; it is never silently treated as paid. An outgoing legacy journal cannot substitute for a current withdrawal confirmation.

For a confirmed incoming transfer not yet posted, keep it unspendable and account for it in the operator's exception queue until independently verified and posted once. Do not omit a sent outgoing payment simply because the app has no confirmation. The register accepts at most 100000 rows; the CLI file limit is 16 MiB. Larger installations need a deliberately designed streaming/scoped workflow; do not truncate lifetime history to obtain a pass. `reviewedAt` must be a UTC ISO timestamp no later than the database snapshot. It records the operator's review time; it does not filter database history.

Use the private administrator history and trusted-host SELECT queries to identify application records. For example:

```sql
SELECT id, recipient_id, kind, reason, amount, created_at
FROM journals WHERE reason IN ('offline_credit', 'offline_debit')
ORDER BY created_at, id;

SELECT w.id, w.owner_id, w.amount, w.status, o.reference
FROM withdrawals w
LEFT JOIN withdrawal_operations o ON o.withdrawal_id = w.id AND o.action = 'pay'
ORDER BY w.created_at, w.id;
```

These queries index application assertions; they do not establish that money moved. Compare each record with the independent receipt and intended recipient. Retain protected receipt evidence alongside the register digest. The command makes no network requests to a bank and imports no financial writes.

## Payment and incident procedure

Run reconciliation after every pilot session, before a payment batch, after recording the batch, after uncertain responses, and after restoring a backup. A full pass is evidence about that snapshot and supplied register, not permission to skip verification for the next payment.

1. **Before sending:** obtain a full report, inspect processing withdrawals, and independently verify that the intended withdrawal has not already been paid. Follow the reserved-withdrawal workflow; transition to processing before sending. An internal-only pass is insufficient for payment clearance.
2. **After sending:** independently confirm the external transfer, record the exact reference through the existing administrator workflow, add the receipt to the register, and reconcile again. If the app response is lost, inspect durable state and retry the same saved operation. Never resend the external transfer to repair a lost app response.
3. **On discrepancy or unavailable reconciliation:** stop external payments and new credit issuance immediately. Preserve the report/register/evidence, record an incident and identify affected IDs. If accounting integrity is uncertain, take the app out of service or pause affected markets and stop the worker while investigating; preserve the database before any recovery action. The command itself does not enforce a payment freeze.
4. **Investigate:** distinguish a genuinely incorrect register, a transfer in flight, a missing app confirmation, and a database mismatch. Correct mistaken evidence from original receipts. For sent-but-unconfirmed payments, verify the transfer and use the existing exact confirmation/retry workflow once. For uncertain processing withdrawals, keep funds reserved; release only after independently verifying no payment was sent. Do not invent a matching reference, omit evidence, or use a credit correction to hide a discrepancy.
5. **Recover deliberately:** escalate accounting corruption to the trusted operator. Do not edit balances, disable guards, rewrite journals or run an automatic repair. Preserve evidence and use a reviewed recovery/forward-repair procedure. A mismatch cannot be resolved merely by rerunning this command.
6. **Before resuming:** obtain a complete pass against the corrected independent register, resolve payment uncertainty, document the cause and actions, and explicitly record the operator's resume decision. Rehearse this process with fictional credits first. Item 7 still requires a proven restore/incident procedure.

This closes the reconciliation-tooling segment. It does not merge/deploy the feature stack or satisfy deployment, recovery, browser/load acceptance or real-money operating terms.
