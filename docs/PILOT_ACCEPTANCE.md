# Browser and pilot-load acceptance — readiness item 8

Version 0.1.15 adds repeatable desktop, touch/mobile-viewport and keyboard browser workflows plus a measured synthetic pilot workload. All rehearsals create fresh PostgreSQL containers, random credentials, isolated owner/runtime connections, a production Next.js server and a loopback-only proxy. They never read the development database or accept a production target URL. No external transfer is made.

The user-approved initial profile is 20 participants, 10 concurrent active users and at least 1,000 historical trades. Acceptance gates are p95 reads below 1 second, p95 writes below 2 seconds, financial-lock waits below 500 ms, no unexpected request errors and worker lag below 5 seconds. This establishes evidence for the measured workload and machine. Repeat the same disposable rehearsal on the intended deployment host; it does not certify an arbitrary host or larger pilot.

## Run the checks

Use the pinned Node/npm versions, Docker with PostgreSQL 17.6 available, and sufficient free disk space. Install dependencies and build the production artifact first:

```sh
npm ci
npm run build
npx playwright install --with-deps chromium
npm run test:browser
npm run test:load
```

CI runs both checks after the existing unit/integration/build/HTTP checks. Browser fixtures have three independent cookie/storage contexts for the administrator, seller and buyer. The default suite runs all projects serially; `npm run test:browser -- --project keyboard` selects one project for diagnosis. A failed assertion, unexpected browser exception, reconciliation discrepancy or load gate exits nonzero. SIGINT/SIGTERM closes managed subprocess groups, the app/worker and the owned database, including interruption during startup. Docker subprocesses have a 60-second deadline and the browser CLI has a ten-minute deadline, followed by a bounded termination grace period. Cleanup attempts every resource even if one removal fails; force-kill or host failure can still require private cleanup of the exact owned synthetic resources. Browser failure output contains only synthetic fixture details. Traces, screenshots and videos are disabled; preserve no real credentials or private data in browser artifacts. Generated test files under `.cache/` remain untracked.

For interactive rehearsal with the shared browser, run `npm run test:browser -- --preview`. It prints a loopback URL and fictional administrator login. Stop it with Ctrl-C/SIGTERM when finished; that closes the app/worker and removes its own database and anonymous volume. Desktop tests use 1440×900, mobile uses 390×844 with touch/mobile emulation, and the keyboard project uses 1280×800. Mobile actions use taps and the test requires recorded touch events. A separate desktop-only lifecycle test waits for a successful real worker heartbeat, interrupts an active harness subprocess and verifies that its app, database, directory and subprocess descendant stop. This tests Chromium and mobile layout/input emulation; it is not a claim that physical iOS Safari or every browser/assistive technology has been tested.

The normal Playwright installer supplies CI's browser. On the local ARM64 host its CDN required network approval, so the local rehearsal uses maintained Chromium 153 from the Sparticuz GitHub release, selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. That override is for an independently installed trusted local browser, not a shipped binary or production dependency. CI uses Playwright's pinned browser build. Review browser installation/version differences when comparing results.

## Browser coverage

Each project exercises the same administrator and two-participant flow through visible controls:

1. Sign-in errors announce feedback and move focus to it; the keyboard project follows the skip link to the main landmark, reaches controls with Tab, changes selections with keys and activates controls without pointer clicks.
2. The administrator signs in, enrolls MFA, creates two participants, grants fictional credits, creates a draft, reviews its saved terms and publishes it.
3. The seller mints five complete sets. The harness deliberately loses the response **after the server commits**. The seller retries the saved request through the UI, receives the saved result and continues without spending twice. The seller burns one set and posts a three-share ask; the buyer fills two shares and the seller sees the automatic partial-fill update and cancels the remainder.
4. The administrator pauses and resumes the market; the participant page observes the change and removes/re-enables the ticket. The seller reserves and cancels an offline withdrawal without sending money.
5. The buyer leaves a bid, the administrator closes the market, reservations are released, the administrator records YES with public evidence, and both participants see private payout receipts and no remaining orders. The seller signs out all sessions.
6. The runner restarts the real worker, requires a fresh successful heartbeat after removing the stopped worker's status, verifies that existing receipts do not increase, and runs complete reconciliation with an empty external register appropriate to these fictional demo grants and cancelled withdrawals.

Axe checks WCAG A/AA rules on sign-in, administration, trading, withdrawals and both portfolios, and each checked page must fit the viewport horizontally. Tables may scroll inside their own container. The suite captures hydration/runtime exceptions. Scrollable tables are reachable with Tab and have visible focus outlines. Form feedback and the main landmark now accept programmatic focus; trading review already moves focus before confirmation. These automated checks complement manual screen-reader and physical-device review.

## What the load run measures

The history fixture uses normal guarded application services to create **1,000 genuine matched fills**, 2,000 order submissions, funded collateral, holdings, journal/entry history and participant portfolios. It does not bulk-insert fabricated balanced projections or disable guards. All 20 participants have funded fictional accounts. Authentication/session fixtures are created outside the measured window; sign-in and MFA are covered separately by the browser suite.

The measured window has ten concurrent virtual users rotating over twenty accounts for sixty rounds with one second of think time. Each round reads an authoritative market snapshot and a private portfolio. Every fifth round performs a financial write, alternating minting and buy orders matched against funded resting asks. The expected totals are 1,200 completed reads, 120 completed writes and 60 additional fills. Persisted state must also contain all 70 active-market mint operations (ten fixture mints plus sixty measured mints) and exactly 1,060 shares of each outcome; HTTP 200 responses alone cannot satisfy the write gate. Requests use the actual HTTP mutation/CSRF/account-binding paths, normal runtime permissions and unchanged rate limits. Response timing includes the loopback proxy, server work and reading the full response body. There are no automatic request retries or omitted failing samples.

Measured reads must return HTTP 200 JSON with `Cache-Control: no-store` and pass the application's complete snapshot validation for the expected participant and CSRF session. Empty or malformed snapshots, anonymous market data, another account/session, redirects and cacheable responses count as unexpected errors. JSON decoding and validation are included in read timing. A fault injection replacing all 1,200 reads with empty HTTP 200 JSON reproduced a false pass in the earlier runner; the corrected runner rejects those responses while retaining every financial and capacity gate.

Measured writes must also return HTTP 200 JSON with `Cache-Control: no-store`, without a followed redirect, and pass the trading UI's result validation against the submitted request. Mint acknowledgements must match the operation reference, action and quantity; order results must match the submitted reference and contain usable order state and quantities. JSON decoding and validation are included in write timing. Persisted accounting checks remain independent: a fault injection that committed every real write but replaced all 120 results with empty HTTP 200 JSON previously passed every gate. The corrected runner reports 120 unexpected errors and fails this same fault even though exact holdings, fills, payouts and reconciliation still pass.

The real worker runs alongside those requests. Forty holding payouts require multiple bounded passes, and a timed order expires during the window. Sampling observes heartbeat age, oldest unprocessed settlement and overdue expiry. A final check requires 40 payout receipts, the settled market's terminal state, the expired order and complete accounting reconciliation. A worker restart must preserve the receipt count.

The trusted database observer samples waiting financial advisory locks and private worker/queue health every 50 ms. Reported lock ages come from PostgreSQL `pg_locks.waitstart`, not total transaction latency. The lock gate uses a conservative bound: maximum observed wait plus the largest monotonic interval between lock observations plus the full observed range of database/driver clock offsets. Subsecond clock changes therefore count against the 500 ms gate even below the separate one-second clock-discontinuity limit. A missed/slow sample therefore cannot silently improve the result. Sampling failures, worker failures/missing status and clock drift between the database wall clock and the driver's monotonic clock fail acceptance. An abrupt clock step is invalid measurement evidence and needs time synchronization and a new run; do not loosen a capacity threshold to hide it.

The aggregate `.cache/load-acceptance.json` records the application version, timestamp, workload, OS/architecture/Node/CPU/RAM, actual duration/counts, p95 timings, lock observations and bound, worker/settlement/expiry lag, errors, fill/receipt counts, restart result and reconciliation status. It contains no account IDs, cookies, authentication keys or payment references. A previous result is removed before a new run. Preserve the final passing aggregate in the private release record along with source commit and image identity. Fixture creation and final reconciliation are outside the HTTP latency window.

## Recorded local result

All three local browser projects and the interrupted-harness lifecycle test passed, followed by worker-restart and complete synthetic reconciliation checks. A fault-injection run replaced mint responses with HTTP 200 without persisting writes: the original acceptance script incorrectly passed; the reviewed gate rejected the missing sixty mints while reconciliation alone still passed. Type checking, lint, 184 unit/component tests, 130 PostgreSQL integration tests, the production build and production HTTP workflows also passed.

The later [write-response review](acceptance/pr15-write-response-review.md) independently verified 221 unit/component tests, 130 PostgreSQL integration tests, the HTTP/browser workflows, a fresh production Docker build and both deployment/recovery rehearsals. Its [retained aggregate](acceptance/item8-write-response-review-load.json) records 1,200 validated reads and 120 validated writes with zero errors, p95 read/write timings of 32/114 ms, and a 151 ms conservative financial-lock wait bound. All exact financial, restart and reconciliation gates passed; the full-profile empty-write-acknowledgement fault correctly failed.

The [retained aggregate](acceptance/item8-local-load.json) records a passing 62.06-second run on 2026-10-18: Linux ARM64, Node 22.22.1, 10 reported logical CPUs and 8.45 GB reported RAM on the shared development host. It completed 1,200 reads, 120 writes and 60 additional fills after the 1,000-fill history fixture, with zero request or sampling errors.

| Gate | Agreed limit | Local result |
| --- | --- | --- |
| p95 reads | <1,000 ms | 27 ms |
| p95 writes | <2,000 ms | 86 ms |
| Financial lock wait, conservative bound | <500 ms | 133 ms (52 ms observed; 80 ms largest monotonic sample gap; 2 ms clock-offset range; values rounded independently) |
| Maximum observed heartbeat age | <5,000 ms | 1,099 ms |
| Maximum observed settlement lag | <5,000 ms | 1,168 ms |
| Maximum observed expiry lag | <5,000 ms | 722 ms |
| Unexpected errors | 0 | 0 |
| Accounting / payout replay | Pass | Complete reconciliation; 40 receipts; no duplicates after restart |

This result includes only 2 ms of measured database/driver clock-offset variation. A prior run detected a clock discontinuity and correctly failed its measurement gates; it was not counted as a pass. Thresholds were retained. The shared-host result is evidence for this profile; preserve a new result from the intended host before capacity sign-off.

## Host acceptance and resume decision

Run the disposable profile on the intended host while recording other workloads, CPU/memory/disk constraints, PostgreSQL/image versions and network topology. Keep the real application/data isolated from these containers. Confirm the measured profile and limits match the proposed cohort and behavior, then record the operator's explicit acceptance. A one-minute run is an initial sustained rehearsal, not a multi-day soak or evidence for unlimited bursts/history growth. HTTP timings are loopback timings and exclude public-network/TLS costs; verify those paths separately through the production proxy.

Use physical desktop/mobile devices and keyboard/assistive technology to repeat the two-participant flow. Check focus visibility, zoom/reflow, validation announcements, slow/offline/reconnect behavior, account changes and privacy, withdrawal processing/uncertain-payment handling and real alert delivery. Exercise NO and invalid resolutions as well as YES; automated service/HTTP suites already cover their accounting. Reconcile after the session and perform the separate [backup/restore rehearsal](BACKUP_RECOVERY.md). Keep all credits fictional until deployment, custody, external payment and operating terms have their own sign-off.

If any gate fails, preserve the aggregate and version, keep the pilot unaccepted, investigate the bottleneck/measurement failure, make a reviewed change and rerun the same profile. Increasing timeouts or relaxing limits is an explicit change to the agreed profile, not a successful retry. Larger cohorts, slower disks, longer histories, browser engines and different transaction mixes need separate measurements.
