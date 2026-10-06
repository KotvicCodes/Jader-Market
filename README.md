# Jader-Market

A prediction market prototype inspired by Polymarket for a small closed community. The administrator is the sole oracle. Payments are settled offline and will be reflected in a private internal ledger.

**Status:** runnable application foundation. Published-market browsing, search, filtering, pagination, detail pages, migrations, synthetic fixtures, and health checks are implemented. Authentication, balances, trading, and resolution are not enabled yet.

## Try the demo

Open `http://localhost:3000/demo` after starting the app. This demo works without PostgreSQL or an account and has four fictional markets, sample probability charts, and practice buy/sell controls. Each market starts with 1,000 temporary demo credits. Choose an outcome, enter a whole number of shares, and submit a practice trade to see the balance and positions update. Selling only allows shares you already hold.

Demo quotes stay fixed and simulated trades fill instantly. They do not use a matching engine, submit participant orders, or affect community balances. The demo stores its state only in page memory; leaving or reloading a market resets it. Use **Reset demo** to start again. These examples demonstrate the interface; actual accounts, trading, offline funding, and oracle settlement remain the next implementation milestones.

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
```

Create the dedicated test database once. Integration tests require a `TEST_DATABASE_URL` ending in `_test` and only use synthetic records. The integration suite clears its market table, so never point it at a database containing records you want to retain. CI runs checks with a disposable PostgreSQL service.

For a production build, run `npm run build` and `npm start`. Project commands disable Next.js telemetry and keep temporary compiler files in `.cache/tmp`. This release is not ready for participant accounts or real-value trading.

Development dependency overrides replace the Next.js lint plugin's glob dependency with `tinyglobby` and use a patched esbuild version for migration/test tools. npm 11 is required to resolve the alias override. The install-script allowlist permits only the pinned native compiler and resolver installers.

## Planned capabilities

- Market discovery, search, categories, price history, and watchlists.
- Collateral-backed YES/NO shares, limit orders, immediate trading, and an order book.
- Accounts, balances, portfolio valuation, positions, and trade history.
- Administrator-managed accounts, market creation, direct oracle resolution, and cancellation.
- Auditable internal accounting and manual credit/debit workflows for offline settlement.
- Private notifications, accessible responsive screens, automated checks, and self-hosted operations.

## Next steps

1. Scaffold the application, local database, continuous integration, and test environment.
2. Implement authentication, roles, and the immutable balance ledger.
3. Implement market lifecycle rules and the trading engine before enabling live trading screens.
4. Build market discovery, trading, portfolio, and administrator workflows.
5. Add resolution, payouts, offline reconciliation, and operational verification.

Use synthetic data during development. Never commit credentials, real account information, payment records, exports, or agent instructions.
