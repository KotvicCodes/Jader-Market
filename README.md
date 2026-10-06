# Jader-Market

A planned prediction market prototype inspired by Polymarket. Users will browse questions, trade outcome shares, track positions, and receive payouts when markets resolve. Payments will be settled offline and reflected in a private internal ledger.

**Status:** planning only. There is no runnable application or trading service yet.

## Implementation plan

Read [the implementation plan](docs/IMPLEMENTATION_PLAN.md) for the product scope, trading rules, architecture, data model, security requirements, milestones, and acceptance criteria.

The proposed starting stack is TypeScript, Next.js, PostgreSQL, and Drizzle. The prototype will be self-hosted, use invite-only accounts, and avoid third-party analytics, wallet connections, payment gateways, and blockchain infrastructure.

## Planned capabilities

- Market discovery, search, categories, price history, and watchlists.
- Collateral-backed YES/NO shares, limit orders, immediate trading, and an order book.
- Accounts, balances, portfolio valuation, positions, and trade history.
- Administrator-managed market creation, resolution, disputes, and cancellation.
- Auditable internal accounting and manual credit/debit workflows for offline settlement.
- Private notifications, accessible responsive screens, automated checks, and self-hosted operations.

## Next steps

1. Scaffold the application, local database, continuous integration, and test environment.
2. Implement authentication, roles, and the immutable balance ledger.
3. Implement market lifecycle rules and the trading engine before enabling live trading screens.
4. Build market discovery, trading, portfolio, and administrator workflows.
5. Add resolution, payouts, offline reconciliation, and operational verification.

Use synthetic data during development. Never commit credentials, real account information, payment records, exports, or agent instructions.
