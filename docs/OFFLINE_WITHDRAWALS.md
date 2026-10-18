# Reserved offline withdrawals

Apply migration **0006** with `npm run db:migrate` while the app/worker are stopped, then restart them. Existing credit balances, trading reservations and historical confirmed offline debits are preserved. New direct `offline_debit` adjustments are rejected by the application and database. Confirmed incoming credits and explicitly audited balance corrections remain available in `/admin`.

This workflow records and reserves internal credits. It does not send payments, verify an external provider, set a currency conversion rate or establish production readiness. Agree payment/redemption terms and verify payment instructions privately before using it. Do not store bank account details in references or notes.

## Participant workflow

1. Open `/portfolio` → **Offline withdrawals** (`/withdrawals`).
2. Enter an amount in credits and confirm the reservation. The amount moves from available credits to a separate withdrawal reservation in the same database transaction. Trading, another withdrawal and administrator corrections cannot spend it.
3. While the request is **requested**, cancel it with a reason to return the credits.
4. Once the administrator starts processing, the request stays reserved until the administrator records payment or verifies that no payment was sent. There is no automatic expiry or participant cancellation during processing.
5. Review status and private history on `/withdrawals`. The portfolio separates order reservations from withdrawal reservations and records completed withdrawal debits.

There may be at most 20 active requests per account. Lists are paginated in pages of 20. Request and payment references are private to the account owner and authorized administrator.

## Administrator workflow

Open `/admin` → **Offline withdrawals** (`/admin/withdrawals`). Administrator MFA and authentication within the last 10 minutes are required. Active requests appear by default; **All requests and history** also includes completed/cancelled requests. Suspended participants retain their reservations, and the administrator can reconcile their existing requests.

| State | Allowed action | Accounting effect |
| --- | --- | --- |
| requested | Start payment processing, administrator only | No balance change; funds stay reserved |
| requested | Cancel with a reason, owner or administrator | Reserved credits return to available credits |
| processing | Confirm completed payment with a unique opaque reference, administrator only | Reserved credits leave the participant balance through a balanced debit to issuance |
| processing | Verify that no payment was sent and none is pending, then release with a verification note, administrator only | Request is permanently cancelled; credits return to available credits |
| paid / cancelled | Read history | Terminal; cannot reopen or debit/release again |

**Before sending money:** start processing and reload/verify the saved processing state. Use the withdrawal's full reference to find the corresponding entry in your private external payment records. Check those records before every transfer. The app cannot prevent you from manually sending an external transfer twice.

**After sending money:** independently verify completion, then record its unique payment reference. References are unique across completed withdrawals. A duplicate reference is rejected while the later request remains reserved; reconcile externally instead of inventing a different reference.

**If any response or external result is uncertain:** refresh the saved request/history and reconcile the external payment record. Do not send another transfer. Keep the request processing while any transfer is pending or ambiguous. Release only after independently verifying that nothing was sent and nothing remains pending. The verification note is retained in append-only private history and is visible to the participant.

A failed application transaction leaves the request, journals and reservations unchanged. Restarting the app or worker does not release uncertain requests. The maintenance worker does not process withdrawals or send payments.

## API and safety boundaries

`POST /api/withdrawals/:action` supports `request`, `start`, `pay`, `cancel` and `release`. All calls require an authenticated session, exact `Origin`, JSON, the session's `X-CSRF-Token`, and `confirmed: true`. Existing mutation rate/body limits apply. Responses are private and `no-store`.

- `request`: `{ operationKey: UUID, amount: "12.3456", confirmed: true }`. Ownership comes from the session. The request ID equals the operation key.
- Other actions: `{ id: UUID, previousOperationId: UUID, operationKey: UUID, confirmed: true }`. Use the latest saved `lastOperationId` as `previousOperationId`.
- `pay` also requires `reference` (3–120 trimmed characters).
- `cancel` and `release` require `note` (20–400 trimmed characters). `release` additionally requires `verifiedNotSent: true`.

Financial response quantities are decimal strings in **ticks** (10,000 per credit). An identical retry returns its original immutable response; a changed request using the same key conflicts. An old response may describe an earlier state: reload history to determine the current state before handling a payment. Stale transitions are rejected. Every retry rechecks the account/session and required administrator authority.

The workflow shares the existing cross-process financial lock with trading, credit adjustments, suspension and settlement. Database guards enforce transitions, immutable request identity/history, valid actor roles, exact two-entry journal shapes and equality between withdrawal reservations and outstanding requests. New withdrawal journals delegate to those guards while existing trading/administrator journal verification remains enabled. Balance-changing actions emit owner-scoped portfolio invalidations in the transaction.

The current release provides server-rendered pages with explicit reload/navigation; live event delivery remains separate work. Test the actual deployment's TLS/proxy, restricted database role, backup/restore and operator procedures before any real-value pilot.

## Verification

Use a dedicated disposable PostgreSQL database ending in `_test`; the test role needs `CREATEDB`. Never point tests at a community database.

```sh
npm run verify
npm run test:integration
npm run test:http
```

Withdrawal tests cover upgrades with historical offline debits, concurrent retries, withdrawal/trading overspending races, owner isolation, recent administrator authentication, cancellation, suspended-owner completion, duplicate payment references, explicit unpaid verification, rollback, request limits, pagination and database tampering. The production HTTP suite exercises the private pages, queue, CSRF/origin checks, payment confirmation and unpaid release.

## Operator reconciliation

Readiness item 5 adds `npm run reconcile` for internal accounting checks and independent external receipt matching. Use the [operator reconciliation runbook](OPERATOR_RECONCILIATION.md) before/after payment batches, after uncertain responses and after each pilot session. Missing external evidence is explicitly incomplete. A sent-but-unconfirmed payment fails reconciliation and must be resolved through verification and the existing confirmation workflow; never resend it to repair an app response.
