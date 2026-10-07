# Jader-Market implementation plan

## Confirmed first-version scope

The operator confirmed that this is a small closed community, the operator is the sole oracle, no disputes are needed, and balances can be handled offline. These choices override the broader roadmap below for the first version.

The first version targets administrator-created accounts, binary markets, internal balances, complete-set minting, a simple order book, participant portfolios, direct administrator resolution, and confirmed offline balance adjustments. There is no challenge window, second resolver, public registration, automated liquidity, community discussion, or multi-outcome trading in this version. The broader features below remain optional future work.

## Current implementation

The foundation and accounts/credits milestone are implemented: administrator-created handles, password sign-in, opaque revocable sessions, administrator authenticator enrollment and recent authentication, private persistent balances and paginated history, account suspension/password recovery, and confirmed offline credit/debit adjustments. Only an authenticated administrator can issue new participant credits. Winning bets will redistribute existing collateral when trading and resolution are implemented.

The implementation uses Node's built-in salted scrypt instead of the initially proposed Argon2 dependency, with N=32768, r=8, p=3. Administrator MFA secrets are encrypted with a local private key. Participant recovery is administrator-assisted; sole-administrator recovery requires the trusted local CLI. There is no public registration or default password. The ledger uses integer ticks, balanced append-only journals, database-enforced balance projections, and idempotent operations. Practice trading remains separate from persistent participant credits.

Next: administrator market lifecycle controls, followed by collateral-backed trading/reservations and direct administrator resolution. Pending offline requests, backups, and deployment are later milestones. Code changes now ship on feature branches through pull requests; the accounts/credits PR uses a single patch version increment.

## 1. Goal and prototype boundary

Build a practical prediction market application called **Jader-Market**, inspired by Polymarket's market browsing, outcome trading, order books, and portfolio experience. Implement original branding and interfaces.

Deliver the full prototype workflow: an administrator creates a question, invited users receive recorded credits, users trade collateral-backed outcome shares, an administrator resolves the question using published rules, balances update, and the administrator reconciles offline settlement.

No payment gateway, bank integration, card processing, crypto wallet, smart contract, or blockchain oracle is included. External transfers occur offline. The application still needs accurate internal accounting, balance reservations, payouts, and administrator confirmation of offline transfers.

Start with synthetic credits and a small invited cohort. A credit is an internal accounting unit, not a promise of redeemability. Before an offline money trial, explicitly configure the unit's currency/value, initial funding, and redemption policy. Do not silently equate demo grants or market-maker subsidies with redeemable money.

Initial assumptions:

- Centralized, self-hosted application and PostgreSQL database under the operator's control.
- Public viewing of published markets; authenticated users can trade and view their own private records.
- Invite-only registration and administrator-created markets for the first release.
- Binary YES/NO markets first; mutually exclusive multi-outcome markets in a later prototype milestone.
- An order book and a separately funded liquidity account, rather than an automated market maker.
- No trading fees in the first prototype. Keep fees explicitly zero in quotes and receipts.
- No external price feeds, analytics, advertising, or remote identity providers.

## 2. Product scope

| Area | Required behavior |
| --- | --- |
| Discovery | Search, categories, tags, sorting, filters, pagination, closing times, volume, liquidity, and status. |
| Market details | Question, description, published resolution criteria and sources, outcomes, price history, trades, order book, and trade form. |
| Trading | Buy/sell, limit orders, bounded immediate execution, partial fills, order cancellation, expiry, reserved funds/shares, and receipts. |
| Accounts | Invitations, pseudonymous handles, sign-in, recovery, session management, account suspension, and role-based access. |
| Portfolio | Available/reserved credits, holdings, average cost, realized/unrealized profit and loss, open orders, and history. |
| Administration | Draft/publish markets, manage invitations and accounts, fund the liquidity account, confirm offline credits/debits, pause trading, and resolve disputes. |
| Resolution | Proposed result with evidence, challenge window, finalization, winning payouts, invalid-market refunds, and private settlement history. |
| Notifications | Private in-app order-fill, cancellation, market-close, proposed-result, final-result, and balance-change notices. |
| Community | Watchlists first; pseudonymous comments, reporting, and moderator controls in the expanded prototype milestone. |
| Operations | Migrations, synthetic seeds, health checks, database backups and restore checks, reconciliation, and deployment documentation. |

Build dense, usable screens: market list, market page, portfolio, activity, account settings, and administrator console. Prefer tables, compact cards, and clear controls to a decorative landing page. Paginate large datasets and keep trade controls usable on narrow screens.

Show actual labels for each statistic. Last-trade price is not a guaranteed probability or executable quote. Missing prices and empty liquidity must appear as unavailable instead of fabricated values. Public feeds show anonymous trades; never expose participant identities, balances, payment notes, or private holdings.

## 3. Trading and accounting rules

### Units and collateral

- Store all prices and balances as integer ticks: **10,000 ticks = 1 credit**.
- Initially trade whole shares. A winning share pays 10,000 ticks; a losing share pays zero.
- Executable binary prices range from 1 to 9,999 ticks. Terminal outcomes display zero or one credit after resolution.
- Use integer arithmetic throughout the engine. Transfer large integer values through APIs as decimal strings and parse them safely; never use floating-point money arithmetic.
- Lock one credit to mint a complete set consisting of one YES and one NO share. Burning a complete set returns that credit before final resolution.
- Keep collateral in a dedicated escrow ledger account for each market. Never create unbacked shares, allow naked shorting, or permit negative available balances.
- Enforce per-order limits for price, quantity, total value, expiry, and integer overflow.
- Demo credit grants and adjustments are balanced ledger entries against explicit funding accounts. They are never unexplained edits to a balance column.

### Order book and matching

Implement price-time priority independently for each outcome. A buyer crosses an existing sell order when the buy limit is at least the sell price. Execute at the resting order's price, with a stable sequence as the tie breaker.

The first engine matches existing shares on the same outcome. It does not directly match complementary YES and NO buy orders into newly minted shares. Provide an explicit complete-set mint/burn action instead. The liquidity account uses that action to obtain funded inventory and quotes both outcomes. This supports the intended trading flow while keeping the initial matching logic reviewable.

Order rules:

1. Validate authentication, account status, market state, server-side closing time, order bounds, and idempotency key.
2. Reserve credits at `limit price × quantity` for buys, or reserve owned shares for sells.
3. Lock the market and relevant accounts in a deterministic order within one database transaction.
4. Match eligible opposite-side orders in price-time order; disallow self-trades and document a deterministic cancel-newest policy.
5. Transfer credits and shares atomically, record fills and balanced journal entries, and release any buy-side price improvement immediately.
6. Rest an unfilled limit remainder, or cancel and release an immediate-order remainder.
7. Commit a transactional outbox event and publish notifications only after the transaction commits.

Support good-until-cancelled, good-until-date, and immediate-or-cancel orders. Immediate trades are limit orders with a user-approved maximum buy price or minimum sell price, not unbounded market orders. Show executable depth, estimated total, maximum exposure, and possible partial execution before confirmation. Quotes expire and are recalculated server-side.

Cancellation and expiry release the remaining reservation exactly once. Existing fills remain final. Enforce the closing time inside trading transactions even when the background close job has not run. Serialize resolution, minting, burning, and matching with compatible locks so a close or pause cannot race a fill. Market-level serialization is adequate for the initial cohort; measure before optimizing.

### Liquidity

Use a dedicated, visibly identified liquidity account with a fixed credit budget and inventory limits. The administrator funds it explicitly, mints collateral-backed complete sets, and places bids/asks through the same validated trading operations as other participants.

Start with manual quotes. Add a bounded quotation worker after matching is reliable, with spread settings, maximum inventory, maximum exposure, pause conditions, and a kill switch. Label operator-provided liquidity. Do not simulate volume or fabricate fills.

Users must be able to see and handle empty books, one-sided books, insufficient depth, and stale quotes. A market without liquidity remains viewable, and resting limit orders can still be submitted.

### Resolution and cancellation

Use a lifecycle with explicit transition permissions:

`draft -> open -> closed -> proposed -> resolved`

- A separate trading-pause flag can suspend an open market without changing its close time.
- The proposal can return to `closed` when rejected or withdrawn, and can be replaced with a new proposal and challenge window.
- A market with no issued shares or fills may be cancelled without financial consequences.
- A traded market that cannot resolve goes through an invalid-result proposal and ends as `void` after review.

Lock question wording, outcomes, resolution criteria, primary/fallback sources, close time, timezone, and invalid-result policy when publishing. After publication, add visible clarifications without changing the contract's meaning. A materially incorrect contract requires pausing and the documented cancellation/void process, not a silent edit.

Each proposal records its evidence, proposer, proposed outcome, challenge deadline, and review status. Permit participants to challenge during a configurable window, defaulting to 24 hours. The resolver reviews challenges and must issue a fresh proposal/window when changing the outcome. Trading remains closed throughout this process. Conflicted administrators must not finalize their own disputed decisions; support a second resolver for an offline value trial.

For a binary final result, redeem winning shares at one credit and losing shares at zero, cancel all remaining orders, release reservations, and update portfolios. For an invalid binary market, redeem every YES and NO share at half a credit. This is a published collateral refund rule, not a reversal of historic trades. A trader's refund can differ from their purchase cost.

Settlement uses an immutable resolution version, unique per-position payout keys, and restartable transactional batches. Leave the market in a visible settling state until all payouts and reconciliations finish. A failed worker can resume without duplicate payouts. Finalized results cannot be silently overwritten; any exceptional correction needs a separate audited compensation process.

## 4. Offline settlement workflow

Keep offline payment settlement separate from market-result payouts, which occur automatically inside the ledger.

**Incoming credits:** administrator records a pending credit request using an opaque reference and amount. Pending requests do not increase available funds. After independently confirming the offline transfer, the administrator posts one balanced, idempotent credit entry. Reject or cancel unconfirmed requests without changing balances.

**Outgoing credits:** user requests a debit against available, unreserved credits. Reserve the amount immediately. The administrator marks the request ready, settles externally, and confirms completion once. Confirmation consumes the reservation through a balanced ledger entry. Cancelling before external settlement releases it. An ambiguous or failed external transfer stays reserved for manual reconciliation; never automatically release funds that may already have been paid.

Use explicit states such as `requested`, `approved`, `processing`, `completed`, `rejected`, and `cancelled`, with direction-specific allowed transitions. A correction is a compensating entry rather than an edit or deletion of history.

Do not collect bank account numbers, payment screenshots, identity documents, or external transaction details. Use an opaque internal reference; keep any necessary external records offline. Users see their own request status and amounts. Administrator actions require a reason code, confirmation screen, and recent authentication. Auditable business records stay in the private application database and never appear in operational logs.

## 5. Proposed architecture

| Component | Choice and purpose |
| --- | --- |
| Web application | Next.js with TypeScript for server rendering, accessible forms, authenticated application routes, and administrator screens. |
| Styling | Tailwind CSS with a small reusable accessible component set and original Jader-Market branding. |
| Database | Self-hosted PostgreSQL as the authoritative store for orders, positions, ledger, sessions, and market state. |
| Queries/migrations | Drizzle with versioned migrations, explicit constraints, and reviewed SQL for transaction-sensitive engine operations. |
| Authentication | A maintained self-hosted auth/session library selected during foundation work; invite-only handles, Argon2id password hashing, secure sessions, and offline recovery codes. Verify support before choosing the library. |
| Domain services | Framework-independent TypeScript modules for trading, accounting, resolution, permissions, and offline reconciliation. |
| Jobs | Separate Node.js worker using PostgreSQL-backed jobs and a transactional outbox for expiry, closure, notifications, chart aggregation, and settlement. |
| Live updates | Same-origin server-sent events with reconnect/cursor support; snapshot/polling fallback. Private streams recheck authorization. |
| Tests | Vitest for domain/integration tests and Playwright for browser workflows, with isolated PostgreSQL test databases. |
| Runtime | Docker Compose for local app/database/worker; self-hosted production with TLS termination, private database networking, and persistent volumes. |

The database is the source of truth. Browser state and live events never decide balances or fills. All state-changing requests pass through server-side validation and permission checks. Keep matching synchronous in short database transactions, and use background jobs for work that can be retried.

Start with one application instance and one worker. Coordinate by database locks and idempotency rather than process-local memory so later instance scaling does not corrupt accounting. Redis, external queues, and microservices are unnecessary initially.

Cache public market data only. Private pages, APIs, and events must not enter shared caches. Chart data comes from actual fills and defined sampling rules; unavailable intervals and low-volume markets must remain recognizable.

## 6. Data model and constraints

| Entity | Key fields and purpose |
| --- | --- |
| Users, invitations, credentials, sessions | Internal identifier, unique handle, roles, account state, hashed secrets, expiry, revocation, and recovery. |
| Events, markets, outcomes, categories | Grouping, immutable published rules, statuses, times, pause flag, outcome identity, and sources. |
| Ledger accounts, journals, entries | User cash, reservations, escrow, funding, balanced journal lines, operation key, and business reason code. |
| Holdings and share movements | Available/reserved quantity by owner/outcome, cost basis, mint/burn/trade/redemption provenance. |
| Orders and fills | Side, outcome, integer price/quantity, remaining quantity, reservation, sequence, execution price, and state. |
| Complete-set operations | Market, quantity, collateral transfer, resulting share movements, and unique operation key. |
| Resolution proposals, challenges, settlements | Version, evidence, deadlines, reviewer actions, final outcome, and unique payout records. |
| Offline requests and adjustments | Direction, opaque reference, amount, reservation, status transitions, authorizer, and idempotent ledger link. |
| Watchlists and notifications | User-scoped preferences, private messages, read state, and retention. |
| Outbox, jobs, private admin audit | Committed events, retry state, operation type, scoped actor record, and reconciliation results. |
| Comments and reports | Later milestone: public pseudonym, body, moderation state, and private reports. |

Enforce foreign keys, unique operation keys, allowed value checks, nonnegative quantities, valid tick ranges, and unique holdings per user/outcome. Use transactionally maintained balance projections backed by immutable journals; reconcile projections against journals. Application roles cannot update or delete finalized journal entries, fills, or published rules.

Required invariants:

- Every monetary journal balances to zero in its configured unit.
- Available and reserved cash/shares remain nonnegative.
- Unresolved complete sets maintain equal outstanding supply for all outcomes and enough escrow for every possible final result.
- Mint/burn operations change escrow and each outcome's supply together.
- Trades conserve cash and shares; every fill is backed by valid reservations.
- Remaining order reservations match remaining quantities and buy limits.
- Settlement never distributes more than locked collateral or pays a position twice.
- Replayed requests, events, and jobs produce no duplicate financial effects.

## 7. Privacy and security

- Keep private data in the operator-controlled deployment. Use synthetic data in development, CI, demos, screenshots, and seed files.
- Collect the minimum: pseudonymous handle and authentication material. Do not require email, a real name, or payment identifiers for the prototype.
- Do not send user records to analytics, telemetry, hosted error collectors, identity providers, or third-party AI services.
- Never log request bodies, query parameters, cookies, tokens, handles, user identifiers, amounts tied to users, payment references, or raw database errors. Configure reverse-proxy logs accordingly.
- Return generic user-safe errors with predefined error codes. Paths, filenames, headers, submitted values, and parse reasons are not safe diagnostic metadata.
- Keep necessary ownership and audit records as access-controlled business data in PostgreSQL, separate from operational logs. Public APIs never return those records.
- Use secure HttpOnly SameSite cookies, session rotation/revocation, CSRF protection, request origin checks, output encoding, a restrictive content security policy, and parameterized queries.
- Rate-limit sign-in, recovery, invitations, trading, and administrative actions. Store rate-limit state privately with short retention.
- Separate participant, market-editor, resolver, and finance-administrator permissions. Check permissions on every route and object, including event streams.
- Require administrator MFA and recent authentication for grants, offline confirmations, role changes, and resolution finalization. Provide an administrator session-revocation path.
- Store secrets outside git, restrict database permissions, encrypt host storage and backups, and test restoring backups to an isolated environment.
- Define retention and account deletion rules before onboarding. Delete optional profile/community information when appropriate; document the private financial records that must remain for reconciliation.
- Avoid arbitrary remote image fetches and external URLs in admin tooling. Render resolution sources as links without fetching them on the server. Sanitize community content.

## 8. Implementation milestones

Each milestone should become a small set of independently reviewable pull requests. Implement in this order because trading depends on ledger correctness and settlement depends on immutable market rules.

### Milestone 1: foundation and application shell

Deliver TypeScript/Next.js scaffolding, package/lockfile, reusable layout, PostgreSQL/Drizzle setup, migrations, local Docker Compose, synthetic fixtures, environment example, CI, and developer setup instructions. Add health/readiness endpoints and establish safe error handling before domain endpoints.

Acceptance: a fresh clone starts using documented commands, applies migrations, renders market/portfolio/admin shells, and passes type checks, lint, relevant tests, and production build without real credentials. No external telemetry is enabled. There is no live money or trading activation.

### Milestone 2: identities, permissions, and ledger

Deliver invite acceptance, sign-in/out, recovery codes, private account pages, sessions, administrator MFA, role checks, suspension, immutable journals, reservations, and idempotent grant/adjustment operations. Define the funding accounts and unit configuration. Add minimal administrator credit controls.

Acceptance: unauthorized users cannot read another account or perform an administrator action; concurrent reservations cannot overspend; duplicate credits apply once; replaying journals reproduces balances; operational logs contain no private values.

### Milestone 3: markets and lifecycle

Deliver market/event/category models, draft creation, validation, publish confirmation, immutable rules, public lists/details, search/filter/pagination, and pause/close controls. Add timezone-explicit dates and empty states.

Acceptance: drafts stay private; market-editor permissions are enforced; malformed or incomplete rules cannot publish; published terms cannot be silently rewritten; trading eligibility ends at the server-side close time.

### Milestone 4: shares, order book, and matching

Deliver complete-set mint/burn, share reservations, limit orders, matching, immediate-or-cancel, partial fills, order expiry/cancellation, self-trade prevention, outbox events, and a funded liquidity account. Add realistic synthetic books.

Acceptance: deterministic matching honors price-time priority; concurrent orders cannot double-spend; cancel/fill and close/fill races preserve invariants; an engine restart does not duplicate operations; escrow covers every final outcome. No UI can bypass server checks.

### Milestone 5: complete trading experience

Deliver responsive market page, executable-depth previews, buy/sell controls, open orders, live feeds, chart aggregation, portfolio, cost basis, transaction history, watchlists, and in-app notifications. Show unavailable executable quotes and valuation limits explicitly.

Acceptance: two invited users can trade end to end; an order partially fills and its remainder cancels correctly; reconnecting reconciles from authoritative snapshots; large lists remain usable; keyboard operation and narrow-screen controls work. Portfolio marks use disclosed rules and are not represented as guaranteed liquidation values.

### Milestone 6: resolution and offline reconciliation

Deliver proposal evidence, challenge window, dispute review, finalization, invalid results, restartable payouts, and full incoming/outgoing offline request workflows. Add an administrator reconciliation screen and an on-demand private export with explicit authorization and no public storage.

Acceptance: both binary outcomes and invalid results distribute the documented amounts; worker failure midway resumes exactly once; pending offline credits cannot be spent; pending outgoing debits cannot be spent twice; ambiguous external settlement stays reserved; reconciliation detects and blocks new financial actions when invariants fail.

### Milestone 7: expanded prototype features

Deliver mutually exclusive multi-outcome markets, grouped event pages, comments/reports/moderation, and the bounded liquidity worker. Keep user-created market drafts in a moderation queue if opened to participants; publication remains controlled.

Multi-outcome rules: mint one share of every outcome for one credit, exactly one outcome wins, and trading uses one order book per outcome. Publish the treatment of ties, none-of-the-above, and invalid results in advance. For invalid results, allocate 10,000 ticks across outcomes using a deterministic quotient/remainder allocation by immutable outcome order so each complete set refunds exactly one credit. Independent questions remain separate markets with separate collateral.

Acceptance: multi-outcome collateral and payouts reconcile for every winner and invalid result; moderation permissions and content safety checks hold; quotes respect liquidity budgets; grouped markets never imply shared collateral when they have none.

### Milestone 8: pilot readiness and operator handoff

Deliver self-hosted deployment guide, backup/restore drill, migration rollback or forward-repair procedure, worker supervision, safe health metrics, load measurements, and operator runbooks for pause, reconciliation failure, incident recovery, and account support. Review the applicable requirements before choosing any real-value pilot jurisdiction.

Acceptance: a fresh deployment and isolated restore work from documentation; the agreed pilot load meets measured response-time targets; critical browser workflows pass; there are no unresolved accounting failures or critical security findings; the operator can pause trading and resolve an offline request without developer access.

## 9. Verification strategy

Use meaningful tests of externally observable behavior and financial invariants:

- Domain tests for price-time order, partial fills, reservation release, cost basis, close-time boundaries, proposal transitions, payouts, and invalid-result arithmetic.
- Property-based/randomized trading sequences that continuously assert conservation, collateral coverage, and nonnegative balances.
- PostgreSQL integration tests with simultaneous clients for overspending, duplicate requests, cancellation races, closing/resolution races, deadlock retry, and settlement resume.
- Authorization tests across account pages, private APIs, administrator actions, exports, and live event streams.
- Browser tests for invitation/sign-in, market creation, two-account trading, order cancellation, portfolio updates, dispute handling, resolution, and manual settlement.
- Accessibility checks and realistic-volume fixtures for thousands of markets, orders, and history entries. Establish pilot traffic and latency targets before load testing.
- Backup restore and ledger reconciliation exercises, with synthetic fixtures only.

For every shipped code change, run available type checks, lint/framework checks, relevant tests, and a production build before declaring readiness. Include integration tests once the database exists. Report unavailable checks and their cause. Documentation-only changes need link/content and repository hygiene checks rather than application builds.

Apply one patch version bump per pull request that changes shipped code, relative to the target branch, keeping all version files synchronized. Reuse that bump for follow-up fixes. Apply the version before the final verification build and expose it in the application so the built artifact can be checked against source and the committed version. Documentation-only pull requests do not need a bump.

## 10. First implementation tasks and decisions

The next concrete work is **Milestone 1**, followed by **Milestone 2**. Do not start with a polished trading mockup that has no ledger behind it.

First implementation pull request:

1. Pin a supported Node.js version and dependency versions; scaffold Next.js/TypeScript and install database/test tooling.
2. Add Docker Compose, safe environment examples, initial migrations, and deterministic synthetic seed commands.
3. Add the compact application layout and market, portfolio, account, and administrator routes with honest empty states.
4. Establish safe errors, basic permission boundaries, and health/readiness checks.
5. Configure CI for type checks, lint, tests, migration checks, and build; document local setup and verification.

Resolve these decisions as they become necessary, rather than blocking repository creation:

| Decision | Proposed default | Needed by |
| --- | --- | --- |
| Prototype membership | Invite-only, public market browsing | Authentication implementation |
| Initial topics | A few objectively verifiable questions with published sources | Synthetic seed and first market pilot |
| Unit and redemption policy | Demo credits first; offline value conversion only after explicit configuration | Ledger configuration and any offline money trial |
| Initial liquidity | Separate manually funded account with explicit inventory limits | First executable trading pilot |
| Hosting | Operator-controlled app, worker, and PostgreSQL on a single host initially | Deployment milestone |
| Resolution responsibility | Named operator, separate reviewer for disputed real-value results | First published pilot market |
| Challenge window | 24 hours; configurable before publication | Resolution implementation |
| Multi-outcome scope | Mutually exclusive outcomes after the binary workflow passes | Expanded prototype milestone |
| License | Not selected; public visibility alone does not grant a software license | Before distributing reusable application code |

Completion of this plan means the repository and roadmap are ready. Completion of the prototype requires all milestone acceptance criteria, verified accounting, and the operator handoff.
