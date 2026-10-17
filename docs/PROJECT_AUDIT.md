# Project audit — 10 October 2026

Audited revision: `deba183`, application version `0.1.4`.

For the current readiness assessment and eight numbered launch gates, see [the 17 October readiness review](READINESS_REVIEW_2026-10-17.md). This document preserves historical findings.

## Remediation status — 14 October 2026

This report preserves the original audit of revision `deba183`; the findings below describe that historical state. The authorized remediation batch covers A1–A6 only:

| Finding | Remediation PR |
| --- | --- |
| A1 administrator keys; A4 readiness | #5 — preserve configuration during setup and validate current schema/configuration; also reject missing restored password hashes and missing or disabled application triggers |
| A2 availability; A5 event coverage; A6 consistent account snapshot | #6 — enforce synthetic restrictions while preserving legacy complete-set redemption, display real depth, record lifecycle/private invalidations, use repeatable-read balance/history snapshots |
| A3 resolution/payouts | Settlement PR stacked on #6 — immutable sole-admin YES/NO/invalid evidence, fixed invalid refunds, guarded resumable collateral payouts and private receipts |

Participant trading controls, live delivery and offline requests remain outside this batch. Local verification uses disposable synthetic databases; browser/proxy/recovery verification remains separate. CodeRabbit's skipped status is not review approval; manual reviews and CI are monitored for the linked PRs.

## Assessment

Jader-Market has a working and tested backend prototype. Accounts, administrator MFA, credit adjustments, immutable market publication, collateral-backed trading, and expiry maintenance are implemented. The ledger has substantial database safeguards and the existing automated checks pass.

The project does not yet deliver the complete participant workflow. The public market pages do not read executable books, the portfolio does not show persistent positions or trading activity, and closed markets have no resolution or redemption implementation. Development with synthetic credits is appropriate; a community pilot that expects settled balances needs the remaining workflow and operational checks.

The highest-priority fixes are administrator encryption-key preservation and the discrepancy between disabled-trading labels and active persistent trading APIs. Readiness and lifecycle event coverage also need correction before deployment and live UI integration.

## Scope and verification

Reviewed the tracked application routes, client components, domain modules, authentication, database services/schema, all four SQL migrations, operator scripts, fixtures, test suites, dependency/configuration files, CI, and project documentation. The working tree was clean at the beginning. No application code or existing data was changed; this report is the only tracked-file addition.

The checks used Node.js `22.22.1`, the pinned npm `11.21.0` for dependency installation/audit, and a new disposable PostgreSQL `17.6-alpine` container. The existing database container was not used. The installed npm `9.2.0` initially failed on the alias override; installation succeeded with the documented npm version. That initial failure is an environment mismatch, not a lockfile defect.

| Check | Result |
| --- | --- |
| Clean dependency install with npm 11.21.0 | Passed |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with zero warnings |
| `npm test` | 73 tests passed across 9 files |
| `npm run test:integration` | 53 tests passed across 7 files |
| `npm run build` | Passed; production artifact built |
| `npm run test:http` | Passed against the production build |
| npm dependency audit | Zero known reported vulnerabilities |
| Additional administrator-key, seed-trading, lifecycle-event, and incomplete-schema probes | Findings reproduced below |
| Interactive browser review | Unverified: the T3 preview opened, but local navigation reached `chrome-error://chromewebdata/` and snapshots failed |

The HTTP suite covers sign-in/MFA, administrator authorization, credits, idempotency, private drafts, publication, trading reservations/matching, owner isolation, CSRF/origin rejection, closure, suspension, and recovery. These checks do not establish browser hydration, keyboard behavior, accessibility, mobile layout, production proxy configuration, backup recovery, or performance at pilot load. No external penetration test or real deployment audit was performed.

## Findings requiring action

Priority meanings: **High** should be resolved before broader use of persistent balances; **Medium** should be resolved before its affected deployment or UI capability ships. Planned missing features are explicitly distinguished from defects.

### A1 — High: failed administrator creation can overwrite the saved encryption key

Evidence: [scripts/admin.ts](../scripts/admin.ts), lines 47–60; [src/db/members.ts](../src/db/members.ts), `bootstrapAdministrator`.

`admin:create` checks only `SELECT 1` before generating and saving `AUTH_SECRET`. It does not check whether the administrator already exists until after writing the key. An exported empty `AUTH_SECRET` also takes precedence over a valid `.env` key because dotenv does not overwrite existing environment variables by default.

Reproduction used an initialized synthetic database with an administrator and a temporary directory containing a valid `.env` key. The process received `AUTH_SECRET=""`. After valid prompts, the command exited with `admin_exists`, but the saved key had changed. A secret encrypted with the original key could not be decrypted with the replacement. The probe never touched the workspace's `.env`.

Impact: a failed setup attempt can leave the application unable to decrypt existing MFA secrets on restart. This is an operator failure case, not a remotely reachable endpoint; the original encrypted values remain in the database and require the original key for recovery.

Action: check current schema readiness and existing administrator state before any key write; fail explicitly when an empty environment value masks a stored key. Preserve the existing file/key on unsuccessful setup. Account for concurrent setup processes when deciding how to persist a newly generated key.

Acceptance: existing-admin, missing-migration, masked-key, and concurrent-setup cases leave existing configuration unchanged; first setup succeeds with one consistent key; recovery still requires the original key.

### A2 — High: persistent trading is active where the product says it is disabled

Evidence: [src/db/fixtures.ts](../src/db/fixtures.ts), lines 6 and 27–32; [src/db/trading.ts](../src/db/trading.ts), lines 91–93; [src/app/page.tsx](../src/app/page.tsx), line 14; [src/app/markets/[slug]/page.tsx](../src/app/markets/[slug]/page.tsx), line 20; [scripts/seed.ts](../scripts/seed.ts), line 13.

Seeded fictional markets are stored as published, open markets. Trading eligibility checks status, pause state, and deadline, with no restriction on `synthetic`. A funded participant successfully minted one complete set on the seeded `demo-launch` market: available balance fell from 100,000 to 90,000 ticks. This is persistent ledger activity, separate from the temporary `/demo` wallet.

The home page says “Trading not enabled yet”; seeded terms and the seed command say trading is disabled. Public market detail always says there are no executable orders and does not query the trading API, even when a book exists. The disabled button is not an API restriction.

Action: make trading availability explicit and authoritative on the server. Keep fictional browsing fixtures non-tradable, or deliberately separate a trading sandbox and its balances. Align public labels with actual backend availability and render book/quote information from authoritative snapshots. If trading should remain disabled until settlement exists, enforce that decision inside trading transactions.

Acceptance: direct API requests cannot spend persistent credits in a market labelled non-tradable; public availability/depth agrees with the API; `/demo` remains isolated.

### A3 — High release blocker, planned feature: closed-market collateral cannot be redeemed

Evidence: [src/db/trading.ts](../src/db/trading.ts), lines 91–114; [drizzle/0002_brainy_peter_quill.sql](../drizzle/0002_brainy_peter_quill.sql), `guard_market_terms`; [docs/TRADING_BACKEND.md](TRADING_BACKEND.md).

Closing releases open-order reservations, but it does not distribute market collateral. Burning also stops when the market closes. The audit minted a pair, closed the market, and received `trading_closed` when trying to burn it. Collateral remains recorded in escrow; there is no result-finalization or payout endpoint/worker.

This behavior is documented as unfinished and is not evidence of missing collateral. It prevents the application's intended end-to-end settlement workflow.

Action: implement the confirmed first-version scope: direct sole-administrator resolution to YES, NO, or invalid, supported by immutable evidence and restartable, idempotent collateral-funded payouts. Extend lifecycle, journal, and share-projection guards through a new migration. For binary invalid results, specify the 5,000-tick refund per outcome share before publication.

Acceptance: both outcomes and invalid results reconcile to escrow; concurrent finalization/closure/trading cannot double-pay; interrupted payout work resumes once; suspended holders' entitlements remain accounted for; private receipts explain each payout.

### A4 — Medium: readiness accepts an obsolete database schema

Evidence: [src/app/api/ready/route.ts](../src/app/api/ready/route.ts), lines 5–13.

Readiness only queries `markets.id`. With only migration `0000` applied, `/api/ready` returned HTTP 200 and `{"status":"ready"}` although the `users`, `orders`, and `holdings` tables were absent and market browsing showed a service-unavailable state. Authentication configuration was also unset in that process.

The endpoint satisfies its narrow documented table check, but it cannot serve as a deployment gate for the current application.

Action: verify the expected migration level and required schema capabilities. Define separately whether deployment readiness also requires valid authentication/origin/proxy settings and a healthy maintenance worker. Return only safe status codes, without configuration values.

Acceptance: no database, partial migrations, incompatible schema, and invalid required configuration cannot advertise full application readiness; a correctly configured current deployment passes.

### A5 — Medium: lifecycle changes are missing from the transactional outbox

Evidence: [src/db/market-admin.ts](../src/db/market-admin.ts), `mutateMarket`; [src/db/trading.ts](../src/db/trading.ts), `cancelTradingOrders` and `finishOperation`.

Market create/edit/publish/pause/resume do not write outbox events. Close writes events only indirectly when it cancels pending orders. After minting a pair with no open orders, the audit paused, resumed, and closed the market; the number of outbox rows did not increase. Credit adjustments likewise do not currently publish balance invalidations.

No stream consumer ships yet, so this is an integration gap rather than a failure of an existing live feed. Building live views solely on current outbox events would miss important state changes.

Action: define event coverage for market availability and private balances, and emit appropriate events in the originating transaction. Define authentication, owner filtering, cursor/reconnection semantics, and retention before exposing delivery. Handle deadline passage as a time-based invalidation even when no orders exist.

Acceptance: publish/pause/resume/close and balance changes trigger the right refreshes; rollback emits nothing; public payloads contain no private identifiers; reconnect reconciles from an authoritative snapshot.

### A6 — Medium: account balance and adjustment history are not one consistent snapshot

Evidence: [src/db/members.ts](../src/db/members.ts), `accountSnapshot`, lines 246–252.

The portfolio's session, balance, and adjustment history use separate statements outside a read transaction. A concurrent adjustment can therefore appear in history after the displayed balance was read. The trading snapshot APIs already use read-only repeatable-read transactions.

This is a source-level concurrency finding; a race was not separately induced during this audit. It affects display consistency, not the atomicity of financial writes.

Action: apply a consistent read transaction to the account snapshot, and review list/count consistency where it affects administration.

Acceptance: a concurrent credit/debit appears wholly before or after a returned balance/history snapshot.

## Area-by-area review

| Area | Current state | Remaining work |
| --- | --- | --- |
| Architecture | Small Next.js/TypeScript application; domain validation, database services, HTTP authorization, and client forms have distinct responsibilities | Keep settlement and event delivery explicit; reduce dense single-line JSX when those screens are extended |
| Accounts | Administrator-created handles, salted scrypt, hashed opaque sessions, revocation, administrator MFA/recent authentication, and trusted-proxy login limiting | Fix A1; improve operator/support runbooks and initial-password handoff UX |
| Authorization/privacy | Ownership comes from sessions; mutations reauthorize in transactions; public books exclude owners; private HTTP responses disable caching | Extend the same boundaries to streams, notifications, resolution, and private exports |
| Accounting | Integer ticks; balanced append-only journals; ledger/share projections; collateral and reservation guards; concurrent retries tested | Settlement, replay/reconciliation tooling, recovery exercises, and larger randomized sequences |
| Markets | Private drafts, revision checks, immutable publication, pause/resume/close, explicit UTC deadlines, search/category pagination | Correct misleading labels, define invalid-result policy, add resolution and actual market statistics |
| Matching | Funded complete sets, owned-share selling, price-time matching, partial fills, refunds, IOC/GTD/GTC, self-trade prevention, cancellation | Participant controls, real executable-depth preview, receipts, and measured load tests |
| Portfolio | Available/reserved credit totals and administrator-adjustment history | Holdings across markets, open orders, trading ledger activity, cost basis, disclosed valuation rules, and A6 |
| Live updates | Transactional outbox stored; expiry worker available | A5, delivery, owner-scoped subscriptions, reconnect, notification state, archival/retention |
| UI/accessibility | Labels, semantic forms/tables, skip link, focus styling, responsive CSS, and status messages exist in source | Browser tests, keyboard/screen-reader checks, narrow-screen validation, and live trading states |
| Operations | Development PostgreSQL Compose, migrations, local operator commands, safe predefined error messages | Production app/worker supervision, backup/restore, forward-repair procedure, observability, reconciliation, and A4 |
| CI/dependencies | Pinned runtime/dependencies; Linux full checks and macOS operator-portability job; current npm audit clean | Pin external actions/images by immutable references, automate dependency review, and include browser/restore checks |
| Documentation/scope | Confirmed first-version scope correctly favors one oracle and administrator-created accounts | Remove stale disabled-trading copy and historical dependency-PR wording; keep optional disputes/invitations/multi-outcome work separate |

### Security and operational hardening

These are deployment and defense-in-depth recommendations, not demonstrated remote exploits:

- The documented Compose `POSTGRES_USER` is the PostgreSQL bootstrap superuser, and the example application URL uses that role. Production should separate the restricted runtime role, migration owner, and test role. Runtime access should not allow dropping tables, disabling guards, or creating databases. Test acceptance under the runtime role; do not assume the superuser-backed integration results prove it works.
- CSP includes `script-src 'unsafe-inline'`. Move toward per-request nonces or compatible hashes and verify Next.js hydration. No concrete XSS injection was found in the reviewed render paths; React escaping and bounded plain-text terms are useful existing protections.
- Deployment needs an HTTPS proxy that overwrites the configured client-IP header and prevents direct client access to the application port. Configure HSTS at the HTTPS boundary and verify secure-cookie behavior there; local HTTP tests do not validate that setup.
- Financial writes deliberately share a global advisory lock. Some credential verification happens while holding it, and projection guards repeatedly sum historical ledger/share data. The design favors correctness for a small cohort, but growing history and worker passes can increase latency. Measure lock wait, transaction duration, statement time, and maintenance lag before changing lock partitioning or weakening guards.
- There is no application query/lock timeout configuration in the reviewed client. Establish bounded failure/retry behavior appropriate to the deployment, including safe reporting of worker lag and database errors.
- Outbox/history growth needs a retention and archival policy. The current immutable-outbox delete guard means retention cannot be added as an ordinary delete job without an explicit design/migration.
- Backup instructions must include both the database and original `AUTH_SECRET`. Exercise an isolated restore and verify MFA, ledger projections, positions, and outstanding reservations. Keeping a backup file without a restore drill is insufficient evidence of recoverability.
- No license is selected. Make that decision before distributing the application as reusable software.

## Recommended next steps

The existing roadmap correctly identifies the participant UI as the next feature milestone. Precede it with the concrete defects above, and keep it synthetic until resolution and operations are verified.

| Order | Work package | Completion criteria |
| --- | --- | --- |
| 1 | **Correct current safety and availability behavior:** A1, A2, A4, A6 and stale product copy | Failed admin setup preserves keys; labelled non-tradable markets reject direct operations; readiness rejects partial deployments; account snapshots are consistent; focused regression checks and the existing pipeline pass |
| 2 | **Connect the persistent trading UI and portfolio** | Two ordinary participants can mint, place bounded buy/sell orders, observe partial fills, cancel remaining orders, and see available/reserved credits and shares; empty/paused/closed states are accurate; uncertain responses retry with the same operation key |
| 3 | **Complete event coverage and reliable updates:** A5 plus delivery | Market lifecycle, orders, holdings, and credit changes refresh correctly; authentication/owner isolation survives reconnect; cursors reconcile against snapshots; worker lag and expired quotes are visible |
| 4 | **Implement sole-oracle resolution and payouts** | YES/NO/invalid finalize under immutable rules; reserved orders release; escrow funds payouts; duplicate requests and mid-job restarts do not duplicate payments; ledger reconciliation passes |
| 5 | **Complete offline reconciliation where needed** | Confirmed immediate adjustments remain auditable; if pending requests are introduced, incoming funds stay unspendable and outgoing amounts stay reserved through ambiguous settlement; operator history and explicitly authorized exports support reconciliation |
| 6 | **Prepare the deployment and recovery runbooks** | Restricted database roles, HTTPS proxy, app/worker supervision, safe metrics, migration forward repair, pause/recovery procedures, and a successful isolated database-plus-key restore |
| 7 | **Validate the agreed pilot workload and browser experience** | Automated browser flows for administrator and two participants; mobile/keyboard/accessibility checks; realistic market/history fixtures; measured latency/lock waits; larger reproducible randomized accounting tests; no unresolved release blockers |

Work packages 2 and 4 can be developed independently after package 1, but both must pass before a settled community pilot. Live delivery can follow an initial snapshot/polling UI if that keeps the first trading interface easier to review. Watchlists, advanced charts, automated liquidity, comments, disputes, and multi-outcome markets should follow the completed binary workflow rather than delaying it.

Use small feature PRs with concrete acceptance checks. Follow the repository's one-patch-version-bump rule for shipped code; this documentation-only audit does not need a version bump.
