# Jader-Market

A prediction market prototype inspired by Polymarket for a small closed community. The administrator is the sole oracle. Payments are settled offline and recorded in a private internal ledger.

**Status:** accounts and credits prototype. Administrator-created accounts, sign-in, administrator MFA, persistent private balances/history, and audited credit adjustments are implemented alongside market browsing and practice markets. Actual trading and oracle payouts are not enabled yet.

## Accounts and credits

For an existing local checkout, stop the app and run:

```sh
npm run db:migrate
npm run admin:create
npm run dev
```

`admin:create` runs in an interactive terminal. Choose a handle and a password of 12 to 128 characters; passwords are hidden and never passed as command arguments. It validates the handle and matching passwords and checks database readiness before generating a private `AUTH_SECRET` in `.env` if needed, then creates the sole administrator with zero credits. There are no default sign-in credentials. Restart the app after initial setup so it loads the generated key.

Administrator setup/recovery, migrations, seeding, and the worker use the existing JavaScript TypeScript compiler, without loading tsx or esbuild. Use the pinned Node.js 22.22.1 version. This lets those commands start even when a shared checkout contains dependencies installed on another operating system. Development, builds, and test tooling still need dependencies installed for their host: if esbuild or another native dependency reports a Linux/macOS mismatch, stop the app and run `npm ci` on that host. Avoid sharing `node_modules` between Linux and macOS checkouts. Neither reinstalling dependencies nor these script changes remove `.env` or database data.

1. Open `/account`, sign in, and enable your authenticator using the private setup key and a six-digit code. The authenticator uses standard time-based codes (SHA-1, six digits, 30 seconds).
2. Open `/admin` and create a participant. New accounts always start with zero credits. Give the initial password to that participant privately; they can change it on `/account`.
3. Select the participant in **Credit adjustment**, enter an amount, choose a reason, check the confirmation, and submit. Only administrators can issue or remove credits. The account selector shows the current page of search results.
4. In an incognito window, sign in as the participant and open `/portfolio`. Reload or sign out/in to verify that the balance and history persist. Participants cannot access administrator controls or another person's balance.

Use **Demo credit grant** for prototype credits. Offline credit/debit entries are posted only after the administrator independently confirms the transfer. Debits cannot take an account below zero. These are immediate confirmed adjustments; pending withdrawal requests and reservations will be added with trading. Winning bets will pay from market collateral in the resolution milestone, not mint new credits through a participant endpoint. The `/demo` practice balances remain temporary and separate.

Administrator controls require MFA and authentication within the last 10 minutes. Refresh access on `/account` when prompted. Authenticator codes cannot be reused; wait for a fresh code after sign-in or enrollment before reauthenticating. Sessions expire after 24 hours, and sign-out-all, suspension, and password resets revoke sessions. Participant recovery is handled by the administrator. Sole-administrator recovery uses `npm run admin:recover` on the trusted local host; it resets the administrator password and authenticator, revokes sessions, and records an audit event. It requires the existing `AUTH_SECRET`; restore that key from the private backup if it is missing. Recovery does not generate a replacement key. It is never available through a public route.

Keep `.env` and its generated `AUTH_SECRET` private and back it up with the private database. Losing or changing the key invalidates existing authenticator secrets. Set `APP_ORIGIN` to the exact browser origin; HTTPS is required beyond loopback, and session cookies are Secure on HTTPS. The local prototype defaults to `http://localhost:3000`.

Production sign-in requires `AUTH_TRUSTED_IP_HEADER`, for example `x-real-ip`, supplied by your trusted reverse proxy. The proxy must overwrite any inbound value with the actual client address, and the app port must accept connections only from that proxy. A single IPv4 or IPv6 address is required; forwarded lists, ports and missing values are rejected. Arbitrary `X-Forwarded-For` headers are ignored unless that specific header is configured and contains one address. Production sign-in returns a safe configuration error until this is configured. `npm run dev` uses one local-development identity for local testing; keep that mode on the trusted development host.

Login limits apply to a client address (30 attempts per 15 minutes) and that address plus the normalized handle (10 attempts per 15 minutes). There is no shared global or handle-only login bucket that one client can exhaust to lock out another address. Only keyed HMAC identifiers are stored in the private rate-limit table, with records older than 24 hours pruned during sign-in; addresses and handles are never written to logs or returned in errors. IPv6 aliases and IPv4-mapped addresses share a canonical bucket. Users sharing the same public address share its login budget. Distributed attacks need protections at the trusted proxy.

Passwords use Node's salted scrypt (N=32768, r=8, p=3). Sessions use random opaque tokens stored as hashes, HttpOnly/SameSite cookies, explicit origin and CSRF checks, and database-backed rate limits with hashed keys. Ledger amounts use 10,000 integer ticks per credit. Database triggers enforce balanced, append-only adjustment journals and matching balance projections. Private account/admin responses disable caching; request values and database errors are never logged by the application.

## Try the demo

Open `http://localhost:3000/demo` after starting the app. This demo works without PostgreSQL or an account and has four fictional markets, sample probability charts, and practice buy/sell controls. Each market starts with 1,000 temporary demo credits. Choose an outcome, enter a whole number of shares, and submit a practice trade to see the balance and positions update. Selling only allows shares you already hold.

Demo quotes stay fixed and simulated trades fill instantly. They do not use a matching engine, submit participant orders, or affect community balances. The demo stores its state only in page memory; leaving or reloading a market resets it. Use **Reset demo** to start again. These examples demonstrate the interface; community trading and oracle settlement remain future milestones. Participant accounts and confirmed offline credit/debit adjustments already use the persistent private ledger.

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

The UI also runs without a database and displays an honest unavailable state. `/api/health` reports the application version; `/api/ready` returns 503 until the configured database and market table are available. `npm run worker` is currently a connectivity check, not a running job service.

## Verification

```sh
npm run verify
docker compose exec -T db createdb -U jader jader_market_test
npm run test:integration
npm run build
npm run test:http
```

Create the dedicated test database once. Integration tests require a `TEST_DATABASE_URL` ending in `_test` and only use synthetic records. Browsing, bootstrap and HTTP checks create and drop disposable databases, so the test role needs CREATEDB permission. Other integration suites retain synthetic fixtures in the dedicated test database. HTTP migrations and synthetic account records never modify the configured control database. Never use a database containing records you want to retain. CI runs checks with a disposable PostgreSQL service. HTTP checks start the verified production build on loopback port 3107, run account/MFA/credit/privacy workflows using synthetic accounts, verify the built version, and stop it automatically.

For a production build, run `npm run build`, configure the trusted proxy as described above, and run `npm start`. Project commands disable Next.js telemetry and keep temporary compiler files in `.cache/tmp`. Participant accounts and confirmed credit adjustments are available; community trading and oracle payouts remain unfinished.

Development dependency overrides replace the Next.js lint plugin's glob dependency with `tinyglobby` and use a patched esbuild version for migration/test tools. npm 11 is required to resolve the alias override. The install-script allowlist permits only the pinned native compiler and resolver installers.

## Planned capabilities

- Price history and watchlists for community markets.
- Collateral-backed YES/NO shares, limit orders, immediate trading, and an order book.
- Portfolio valuation, positions, and trade history.
- Market creation, direct oracle resolution, and market cancellation.
- Pending offline settlement requests and reservations.
- Private notifications and deployment/backup verification.

## Next steps

1. Implement administrator market creation, publication, and close/pause rules.
2. Implement collateral-backed shares, reservations, order matching, and cancellation.
3. Connect participant trading, positions, and live market updates.
4. Add direct oracle resolution and collateral-funded winning payouts.
5. Add pending offline settlement workflows and deployment/backup verification.

Use synthetic data during development. Never commit credentials, real account information, payment records, exports, or agent instructions.
