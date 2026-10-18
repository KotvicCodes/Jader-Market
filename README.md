# Jader-Market

A prediction market prototype inspired by Polymarket for a small closed community. The administrator is the sole oracle. Payments are settled offline and recorded in a private internal ledger.

**Status:** accounts, credits, market administration, and participant trading prototype. Administrator-created accounts, sign-in, administrator MFA, persistent private balances/history, audited credit adjustments, private market drafts, immutable publication, and pause/resume/close controls are implemented. Persistent trading APIs support complete sets, reservations, order matching, and cancellation. Authenticated market pages provide reviewed mint/burn, buy/sell limit orders, partial-fill feedback, holdings, open-order cancellation and recent fills. The private portfolio shows cross-market holdings, all open orders with cancellation, paginated fills and credit/share history, and payout receipts. Active market and portfolio tabs poll authoritative snapshots with visible freshness, reconnect checks and bounded retry delays. Direct oracle resolution and collateral-funded payouts are implemented. A trusted-host reconciliation command checks internal accounting and independently verified external payment records.

## Accounts and credits

For an existing local checkout, stop the app and run:

```sh
npm run db:migrate
npm run admin:create
npm run dev
```

`admin:create` runs in an interactive terminal. Choose a handle and a password of 12 to 128 characters; passwords are hidden and never passed as command arguments. It validates the handle and matching passwords, checks the current schema and existing administrator, and serializes operator setup before generating a private `AUTH_SECRET` in `.env` if needed. Failed setup restores any generated configuration. An empty exported `AUTH_SECRET` must be removed before using a saved `.env` key; setup never replaces a masked saved key. It then creates the sole administrator with zero credits. There are no default sign-in credentials. Restart the app after initial setup so it loads the generated key.

Administrator setup/recovery, migrations, seeding, reconciliation, and the worker use the existing JavaScript TypeScript compiler, without loading tsx or esbuild. Use the pinned Node.js 22.22.1 version. This lets those commands start even when a shared checkout contains dependencies installed on another operating system. Development, builds, and test tooling still need dependencies installed for their host: if esbuild or another native dependency reports a Linux/macOS mismatch, stop the app and run `npm ci` on that host. Avoid sharing `node_modules` between Linux and macOS checkouts. Neither reinstalling dependencies nor these script changes remove `.env` or database data.

1. Open `/account`, sign in, and enable your authenticator using the private setup key and a six-digit code. The authenticator uses standard time-based codes (SHA-1, six digits, 30 seconds).
2. Open `/admin` and create a participant. New accounts always start with zero credits. Give the initial password to that participant privately; they can change it on `/account`.
3. Select the participant in **Credit adjustment**, enter an amount, choose a reason, check the confirmation, and submit. Only administrators can issue or remove credits. The account selector shows the current page of search results.
4. In an incognito window, sign in as the participant and open `/portfolio`. Reload or sign out/in to verify that the balance and history persist. Participants cannot access administrator controls or another person's balance.

Use **Demo credit grant** for prototype credits. Offline credits are posted only after the administrator independently confirms receipt. Offline withdrawals reserve credits before payment processing; use `/withdrawals` and `/admin/withdrawals`. Debits cannot take an account below zero. These credit grants/corrections are immediate adjustments. Outgoing offline payments use the reserved withdrawal workflow described in [Offline withdrawals](docs/OFFLINE_WITHDRAWALS.md); pending incoming transfer requests remain future work. Trading APIs reserve existing credits and owned shares. Final payouts transfer existing market collateral to holders; participants cannot mint payout credits. The `/demo` practice balances remain temporary and separate.

Administrator controls require MFA and authentication within the last 10 minutes. Refresh access on `/account` when prompted. Authenticator codes cannot be reused; wait for a fresh code after sign-in or enrollment before reauthenticating. Sessions expire after 24 hours, and sign-out-all, suspension, and password resets revoke sessions. Participant recovery is handled by the administrator. Sole-administrator recovery uses `npm run admin:recover` on the trusted local host; it resets the administrator password and authenticator, revokes sessions, and records an audit event. It requires the existing `AUTH_SECRET`; restore that key from the private backup if it is missing. Recovery does not generate a replacement key. It is never available through a public route.

Keep `.env` and its generated `AUTH_SECRET` private and back it up with the private database. Losing or changing the key invalidates existing authenticator secrets. Set `APP_ORIGIN` to the exact browser origin; HTTPS is required beyond loopback, and session cookies are Secure on HTTPS. The local prototype defaults to `http://localhost:3000`.

Production sign-in requires `AUTH_TRUSTED_IP_HEADER`, for example `x-real-ip`, supplied by your trusted reverse proxy. The proxy must overwrite any inbound value with the actual client address, and the app port must accept connections only from that proxy. A single IPv4 or IPv6 address is required; forwarded lists, ports and missing values are rejected. Arbitrary `X-Forwarded-For` headers are ignored unless that specific header is configured and contains one address. Production sign-in returns a safe configuration error until this is configured. `npm run dev` uses one local-development identity for local testing; keep that mode on the trusted development host.

Login limits apply to a client address (30 attempts per 15 minutes) and that address plus the normalized handle (10 attempts per 15 minutes). There is no shared global or handle-only login bucket that one client can exhaust to lock out another address. Only keyed HMAC identifiers are stored in the private rate-limit table, with records older than 24 hours pruned during sign-in; addresses and handles are never written to logs or returned in errors. IPv6 aliases and IPv4-mapped addresses share a canonical bucket. Users sharing the same public address share its login budget. Distributed attacks need protections at the trusted proxy.

Passwords use Node's salted scrypt (N=32768, r=8, p=3). Sessions use random opaque tokens stored as hashes, HttpOnly/SameSite cookies, explicit origin and CSRF checks, and database-backed rate limits with hashed keys. Ledger amounts use 10,000 integer ticks per credit. Database triggers enforce balanced, append-only adjustment journals and matching balance projections. Private account/admin responses disable caching; request values and database errors are never logged by the application.

## Create and manage a market

For an existing checkout with accounts already configured, run `npm run db:migrate` and restart the app. The market migration adds pause state, revisions, and immutable administration history without changing existing markets or balances.

1. Sign in as the administrator, open `/admin`, and choose **Manage markets**. Reconfirm access if prompted.
2. Choose **Create draft**. Enter a YES/NO question, description, category, UTC closing time, precise resolution rules, and the source you will use as sole oracle. Drafts remain private and can be edited repeatedly.
3. Save edits, then choose **Review publication**. This shows the saved terms. Confirm and publish. Publication requires a future deadline and permanently locks the question, description, category, deadline, rules, source, and URL.
4. In an incognito window, open `/` and verify that the published market appears. It should have been inaccessible before publication.
5. Use the market's admin page to pause, resume, or permanently close it. Reload the public page to see its current state. Expired markets display as closed on the next page request, even if no background worker has updated their stored status. Expired or closed markets cannot resume.

Each change records a private append-only audit entry. Stale edits are rejected rather than overwriting another saved revision. Retrying the same request is safe; if you lose a response, check the saved state/history before starting a different request. There is no delete or reopen control for published markets. Published non-synthetic open markets accept authenticated trading API operations. Seeded browsing examples reject minting and order placement; the worker cancels any legacy resting orders on those examples. Owners can still burn available legacy YES/NO pairs for their backed credits while the market is open and unpaused. After explicitly closing a market, record its final YES, NO, or invalid result with public evidence on the admin page. This resolution is immutable. The worker pays winning shares 1 credit each, losing shares zero, or refunds each outcome share 0.5 credits for an invalid result. The fixed policy is shown before publication. Suspended holders retain their entitlements. Keep the worker running until the market changes from settling to resolved or void; private payout receipts appear in the portfolio. See [the trading backend guide](docs/TRADING_BACKEND.md) for mint/burn, order placement, cancellation, and worker setup.

## Trade through a market page

Sign in as an ordinary participant and open a published non-synthetic market. Review the current order book, available credits and owned shares. Choose buy/sell, outcome, whole-share quantity, limit price in credits and duration; **Review order** shows the maximum credit reservation or owned-share reservation before **Confirm order** submits it. Prices support four decimal places. Immediate-or-cancel may fill partly; other orders keep their remaining reservation until cancellation, expiry or closure.

Use **Mint complete sets** to lock one credit per YES/NO pair and **Burn complete sets** to return one credit per available pair. Reserved shares cannot be burned. **Your open orders** lists every open order in this market, including those older than the recent history page, with a reviewed cancellation action. Holdings and recent fills are private to your account.

The browser saves the exact pending operation in session storage before submission. A lost response blocks new operations and offers **Retry same request**, including after a reload or sign-in; replay returns the original result without spending twice. Keep browser data while a request is unconfirmed. If storage is blocked or corrupt, resolve that condition or reconcile with the operator before continuing. Active tabs check current state every 10 seconds and on reconnect/focus; **Refresh market** is also available. Stale or offline state pauses submissions, and changed balances/orders/quotes require a new review. The private portfolio provides cross-market history and cancellation. See [Participant trading](docs/PARTICIPANT_TRADING.md) for the two-participant acceptance workflow and [Automatic refresh](docs/AUTOMATIC_REFRESH.md) for reconnect behavior and limits.

## Review your portfolio

Open `/portfolio` after signing in. Available credits and separate order/withdrawal reservations accompany holdings across markets, all open orders with reviewed cancellation, fills, complete credit/share movement history and payout receipts. Use each section's **Older** and **Latest** links independently; history pagination never hides an open order's cancellation control. Active tabs update automatically without changing the selected history cursors; **Refresh portfolio** is also available. All sections come from one consistent database snapshot; share quantities do not imply a valuation or profit. See [Participant portfolio](docs/PARTICIPANT_PORTFOLIO.md) for history semantics, cancellation recovery and a rehearsal.

## Reconcile accounting and offline payments

Run `npm run reconcile` on the trusted host for a read-only, consistent-snapshot JSON report. Internal checks cover ledger/holding projections, collateral, order/withdrawal reservations, fills and payouts. Without external evidence, a clean report exits 2 and marks payments unchecked. Supply `npm run reconcile -- --external-register /private/market-receipts.json` to compare a complete independently verified receipt register with recorded incoming/outgoing transfers. A full pass exits 0; discrepancies exit 1; unavailable/invalid runs exit 3. Use `npm run --silent reconcile` when redirecting machine-readable JSON.

See [Operator reconciliation](docs/OPERATOR_RECONCILIATION.md) for the register format, payment checks and incident response. Run it after every pilot session and around payment batches; stop payments and new credit issuance on discrepancies. Reports and receipt registers are private. The command performs no repairs or transfers, and does not satisfy the remaining production deployment, recovery or acceptance gates.

## Try the demo

Open `http://localhost:3000/demo` after starting the app. This demo works without PostgreSQL or an account and has four fictional markets, sample probability charts, and practice buy/sell controls. Each market starts with 1,000 temporary demo credits. Choose an outcome, enter a whole number of shares, and submit a practice trade to see the balance and positions update. Selling only allows shares you already hold.

Demo quotes stay fixed and simulated trades fill instantly. They do not use a matching engine, submit participant orders, or affect community balances. The demo stores its state only in page memory; leaving or reloading a market resets it. Use **Reset demo** to start again. Persistent trading controls live on published market pages and use your account balance. They are separate from these practice controls.

## Implementation plan

Read [the implementation plan](docs/IMPLEMENTATION_PLAN.md) for the product scope, trading rules, architecture, data model, security requirements, milestones, and acceptance criteria.

The stack is TypeScript, Next.js, PostgreSQL, and Drizzle. The prototype is intended to be self-hosted, with administrator-managed accounts and no third-party analytics, wallet connections, payment gateways, or blockchain infrastructure. There will be no disputes in the first version.

## Local development

Use Node.js 22.22.1, npm 11.21.0, and Docker Compose. Run these commands inside the repository:

```sh
cp .env.example .env
chmod 600 .env
npm ci
docker compose up -d --wait db
npm run db:migrate
npm run db:seed
npm run dev
```

Open `http://localhost:3000`. The three seed markets are clearly labelled fictional examples, and running the seed again does not duplicate them. The local database port binds to loopback only. All example credentials are synthetic development values and must be replaced before deployment. Keep `.env` private.

The UI also runs without a database and displays an honest unavailable state. `/api/health` reports the application version; `/api/ready` returns 503 until the current migrations, required schema and enabled application triggers, authentication key, origin, and production trusted-proxy header configuration are available. Readiness does not certify proxy networking or worker health; verify those during deployment. `npm run worker` performs durable order-expiry maintenance and resumable market payouts. Use `npm run worker -- --once` for one pass, or keep the worker running for expiry checks and bounded payout batches.

## Production deployment

Read [Production deployment and operations](docs/PRODUCTION_DEPLOYMENT.md) for the isolated app/worker/database/proxy deployment, restricted runtime grants, HTTPS acceptance, safe worker monitoring and alert setup. `npm run test:deployment` rehearses the stack with disposable synthetic data. Actual-host acceptance, backup/restore (item 7), and browser/load checks remain required.

## Verification

```sh
npm run verify
docker compose exec -T db createdb -U jader jader_market_test
npm run test:integration
npm run build
npm run test:http
```

Create the dedicated test database once. Integration tests require a `TEST_DATABASE_URL` ending in `_test` and only use synthetic records. Browsing, bootstrap, market lifecycle and HTTP checks create and drop disposable databases, so the test role needs CREATEDB permission. Other integration suites retain synthetic fixtures in the dedicated test database. HTTP migrations and synthetic account records never modify the configured control database. Never use a database containing records you want to retain. CI runs checks with a disposable PostgreSQL service. HTTP checks start the verified production build on loopback port 3107, run account/MFA/credit/market/trading/privacy workflows using synthetic accounts, verify the built version, and stop it automatically.

### Browser and load acceptance status

Additional checks of [PR #11](https://github.com/KotvicCodes/Jader-Market/pull/11) on 2026-10-18 used a local production build and disposable accounts/data. These were one-off checks, not browser or load suites run by `npm run verify`:

- **Completed:** Chromium 154 and WebKitGTK 2.52.6 engine checks covered keyboard trade confirmation and refreshed results. WebKit also covered sign-in, failed reads, browser Back, and explicit recovery after a committed mutation's response was lost; Chromium covered session revocation. Market and populated portfolio pages passed automated accessibility scans. A keyboard focus defect in scrolling tables was corrected and retested.
- **Layout coverage:** Chromium checks at 320, 390, 412 and 1440 CSS pixels found no page-level horizontal overflow. WebKitGTK's minimum actual window width was 447 pixels. These are engine and viewport checks, not native Android/iOS, Chrome, Brave or Safari certification.
- **Still unverified:** native Android and iOS browsers/devices, desktop Firefox, Brave and Safari, and screen-reader usability. Firefox's test binary download was blocked; the other native targets were unavailable. Automated accessibility scans and keyboard checks do not establish complete accessibility compliance.
- **Local load only:** short stages simulated 25, 50 and 100 participants polling market and portfolio snapshots every 10 seconds, with two mint operations per second across a 100-account fixture pool. Reconnect bursts reached 200 simultaneous reads. All 1,964 requests succeeded, and 240 unique mints plus 24 retries reconciled with balances, holdings and the ledger. This does not establish sustained production capacity or load performance for heavy order matching or bulk settlement.

Remaining browser risks can affect transactions, not only appearance: mobile tab suspension, connectivity loss, sessions and browser storage can disrupt freshness or pending-request recovery. Before expanding beyond a small pilot with fictional credits, check an actual iPhone with Safari and an Android phone with Chrome: sign in, confirm a trade, background/reopen the browser, disconnect/reconnect, and verify balances and recovery of an unconfirmed request. Complete the remaining browser/device and operational acceptance before real-money operation.

For a production build, run `npm run build`, configure the trusted proxy as described above, and run `npm start`. Project commands disable Next.js telemetry and keep temporary compiler files in `.cache/tmp`. Trading is available through authenticated APIs and reviewed participant controls, and operator reconciliation is implemented. Production deployment/recovery and browser/load acceptance remain outstanding. Direct oracle resolution and collateral-funded payouts are implemented.

Development dependency overrides replace the Next.js lint plugin's glob dependency with `tinyglobby` and use a patched esbuild version for migration/test tools. npm 11 is required to resolve the alias override. The install-script allowlist permits only the pinned native compiler and resolver installers.

## Planned capabilities

- Price history and watchlists for community markets.
- Portfolio valuation and advanced market charts.
- Pending incoming offline-credit requests.
- Private notifications and deployment/backup verification.

## Next steps

1. Merge and rehearse the feature stack in staging, including [operator reconciliation](docs/OPERATOR_RECONCILIATION.md) (readiness item 5).
2. Prove deployment, backups and recovery (items 6–7).
3. Complete the remaining native browser/device, assistive-technology and sustained deployment-load acceptance before real-money operation (item 8).

Use synthetic data during development. Community trading tests should use explicitly created test markets; the seeded browsing examples are not tradable. Never commit credentials, real account information, payment records, exports, or agent instructions.

Browser and pilot-load acceptance: see [the isolated rehearsal and agreed thresholds](docs/PILOT_ACCEPTANCE.md).
