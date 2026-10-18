# Jader-Market readiness review — 17 October 2026

Original reviewed revision: `2ecfc3d`, application version **0.1.7**.

**Follow-up:** [PR #8](https://github.com/KotvicCodes/Jader-Market/pull/8), revision `1603707`, version **0.1.8**, implements reserved offline withdrawals. It remains unmerged. Participant trading controls are implemented on `feat/participant-trading-controls` for PR #9, pending merge/deployment and interactive browser acceptance. PR #10, version **0.1.10**, implements the cross-market portfolio on top of PR #9, pending merge/deployment and interactive browser acceptance. PR #11, version **0.1.11**, implements bounded automatic refresh, reconnect handling and account-bound safe retries on top of PR #10, pending merge/deployment and interactive acceptance. Version **0.1.12** implements item 5 on top of PR #11: trusted-host read-only reconciliation with independent external receipt matching and a payment/incident runbook, pending merge/deployment and operator rehearsal. The numbered launch checklist below reflects these implementations and the intended **real-money / offline-payment** pilot. Original audit evidence below remains scoped to 0.1.7 unless explicitly updated.

## Decision

**The application is not production ready and is not ready for an ordinary participant trading pilot.** It has a substantial, tested backend, but the participant trading workflow and production operating procedures remain incomplete.

| Intended use | Recommendation today |
| --- | --- |
| Feedback on the fictional `/demo` experience | **Yes.** Suitable for supervised usability feedback. Trades are simulated, quotes are fixed, and balances reset when leaving/reloading the market. |
| Internal testing of accounts, admin credits, market creation and browsing | **Yes, in an isolated environment with fictional credits.** Verify deployment security before making that environment externally accessible. |
| Developer-led testing of persistent trading through the APIs | **Yes, with fictional credits and a supervised worker.** The production HTTP suite already exercises this workflow. This does not test whether ordinary participants can use the product. |
| Closed-community pilot where participants trade through the website | **Not yet.** Market-page trading controls are implemented for PR #9; PR #10 implements the complete portfolio; PR #11 implements automatic refresh/reconnect handling; browser acceptance and operational gates remain pending. |
| Real-money/offline-payment pilot or general production launch | **No.** Complete the participant workflow, recovery/operations work and external-settlement controls first, then assess the intended deployment and applicable requirements. |

The smallest useful next release is a complete binary-market trading experience using fictional credits. Advanced charts, watchlists, comments, disputes, public registration and multi-outcome markets need not delay it.

## Evidence and limits

Reviewed application routes, components, domain services, database services/schema, all six migrations, operator commands, tests, CI and project documentation. This is a repository and local-runtime review; no deployed site URL was supplied or assessed.

| Check performed in this review | Result |
| --- | --- |
| Clean install using the pinned npm 11.21.0 and Node 22.22.1 | Passed; installation audit reported **0 known vulnerabilities** |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed, zero warnings |
| `npm test` | **78 passed**, 10 test files |
| `npm run test:integration` | **85 passed**, 10 test files |
| `npm run build` | Passed |
| `npm run test:http` against the production build | Passed |
| Additional local production-server checks | `/` returned 200, `/api/health` reported 0.1.7, configured `/api/ready` returned 200; security headers and private admin-response cache controls were present |
| Interactive browser, mobile and keyboard review | **Unverified.** The collaborative preview could not reach the page and subsequently reported no available browser automation host. |
| Production TLS/proxy, restricted database role, backup restore and pilot-load validation | **Unverified** |

**PR #9 follow-up verification (0.1.9):** type checking, lint, 110 unit/component tests, 95 PostgreSQL integration tests, production build and production HTTP workflows passed locally. The HTTP workflow now uses two ordinary participants and checks rendered controls, partial fills, cancellation and privacy. Interactive visual/mobile/keyboard validation remains unverified because the shared preview could not reach the local application.

**PR #10 follow-up verification (0.1.10):** type checking, lint, 128 unit/component tests, 101 PostgreSQL integration tests, production build and expanded production HTTP workflows passed locally. Checks cover owner privacy, complete cursor pagination, credit/share reconciliation, zero-credit payout receipts, consistent snapshots during concurrent writes, and portfolio cancellation/recovery (including late responses). The local portfolio responds over HTTP, but collaborative preview open/navigation/snapshot calls failed; interactive visual/mobile/keyboard acceptance remains unverified. The existing development database was not used for financial test fixtures; suites used a separate disposable PostgreSQL container.

**PR #11 follow-up verification (0.1.11):** type checking, lint, 139 unit/component tests, 102 PostgreSQL integration tests, production build and expanded production HTTP workflows passed locally against a separate disposable database. Twelve new component scenarios cover remote state updates, review invalidation (including changed book depth), offline/reconnect behavior, hidden tabs, timeout/backoff, session/account isolation, malformed snapshots, post-mutation refresh races, selected history cursors, saved cancellation recovery and browser-history restoration. New HTTP checks verify anonymous/private market snapshots and expected-account rejection; integration checks cover combined depth/private state and settlement. Collaborative preview still reaches `chrome-error://chromewebdata/` with connection refused despite local HTTP success, so interactive desktop/mobile/keyboard acceptance remains unverified.

**Item 5 follow-up verification (0.1.12):** type checking, lint, 154 unit/component tests, 112 PostgreSQL integration tests, production build and production HTTP workflows passed locally. Ten new integration scenarios cover mixed trading/withdrawal states, bidirectional external-receipt discrepancies, injected accounting corruption and missing accounts/holdings, YES/NO/invalid and partial settlement, zero-credit payout receipt coverage, concurrent snapshots, SELECT-only operator access, bounded samples/exact counts, CLI outcomes and disabled-guard rejection. Unit/portability checks cover receipt validation and command startup without a native transpiler. Tests used disposable databases on a separate PostgreSQL container; production data and external payments were not accessed. Operator staging rehearsal, deployment, recovery and browser/load acceptance remain pending.

Database checks used a new disposable PostgreSQL 17.6 container on a separate port. The existing database container and its data were not used. Application code was not changed. An initial dependency-install attempt under the environment's older npm 9 failed on the package alias override; installation succeeded under the documented npm 11.21.0. This was an environment mismatch.

The test suite covers authorization, private drafts, MFA, CSRF/origin checks, idempotent requests, concurrent trading/reservations, cancellation/closure races, settlement for YES/NO/invalid results, interrupted payout batches, suspended holders and database tampering. These are useful guarantees within the tested cases. They do not constitute a penetration test, browser certification, production recovery drill or capacity measurement.

## What exists and where it lives

| Area | Current behavior | Main locations |
| --- | --- | --- |
| Application foundation | Next.js/React/TypeScript with PostgreSQL and Drizzle; versioned production builds | [package.json](../package.json), [src/app/layout.tsx](../src/app/layout.tsx), [src/db/client.ts](../src/db/client.ts) |
| Public market discovery | Published market list, search, category filters and pagination; private drafts excluded | [src/app/page.tsx](../src/app/page.tsx), [src/db/markets.ts](../src/db/markets.ts) |
| Public market detail | Immutable rules, deadline, status, real aggregated order-book depth and resolution evidence | [src/app/markets/[slug]/page.tsx](../src/app/markets/[slug]/page.tsx) |
| Practice demo | Four fictional markets, sample charts and temporary buy/sell simulation; no database/account required | [src/app/demo](../src/app/demo), [src/domain/demo.ts](../src/domain/demo.ts) |
| Accounts | Administrator-created accounts, sign-in/out, password changes, suspension and session revocation | [src/app/account/page.tsx](../src/app/account/page.tsx), [src/db/members.ts](../src/db/members.ts) |
| Authentication | Salted scrypt passwords, hashed opaque sessions, administrator TOTP MFA, recent-auth checks, origin/CSRF checks and database-backed limits | [src/domain/identity.ts](../src/domain/identity.ts), [src/auth](../src/auth), [src/app/api/auth](../src/app/api/auth) |
| Administrator workspace | Create/reset/suspend participant accounts; issue/remove credits with confirmation | [src/app/admin/page.tsx](../src/app/admin/page.tsx), [src/app/api/admin](../src/app/api/admin) |
| Market administration | Create/edit private drafts, review/publish, lock terms, pause/resume/close and record immutable final results | [src/app/admin/markets](../src/app/admin/markets), [src/db/market-admin.ts](../src/db/market-admin.ts), [src/domain/market-admin.ts](../src/domain/market-admin.ts) |
| Accounting | Integer amounts, balanced append-only journals, available/reserved wallets, per-market collateral, guarded projections | [src/db/schema.ts](../src/db/schema.ts), [src/db/members.ts](../src/db/members.ts), [drizzle](../drizzle) |
| Persistent trading | Complete-set mint/burn, owned-share selling, limit matching, partial fills, price improvement, GTC/GTD/IOC, self-trade prevention and cancellation | [src/db/trading.ts](../src/db/trading.ts), [src/domain/trading.ts](../src/domain/trading.ts), [src/app/api/trading/[action]/route.ts](../src/app/api/trading/[action]/route.ts) |
| Trading snapshots | Public anonymous depth/trades and private owner-scoped holdings/orders/fills with pagination | [src/app/api/markets](../src/app/api/markets), [src/db/trading.ts](../src/db/trading.ts) |
| Portfolio page (PR #10) | Consistent private balances, cross-market holdings/reservations, all open orders/cancellation, paginated orders/fills, credit/share movements and payout receipts | [src/app/portfolio/page.tsx](../src/app/portfolio/page.tsx), [src/db/portfolio.ts](../src/db/portfolio.ts), [src/components/portfolio-orders.tsx](../src/components/portfolio-orders.tsx) |
| Resolution and payouts | Sole administrator decides YES/NO/invalid with evidence; worker pays from existing collateral; receipts persist | [src/db/settlement.ts](../src/db/settlement.ts), [drizzle/0005_amusing_blindfold.sql](../drizzle/0005_amusing_blindfold.sql), [src/app/api/account/payouts/route.ts](../src/app/api/account/payouts/route.ts) |
| Events and maintenance | Transactional outbox, deadline/order expiry maintenance and resumable settlement worker | [src/db/events.ts](../src/db/events.ts), [scripts/worker.ts](../scripts/worker.ts), [src/db/transaction-lock.ts](../src/db/transaction-lock.ts) |
| Operator setup | Migrations, synthetic seeding, sole-admin creation and trusted-host recovery | [scripts/admin.ts](../scripts/admin.ts), [scripts/migrate.ts](../scripts/migrate.ts), [scripts/seed.ts](../scripts/seed.ts) |
| Health and readiness | Version health; readiness validates migration/schema/trigger capabilities and required auth/origin/proxy configuration | [src/app/api/health/route.ts](../src/app/api/health/route.ts), [src/app/api/ready/route.ts](../src/app/api/ready/route.ts), [src/db/readiness.ts](../src/db/readiness.ts) |
| Verification and local infrastructure | Unit/integration tests, production HTTP flows, Linux CI and macOS operator portability; development database Compose | [tests](../tests), [scripts/test-members-http.ts](../scripts/test-members-http.ts), [.github/workflows/ci.yml](../.github/workflows/ci.yml), [compose.yaml](../compose.yaml) |

Database responsibilities are also separated clearly: `users`/`sessions` hold identity; `markets`/`market_audit` hold market lifecycle; `ledger_accounts`/`journals`/`ledger_entries` hold credits; `holdings`/`share_movements`/`orders`/`fills` hold trading; `market_resolutions`/`market_payouts` hold settlement; and `trading_outbox` holds committed events. Persistent financial data lives in PostgreSQL. Practice wallets live only in browser component state.

## Work that blocks a participant pilot

### Connect the trading interface — implemented for PR #9; acceptance pending

At the original 0.1.7 baseline, the real market page rendered a disabled “Trading interface coming next” button at [src/app/markets/[slug]/page.tsx](../src/app/markets/[slug]/page.tsx), line 34. Functional demo controls belong to a separate simulator and cannot place persistent orders.

**PR #9 implementation:** authenticated mint/burn, buy/sell limit-order forms, an order confirmation showing cost/reservation, partial-fill feedback, open-order status and cancellation. The controls handle signed-out, insufficient-credit/share, paused, expired, closed and synthetic-example states. The exact request and operation key are preserved in browser session storage when retrying an uncertain response. Market pages now show own holdings, all open orders and recent fills. Refresh was manual in PR #9; PR #11 adds bounded automatic updates.

The controls use the existing trading API and server validation, with integer tick calculations for the review. Credit/share arithmetic remains authoritative on the server; the demo's floating-point practice calculations are not used for persistent accounting.

**Acceptance:** two ordinary accounts can mint inventory, place an ask, execute a partial purchase and cancel the remainder entirely through the website, without developer tools or administrator trading privileges.

### Complete the portfolio — implemented for PR #10; acceptance pending

At the original 0.1.7 baseline, the portfolio showed credit totals, administrator adjustments and payout receipts without active positions or trading history.

**PR #10 implementation:** the private portfolio and `/api/account/portfolio` read one repeatable-read snapshot containing available credits, separate order/withdrawal reservations, holdings and reserved shares across markets, all open orders with reviewed cancellation, paginated orders/fills, complete owner credit/share movement history, and payout receipts including zero-credit losing shares. Histories use independent validated cursors; open orders remain visible on every history page. Portfolio and market cancellation share the same saved-request recovery. See [Participant portfolio](PARTICIPANT_PORTFOLIO.md). Cost basis, valuation and profit/loss remain deferred and are not implied by share quantities.

**Acceptance:** after every mint, trade, cancellation and payout, participants can explain where their credits and shares went, including reserved amounts.

### Refresh changing state reliably — implemented for PR #11; acceptance pending

At the original audit baseline, outbox events were recorded without browser delivery or an automatic refresh loop. The worker still handles maintenance and payouts; browser refresh now reads authoritative state directly.

**PR #11 implementation:** active market and portfolio tabs poll complete authoritative snapshots every 10 seconds, pause in hidden/offline tabs, and recheck on focus/reconnect. Reads have an 8-second timeout and exponential retry delays capped at 60 seconds. Visible status reports the last successful check and blocks submissions on stale/error/reconnecting state. Changed balances/orders/quotes/eligibility permanently invalidate a review. Pending operation identity survives polling, session loss and disappearing open orders; replay remains explicit. Session/account changes hide private data; website submissions carry an expected-account header checked by the trading route. Public/private market state and resolution share one read-only repeatable-read transaction. Portfolio pagination stays selected. See [Automatic refresh](AUTOMATIC_REFRESH.md). No private outbox is exposed; streaming remains optional.

**Acceptance:** a second participant's fill, administrator pause and worker payout update the correct screens; an expired session or connection failure produces a useful state; users cannot subscribe to someone else's private activity.

### Plan initial liquidity — required for a meaningful trading test

This is an order book, with no automatic liquidity provider. Separate YES and NO books trade already owned shares; complementary buy orders do not automatically create inventory. Seeded browsing examples deliberately reject minting and new orders.

Create a non-synthetic pilot market with precise rules. Fund an ordinary test liquidity account with fictional credits, mint complete pairs and place bounded asks/bids through normal operations. Agree its inventory budget. Empty books are valid but will not demonstrate matching to participants.

## Production and real-value blockers

### Deployment and database privileges

The repository supplies development PostgreSQL Compose, not a complete supervised production deployment. Provide a repeatable deployment/runbook for the app, worker and database, with HTTPS, exact `APP_ORIGIN`, a trusted proxy that overwrites the configured client-IP header, and networking that prevents bypassing that proxy.

The example database URL uses the PostgreSQL bootstrap role. Introduce separate migration and restricted runtime roles, then test the application and triggers under the runtime role. A database owner/superuser can disable database guards; application-level authorization does not remove that privilege.

Verify secure cookies and private responses through the actual HTTPS deployment. CSP currently permits inline scripts; a nonce/hash policy is a useful subsequent hardening task, with hydration checked. No concrete XSS exploit was demonstrated in this review.

### Worker supervision and operational visibility

Settlement depends on a separate `npm run worker` process. Each settlement pass processes one market and at most 20 holdings, with bounded share chunks. A stopped worker delays payouts; deadlines still reject new trading, but expired reservations can remain until maintenance/cancellation.

The continuous worker retries with a safe generic message. There is no durable heartbeat, lag metric or alert integration. `/api/ready` checks configuration/schema, not worker progress: this review observed a ready response while no worker was running.

Add process restart supervision, last-success/oldest-pending indicators, and alerts for repeated failure or long-lived settling markets. Document how to pause affected markets and inspect failures without exposing private data. Consider fair scheduling across settling markets so one repeatedly failing market cannot indefinitely delay later markets; the current worker selects the first by ID on every pass. That head-of-line failure scenario was identified from source and was not fault-injected here.

### Backup, restore and reconciliation

Admin key preservation and host recovery are implemented and tested. They do not replace restoring a production database and its matching `AUTH_SECRET` after host loss.

Provide scheduled encrypted backups, protected key custody, a retention policy, an isolated restore drill and migration failure/forward-repair instructions. Verify restored sessions/MFA behavior, ledger projections, collateral, reservations and payout progress. Database commit-time guards and test assertions exist. Version 0.1.12 adds a read-only reconciliation command, independent external receipt matching and the [operator response procedure](OPERATOR_RECONCILIATION.md). Version 0.1.14 adds [protected backups, isolated restore verification and incident/forward-repair procedures](BACKUP_RECOVERY.md), with a successful synthetic database-plus-key rehearsal. Actual-host scheduling, independent storage/key custody and recovery-time acceptance remain pending.

### Offline payments require additional control before real-value use

At the original 0.1.7 baseline, the administrator had to confirm an offline payout before posting its debit. A participant could spend the credits during the external transfer, leaving an already-sent payment without a successful debit.

**Implemented in PR #8 (0.1.8; pending merge/deployment):** withdrawal requests immediately reserve available credits; administrators process and confirm payments with an opaque unique reference. Processing requests remain reserved until payment confirmation or an administrator explicitly verifies that payment was not sent and releases them. Participant cancellation is limited to requests that have not entered processing. Idempotency, stale-operation checks, append-only history and database guards protect the workflow. The old direct offline-debit path is disabled. See [OFFLINE_WITHDRAWALS.md](OFFLINE_WITHDRAWALS.md) for the workflow and migration procedure.

External transfers remain manual. Reconcile before sending and after any uncertain response; do not resend an ambiguous payment or release its reservation without verification. Incoming transfers must remain unspendable until receipt is verified. A separate pending-deposit interface is optional if administrators only credit confirmed receipts. Version 0.1.12 implements production-wide accounting checks and matching against an independently verified complete receipt register; operator rehearsal and deployment remain pending. No bank integration or automatic financial repair is introduced.

Review jurisdiction, credit denomination/redemption terms, limits, timing, fees, privacy/retention and dispute/finality disclosures for the actual proposed pilot.

### Browser and capacity acceptance

Version 0.1.15 adds [browser and pilot-load acceptance](PILOT_ACCEPTANCE.md): administrator/two-participant Chromium workflows at desktop/mobile viewports and with keyboard input, accessibility/reflow checks, and a sustained 20-participant/10-concurrent-user workload over 1,000 historical fills. Version 0.1.14 supplies the isolated restore drill. Actual-host capacity acceptance and physical-device/assistive-technology review remain operator checks.

Financial writes intentionally share one PostgreSQL advisory lock across processes. This helps preserve cross-market wallet correctness, but it serializes writes. Credential rechecks and database projection validation also consume time. The agreed profile and retained local measurements are recorded in [pilot acceptance](PILOT_ACCEPTANCE.md); repeat them on the intended host and measure lock waits, transaction latency, worker lag and error rates. Do not infer capacity from passing race-condition tests.

## Earlier findings and documentation drift

[PROJECT_AUDIT.md](PROJECT_AUDIT.md) preserves the audit of version 0.1.4 and now includes a remediation note. Its original findings must not be read as the current release state.

| Historical finding | Current assessment |
| --- | --- |
| A1: failed admin setup overwrites an existing encryption key | Addressed in current setup implementation; preservation/rollback/concurrency regressions pass. |
| A2: synthetic examples accept persistent trades and public depth is misleading | Addressed: mint/place reject synthetic markets, legacy redemption is preserved, real depth is rendered. |
| A3: closed-market payouts absent | Addressed: immutable results, collateral-funded resumable payouts and private receipts exist and pass tests. |
| A4: obsolete schema can advertise readiness | Addressed for tested migration/schema/trigger/auth configuration failures. Worker and infrastructure health remain separate. |
| A5: lifecycle and credit events missing | Event recording addressed. Browser delivery remains unfinished. |
| A6: credit balances/history are separate snapshots | Addressed with a repeatable-read account snapshot, including payout receipts. |

The original review found stale status language in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), including resolution/payouts described as future work and references to a dependency PR. PR #9 updates that status language and documents the participant controls. Some retained milestone text describes invitation acceptance, disputes and a challenge window; the confirmed first-version scope explicitly excludes those optional features. The software license is still undecided; resolve it before distributing reusable code.

## Numbered launch checklist — real money / offline payments

These are the same eight launch gates as the operational roadmap. PR #8 addresses outgoing payment reservations; the site is still **not ready for a real-money pilot**.

1. **Merge and test the withdrawal PR in staging.** Review and merge [PR #8](https://github.com/KotvicCodes/Jader-Market/pull/8), stop the app and worker, apply migration `0006`, and restart. Rehearse request, reservation, cancellation, processing, confirmed payment, uncertain payment and verified-unpaid release with ordinary participants and the administrator. Merge and deployment remain pending.
2. **Implement participant trading controls.** Implemented for PR #9, pending merge/deployment and interactive browser acceptance: real mint/burn, buy/sell limit orders, partial-fill feedback and cancellation through the website. Two ordinary participants must complete mint → ask → partial fill → cancellation without developer tools.
3. **Complete the portfolio.** Implemented for PR #10, pending merge/deployment and interactive browser acceptance: cross-market holdings/reserved shares, all open orders with cancellation, paginated orders/fills, complete credit/share movements and payout receipts in one consistent snapshot. Automated checks reconcile balances, shares and reservations after operations and payouts; ordinary participants must verify the same workflow in-browser.
4. **Add reliable automatic refresh and safe retries.** Implemented for PR #11, pending merge/deployment and interactive acceptance: bounded authoritative polling, hidden/offline suspension, reconnect/focus checks, freshness/error/session states, invalidated stale reviews, account-bound submissions and explicit exact replay. Automated component/HTTP checks cover remote fills, pauses/deadlines, disconnects, session loss and payout refresh; the two-participant browser rehearsal remains required.
5. **Implement operator reconciliation.** Implemented in version 0.1.12 on top of PR #11, pending merge/deployment and operator rehearsal: `npm run reconcile` checks ledger/holding projections, journals, collateral, order/withdrawal reservations, fills, payouts and withdrawal history in one read-only snapshot. A supplied independent complete receipt register verifies recorded external payments in both directions; missing evidence never produces a full pass. Reports retain exact counts with bounded samples and safe exit codes. The [operator runbook](OPERATOR_RECONCILIATION.md) defines payment holds and incident response. Reconcile after every pilot session. Items 6–8 remain launch gates.
6. **Prove the production deployment.** Implemented for PR #13 (0.1.13): isolated production Compose app/worker/database/HTTPS proxy, separate owner/runtime roles with explicit grants and statement/lock timeouts, durable worker success/failure status, private lag/stalled-settlement monitoring, restart supervision and host alert timer. See [production deployment](PRODUCTION_DEPLOYMENT.md). Disposable local TLS/proxy/role/process acceptance is automated; actual-host certificate/network/alert-delivery and operator acceptance remain required.
7. **Prove backup and recovery.** Implemented for PR #14 (0.1.14): protected backups with the matching `AUTH_SECRET`, isolated restore and accounting/payout replay checks, plus incident response and migration failure/forward-repair guidance. See [backup and recovery](BACKUP_RECOVERY.md). Off-host backup custody and actual-host restore acceptance remain operator checks.
8. **Complete browser and load acceptance.** Implemented for version 0.1.15: [repeatable browser and sustained pilot-load rehearsals](PILOT_ACCEPTANCE.md), including desktop/mobile/keyboard flows, accessibility, exact retry, automatic fill/pause updates, withdrawal reservations and worker payouts. The agreed profile uses 20 participants, 10 concurrent users and 1,000 historical fills, with p95 reads <1 s, p95 writes <2 s, financial lock waits <500 ms, no unexpected errors and worker lag <5 s. Actual-host capacity and physical-device/assistive-technology acceptance remain required.

Before operation, also agree credit denomination/redemption, limits/timing/fees, a funded liquidity account and inventory budget, and resolution/finality/privacy terms; review applicable jurisdiction requirements. Run a fictional-credit rehearsal before a capped real-money pilot. Advanced charts, watchlists, comments, notifications and multi-outcome markets can wait.

The pilot acceptance session should include: administrator creates two participants and a market; participants receive fictional credits; one mints and posts an ask; the other partially fills it; the seller cancels the remainder; pause rejects new trades; close releases remaining reservations; administrator records evidence; worker settles; both see correct private receipts; a worker restart and duplicate request do not double-pay. Exercise NO and invalid outcomes in separate test markets, then reconcile and restore an isolated backup.

Watchlists, advanced charts, notifications, automated liquidity, public signup, community comments, disputes and multi-outcome trading can remain later work for this confirmed first version. The next priority is closing the participant workflow and proving it can be operated reliably.
