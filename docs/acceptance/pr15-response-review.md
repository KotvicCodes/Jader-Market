# PR #15 independent response-validation review — 18 October 2026

Reviewed head `ead4240807ed2248a75a5ec6707715a4efe039af` independently, including the full browser/load implementation, CI and dependency changes, UI focus/keyboard changes, backup subprocess and cancellation changes, and inherited deployment/runtime-role/monitoring/recovery paths. Traced the authentication, origin/CSRF/account binding, financial locking, trading, settlement and reconciliation paths exercised by acceptance. Previous review records were treated as context; the checks below were run in this checkout with disposable synthetic data.

## Confirmed finding and correction

**P2 — measured reads could all be unusable while pilot acceptance passed.** The load driver consumed response bytes and checked `response.ok` without decoding snapshots or verifying their account/session. Replacing all 1,200 measured market/portfolio reads with empty HTTP 200 JSON reproduced a false pass: zero reported errors, p95 reads rounded to 0 ms, all 120 real financial writes applied, and complete reconciliation passed. Final database checks cannot establish that the measured read endpoints returned usable private data.

Reads now require HTTP 200 JSON, `Cache-Control: no-store`, no followed redirect, and the same complete snapshot/account validation used by the application, plus the expected participant's CSRF value. The existing snapshot session error was extracted into a shared, framework-independent module so the portable Node operator runner can reuse the validators without loading browser components. The browser refresh loop retains the same error class and handling. Read timing includes full JSON decoding and validation; failed requests retain their samples. Workload, rate limits, financial guards and latency/lag thresholds are unchanged.

The same full-profile fault injection now exits unsuccessfully with **1,200 unexpected errors**, while all 120 writes, exact persisted holdings/mints/fills, payout replay and full reconciliation still pass. Thirteen new regression tests cover usable snapshots, empty/truncated bodies, another account/session, anonymous market data, malformed/HTML responses, redirects, cacheability and unsuccessful statuses.

## Independent verification

- TypeScript, ESLint, a fresh production Next.js build and **211 unit/component tests** passed after the correction. The existing automatic-refresh component checks passed with the shared session error.
- **130 PostgreSQL integration tests** and the production HTTP suite passed in an independently created disposable database, including financial guards/races, roles, reconciliation, account/MFA/session/privacy, origin/CSRF checks, trading, withdrawals and all resolution results.
- All desktop, mobile/touch and keyboard browser workflows and the desktop interruption lifecycle check passed on both the reviewed head and the corrected revision, followed by verified worker restart and complete reconciliation. The two duplicate lifecycle projects are intentionally skipped.
- The unchanged corrected load profile passed in **63.339 seconds**: 1,200 validated reads, 120 writes, zero request/sampling errors, p95 reads/writes **36/111 ms**, and a **108 ms** conservative financial-lock wait bound. Maximum observed heartbeat/settlement/expiry lag was 1,104/1,207/678 ms. All 1,060 fills, 40 receipts, 70 active-market mints and both 1,060-share totals matched; worker restart produced no duplicate payouts and complete reconciliation passed. [Retained aggregate](item8-response-review-load.json). The baseline before the correction also passed (33/99 ms read/write p95), so normal traffic remains accepted while invalid reads now fail.
- The complete Docker deployment rehearsal passed with the corrected source/build: initialization gating, migrations/grants, HTTPS/readiness/version, secure cookies, origin rejection, proxy header overwrite and address replacement, private networking, worker crash/restart, graceful shutdown and stale-worker alert/recovery.
- The isolated backup/restore drill passed with the corrected source: source release/key identity, encrypted replication, retention/freshness, wrong-key/corruption/SQL-failure rejection, immutable-image restore, private logs, exact restored history/MFA, session revocation, reservations/collateral and resumed payouts without duplicates. The cancellation/deadline regression suite passed too.
- The dependency audit reported **zero known vulnerabilities**.

No additional financial business-logic defect was reproduced in this review. These tests do not establish correctness for every input or deployment.

## Environment and limits

Node 22.22.1, npm 11.21.0, PostgreSQL 17.6, Linux ARM64. Browser runs used the documented Chromium 153 executable override. An initial invocation accidentally selected an incompatible local executable and failed before the browser workflows; rerunning with the ARM64 executable resolved that setup error. Playwright's pinned browser remains a CI check.

The shared root filesystem had less than 200 MB free. Dependencies were hard-linked from another checkout with a byte-identical lockfile. The production application was built freshly here. Docker rehearsals reused the existing production image's dependency layers and copied in the current source, scripts, migrations, package metadata and freshly built application. A new clean dependency installation and complete production Dockerfile rebuild are not claimed; CI must verify the published revision.

Physical devices, other browser engines, assistive technology, public-network/TLS latency, actual-host capacity, off-host backup/key custody and real alert delivery remain operator acceptance work. No merge, production deployment or real external payment was performed. Test-owned containers, databases, volumes, processes, image tag and private directories are cleaned up; the existing development database is left untouched.
