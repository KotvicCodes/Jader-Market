# PR #15 review — 18 October 2026

Reviewed PR head `5592fc259f664a01f4eae964efa681abd14b51f1` against base `7dfbada0d5da101269e78a52017ac5780cf0e38f`, including all 26 changed files and the authentication, trading, settlement, reconciliation, worker and runtime-role code used by the new acceptance commands. Fixes are in this review checkout.

On resumption, PR head had advanced to `d56d235c6b6d4182d549b12f9c12544c404b9b57` and its target had changed to `main` at `5ab766f1e5b602e24fe3d2d661ef1b0e66ac3c55`. The additional commit's documentation/evidence and real-worker-heartbeat lifecycle assertion were reviewed and incorporated. The review branch also merges that main revision, resolving four overlapping accessibility conflicts while preserving main's named scroll regions and its pending-request API/test changes. The merge preserves both upstream histories.

The new target also includes inherited deployment/recovery work. The additional review traced the Compose/TLS/network/process configuration, runtime role grants, monitoring, encrypted archive publication and authentication, source release/key binding, immutable-image restore, session revocation, recovery fixtures and operator runbooks. Those paths are covered by the unit/integration/HTTP checks below and the existing upstream review records; a new full Docker deployment/recovery rehearsal was not performed here.

## Findings and fixes

1. **Acceptance deadlines could hang after the subprocess leader exited.** `stop()` returned as soon as `exitCode` or `signalCode` was set, even when descendants still held stdout open. `execute()` waits for `close`, which cannot occur until those pipes close; its timeout therefore never completed. A regression subprocess that exits after spawning a child with inherited stdout reproduced the failure. Cleanup now tracks the actual `close` event and signals the owned process group even after its leader exits. The regression passes with the fix.

2. **Successful commands could leave background descendants running.** `execute()` removed a completed leader from its tracking set without checking its process group. A background child using independent stdio remained alive and escaped later acceptance cleanup. A second regression reproduced that leak. Every command now cleans up its owned group in `finally`; cleanup also sends SIGKILL to remaining group members after the leader closes. The regression passes with the fix. These process-group checks are skipped on Windows, where this implementation does not create POSIX process groups.

3. **Browser settlement checks proved receipt presence, but not the complete expected result.** The old browser assertion accepted any nonempty payout table. It did not check exact balances, payout quantities/amounts, zero-credit receipts or consumed holdings. The workflow now requires seller/buyer balances of 98.50/101.50, zero reservations, no remaining holdings or open orders, exactly two seller receipts and one buyer receipt, two winning shares paying 2.00 per participant, and four losing seller shares paying 0.00. These expectations independently follow from the five-set mint, one-set burn and two-share fill at 0.25.

No application business-logic defect was verified in the changed accessibility code or the exercised financial flows. This review does not establish that every possible input, device or deployment is correct.

## Verification

- TypeScript and ESLint passed.
- All 188 unit/component tests passed after incorporating main, including both new regressions and main's additional recovery cases. Each new subprocess regression was observed failing before its corresponding fix.
- All 130 PostgreSQL integration tests passed in a separately created disposable database container.
- The production build and production HTTP authentication, credit, market, trading, withdrawal, privacy, CSRF and session workflows passed.
- Desktop, mobile/touch and keyboard browser workflows passed with the stricter financial assertions. Axe/reflow, focus, lost-response replay, live updates, worker restart and complete reconciliation passed. The interruption lifecycle check passed on desktop; its two duplicate mobile/keyboard cases are intentionally skipped.
- The interruption lifecycle check was repeated with the final subprocess cleanup implementation.
- The unchanged pilot-load profile passed in 63.048 seconds: 1,200 reads, 120 writes, zero request/sampling errors, p95 reads 32 ms, p95 writes 99 ms and a conservative financial-lock wait bound of 111 ms. Maximum observed heartbeat/settlement/expiry lag was 1,095/1,196/575 ms. All 1,060 fills, 40 payouts, 70 active-market mint operations and both 1,060-share outcome totals matched expectations. Worker restart produced no duplicate payouts and complete reconciliation passed. The [review aggregate](item8-review-load.json) preserves these results separately from the PR's earlier evidence.
- Both the full dependency audit and the production-only audit reported zero known vulnerabilities.

After incorporating the updated PR and main, `npm run verify` and the complete browser suite passed again. The financial services, load driver, metrics and worker are unchanged from the integration/HTTP/load-tested version, so those results were retained rather than repeating the same backend workload.

The environment used Node 22.22.1, npm 11.21.0, PostgreSQL 17.6 and ARM64 Chromium 153.0.8010.0 via the documented executable override. A fresh `npm ci` hit the shared filesystem's space limit; validation reused package files from another checkout whose lockfile is byte-for-byte identical. A clean install is therefore not newly verified here. The first browser launch selected an incompatible local binary; the complete workflows above passed with the ARM64 binary.

Physical devices, Safari/Firefox, assistive technology, public-network/TLS latency and intended deployment-host capacity remain outside this local review. The pre-existing deployment/backup rehearsals were not rerun; the PR's new tooling and its exercised production application paths were the validation target. All review databases used synthetic data and were isolated from the existing development database.
