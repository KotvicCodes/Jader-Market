# Jader-Market readiness review — 17 October 2026

Original reviewed revision: `2ecfc3d`, application version **0.1.7**.

**Follow-up:** [PR #8](https://github.com/KotvicCodes/Jader-Market/pull/8), revision `1603707`, version **0.1.8**, implements reserved offline withdrawals. It remains unmerged. Participant trading controls are implemented on `feat/participant-trading-controls` for PR #9, pending merge/deployment and interactive browser acceptance. The numbered launch checklist below reflects these implementations and the intended **real-money / offline-payment** pilot. Original audit evidence below remains scoped to 0.1.7 unless explicitly updated.

## Decision

**The application is not production ready and is not ready for an ordinary participant trading pilot.** It has a substantial, tested backend, but the participant trading workflow and production operating procedures remain incomplete.

| Intended use | Recommendation today |
| --- | --- |
| Feedback on the fictional `/demo` experience | **Yes.** Suitable for supervised usability feedback. Trades are simulated, quotes are fixed, and balances reset when leaving/reloading the market. |
| Internal testing of accounts, admin credits, market creation and browsing | **Yes, in an isolated environment with fictional credits.** Verify deployment security before making that environment externally accessible. |
| Developer-led testing of persistent trading through the APIs | **Yes, with fictional credits and a supervised worker.** The production HTTP suite already exercises this workflow. This does not test whether ordinary participants can use the product. |
| Closed-community pilot where participants trade through the website | **Not yet.** Market-page trading controls are implemented for PR #9; the complete portfolio, automatic refresh and browser acceptance remain pending. |
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
| Portfolio page | Available/reserved credit totals, admin adjustment history and private market payout receipts | [src/app/portfolio/page.tsx](../src/app/portfolio/page.tsx), [src/db/payout-history.ts](../src/db/payout-history.ts) |
| Resolution and payouts | Sole administrator decides YES/NO/invalid with evidence; worker pays from existing collateral; receipts persist | [src/db/settlement.ts](../src/db/settlement.ts), [drizzle/0005_amusing_blindfold.sql](../drizzle/0005_amusing_blindfold.sql), [src/app/api/account/payouts/route.ts](../src/app/api/account/payouts/route.ts) |
| Events and maintenance | Transactional outbox, deadline/order expiry maintenance and resumable settlement worker | [src/db/events.ts](../src/db/events.ts), [scripts/worker.ts](../scripts/worker.ts), [src/db/transaction-lock.ts](../src/db/transaction-lock.ts) |
| Operator setup | Migrations, synthetic seeding, sole-admin creation and trusted-host recovery | [scripts/admin.ts](../scripts/admin.ts), [scripts/migrate.ts](../scripts/migrate.ts), [scripts/seed.ts](../scripts/seed.ts) |
| Health and readiness | Version health; readiness validates migration/schema/trigger capabilities and required auth/origin/proxy configuration | [src/app/api/health/route.ts](../src/app/api/health/route.ts), [src/app/api/ready/route.ts](../src/app/api/ready/route.ts), [src/db/readiness.ts](../src/db/readiness.ts) |
| Verification and local infrastructure | Unit/integration tests, production HTTP flows, Linux CI and macOS operator portability; development database Compose | [tests](../tests), [scripts/test-members-http.ts](../scripts/test-members-http.ts), [.github/workflows/ci.yml](../.github/workflows/ci.yml), [compose.yaml](../compose.yaml) |

Database responsibilities are also separated clearly: `users`/`sessions` hold identity; `markets`/`market_audit` hold market lifecycle; `ledger_accounts`/`journals`/`ledger_entries` hold credits; `holdings`/`share_movements`/`orders`/`fills` hold trading; `market_resolutions`/`market_payouts` hold settlement; and `trading_outbox` holds committed events. Persistent financial data lives in PostgreSQL. Practice wallets live only in browser component state.

## Work that blocks a participant pilot

### Connect the trading interface — implemented for PR #9; acceptance pending

At the original 0.1.7 baseline, the real market page rendered a disabled “Trading interface coming next” button at [src/app/markets/[slug]/page.tsx](../src/app/markets/[slug]/page.tsx), line 34. Functional demo controls belong to a separate simulator and cannot place persistent orders.

**PR #9 implementation:** authenticated mint/burn, buy/sell limit-order forms, an order confirmation showing cost/reservation, partial-fill feedback, open-order status and cancellation. The controls handle signed-out, insufficient-credit/share, paused, expired, closed and synthetic-example states. The exact request and operation key are preserved in browser session storage when retrying an uncertain response. Market pages now show own holdings, all open orders and recent fills; refresh remains manual.

The controls use the existing trading API and server validation, with integer tick calculations for the review. Credit/share arithmetic remains authoritative on the server; the demo's floating-point practice calculations are not used for persistent accounting.

**Acceptance:** two ordinary accounts can mint inventory, place an ask, execute a partial purchase and cancel the remainder entirely through the website, without developer tools or administrator trading privileges.

### Complete the portfolio — required

[src/app/portfolio/page.tsx](../src/app/portfolio/page.tsx) shows credit totals, administrator adjustments and payout receipts. It does not show active holdings, reserved shares, open orders, fills or mint/burn/trade activity. A participant can spend credits through the API without seeing the corresponding pre-settlement positions on this page.

Add a private cross-market holdings/open-orders view and complete transaction history, using consistent snapshots. The existing private trading snapshot is market-specific; a portfolio-wide query/API is still needed. Make cancellation reachable from the portfolio. Cost basis and profit/loss can follow, provided the first pilot does not imply they are already available or show unsupported valuations.

**Acceptance:** after every mint, trade, cancellation and payout, participants can explain where their credits and shares went, including reserved amounts.

### Refresh changing state reliably — required; streaming is optional initially

Outbox events are recorded, but there is no delivery endpoint, subscriber, reconnect implementation or automatic refresh loop in the real market/portfolio pages. The worker performs maintenance and payouts; it does not deliver events to browsers. Pages otherwise require navigation/reload to observe other users' changes.

For the first small pilot, bounded polling of authoritative public/private snapshots is sufficient if freshness, errors and changed quotes are clear. Streaming can follow with owner filtering, reconnect cursors and retention design. Do not expose the private outbox directly.

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

Provide scheduled encrypted backups, protected key custody, a retention policy, an isolated restore drill and migration failure/forward-repair instructions. Verify restored sessions/MFA behavior, ledger projections, collateral, reservations and payout progress. Add an operator reconciliation command/screen that reports accounting mismatches safely and an explicit response to a failed reconciliation. Database commit-time guards and test assertions exist; a production reconciliation workflow does not.

### Offline payments require additional control before real-value use

At the original 0.1.7 baseline, the administrator had to confirm an offline payout before posting its debit. A participant could spend the credits during the external transfer, leaving an already-sent payment without a successful debit.

**Implemented in PR #8 (0.1.8; pending merge/deployment):** withdrawal requests immediately reserve available credits; administrators process and confirm payments with an opaque unique reference. Processing requests remain reserved until payment confirmation or an administrator explicitly verifies that payment was not sent and releases them. Participant cancellation is limited to requests that have not entered processing. Idempotency, stale-operation checks, append-only history and database guards protect the workflow. The old direct offline-debit path is disabled. See [OFFLINE_WITHDRAWALS.md](OFFLINE_WITHDRAWALS.md) for the workflow and migration procedure.

External transfers remain manual. Reconcile before sending and after any uncertain response; do not resend an ambiguous payment or release its reservation without verification. Incoming transfers must remain unspendable until receipt is verified. A separate pending-deposit interface is optional if administrators only credit confirmed receipts. Production-wide accounting and external-payment reconciliation tooling still needs implementation.

Review jurisdiction, credit denomination/redemption terms, limits, timing, fees, privacy/retention and dispute/finality disclosures for the actual proposed pilot.

### Browser and capacity acceptance

CI covers services and production HTTP behavior, but includes no browser workflow suite, restore drill or realistic-volume load test. Browser hydration, focus/error behavior, mobile layout, keyboard use and accessibility remain unverified here.

Financial writes intentionally share one PostgreSQL advisory lock across processes. This helps preserve cross-market wallet correctness, but it serializes writes. Credential rechecks and database projection validation also consume time. Choose a pilot cohort, concurrent-user target, history sizes and response-time targets, then measure lock waits, transaction latency, worker lag and error rates. Do not infer capacity from passing race-condition tests.

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
3. **Complete the portfolio.** Show cross-market holdings, reserved shares, open orders, fills and full transaction history, with cancellation reachable from the portfolio. Credits, shares and reservations must agree after every operation and payout.
4. **Add reliable automatic refresh and safe retries.** PR #9 implements pending-request replay; automatic updates and reconnect acceptance remain outstanding. Bounded polling is sufficient initially. Refresh authoritative public/private state; preserve operation identity on uncertain retries; handle pauses, expiry, disconnects and session loss clearly.
5. **Implement operator reconciliation.** Provide tooling to check ledger balances/projections, collateral, order/withdrawal reservations, payouts and external payments. Report discrepancies and define a response before further payments. Reconcile after every pilot session.
6. **Prove the production deployment.** Verify TLS, exact origin/proxy configuration, network restrictions and a restricted runtime database role. Supervise app/worker processes and alert on failed work, worker lag and stalled settlements.
7. **Prove backup and recovery.** Automate protected backups, preserve the matching `AUTH_SECRET`, successfully restore into an isolated environment, and document incident response plus migration failure/forward repair. Verify accounting and resumable payouts after restoration.
8. **Complete browser and load acceptance.** Validate administrator and two-participant workflows on desktop, mobile and keyboard. Measure realistic pilot load against agreed latency, lock-wait, error-rate and worker-lag targets. Interactive browser and production-load validation remain unverified.

Before operation, also agree credit denomination/redemption, limits/timing/fees, a funded liquidity account and inventory budget, and resolution/finality/privacy terms; review applicable jurisdiction requirements. Run a fictional-credit rehearsal before a capped real-money pilot. Advanced charts, watchlists, comments, notifications and multi-outcome markets can wait.

The pilot acceptance session should include: administrator creates two participants and a market; participants receive fictional credits; one mints and posts an ask; the other partially fills it; the seller cancels the remainder; pause rejects new trades; close releases remaining reservations; administrator records evidence; worker settles; both see correct private receipts; a worker restart and duplicate request do not double-pay. Exercise NO and invalid outcomes in separate test markets, then reconcile and restore an isolated backup.

Watchlists, advanced charts, notifications, automated liquidity, public signup, community comments, disputes and multi-outcome trading can remain later work for this confirmed first version. The next priority is closing the participant workflow and proving it can be operated reliably.
