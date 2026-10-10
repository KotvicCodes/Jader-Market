# Trading backend prototype

This milestone adds PostgreSQL-backed trading APIs. The trading interface and sole-oracle payouts are the next two milestones. Existing practice markets remain a separate simulation; their temporary balances do not fund real orders.

## Rules

- 10,000 ticks equal one internal credit. Financial quantities in JSON are decimal strings, never floating-point numbers.
- Prices are integers from `"1"` to `"9999"`. Quantities are whole shares from `"1"` to `"1000000"`.
- Minting locks one credit per complete pair in a market escrow and creates one YES and one NO share. Burning an available pair returns its one credit. Reserved shares cannot be burned.
- YES and NO have separate books. Buyers purchase already owned shares from sellers. Complementary buy orders do not automatically mint shares.
- Matching uses best price, then the resting order's database sequence. Execution uses the resting order's price. Buy orders reserve their limit price multiplied by quantity. Price improvement returns to available credits immediately.
- Selling requires owned shares. The engine reserves shares before matching and never permits naked selling. Self-trading cancels the newest order's remaining quantity, preserving any earlier fills.
- GTC rests until cancellation or market closure. GTD requires a future explicit UTC expiry at or before the market deadline. IOC executes within its limit and cancels any remainder. Unbounded market orders are unavailable.
- A paused market keeps its resting reservations and rejects new orders, minting and burning. Owners can cancel during a pause. Permanent closure and account suspension cancel affected orders and release reservations atomically. Minting and burning also stop at the market deadline; payout redemption will be separate.
- There are at most 100 open orders per owner across markets and 200 per market. New orders beyond those limits are rejected. Book depth is bounded by the market limit. The matching transaction examines at most 200 resting orders.
- Participants cannot generate credits. Trade proceeds and burns move already-backed credits. Only the administrator can issue credits through the existing credit controls.

## APIs

Mutation requests require the existing authenticated session, exact `Origin`, JSON content type, and `X-CSRF-Token`. They use the existing mutation rate limit of 60 requests per minute per session and a 4 KiB body limit. Responses and private reads are `no-store`; errors contain predefined safe codes.

| Endpoint | Request or response |
| --- | --- |
| `POST /api/trading/mint` | `{ "marketId": "UUID", "operationKey": "UUID", "quantity": "5" }` |
| `POST /api/trading/burn` | Same fields as mint; requires available YES and NO inventory. |
| `POST /api/trading/place` | `{ "marketId": "UUID", "operationKey": "UUID", "outcome": "YES", "side": "buy", "price": "2500", "quantity": "5", "timeInForce": "GTC" }`. `GTD` adds `expiresAt`, for example `"2027-06-01T12:00:00Z"`. Returns the final order and its immediate fills. |
| `POST /api/trading/cancel` | `{ "marketId": "UUID", "operationKey": "UUID", "orderId": "UUID" }`. Only the order owner may cancel. Terminal orders return their current state without another release. |
| `GET /api/markets/:id/book` | Public effective status, executable flag, aggregated YES/NO price levels, and recent anonymous fills. No account IDs, order IDs, handles, balances, or audit data. Bids and asks are ordered best price first within each outcome and side. |
| `GET /api/markets/:id/portfolio` | Session owner's available/reserved credit ticks across all markets, holdings in this market, orders and fills. Ownership is derived from the session, never a submitted user ID. |

Each mutation needs a fresh operation UUID. Retrying the same normalized request returns its immutable original response, including after its order has expired or its market has closed. Reusing a key for different input or another owner returns `operation_conflict`. Authentication and account state are checked on every retry. GTD retries validate the original expiry's syntax before replay lookup, then check its time only for a new operation.

Order state is `open`, `filled`, `cancelled`, or `expired`. Terminal cancelled/expired orders retain their unfilled `remaining` for audit; they reserve nothing. A fill's winning-share value is not yet paid out automatically. Oracle resolution and payout accounting are a subsequent PR.

Reads use consistent database snapshots. Public fills and private order history have pages of 50, with a decimal `nextCursor`; pass `?before=CURSOR` for the next page. Private fill history has its own `nextFillCursor` and `?beforeFill=CURSOR`. Private executions identify only the owner's order and side. Draft markets return 404 from both reads and trading operations.

The existing portfolio page's balance history remains limited to administrator credit/debit adjustments. Trading history is available through the private API until the trading UI PR.

## Worker and event delivery

Run the application migrations before starting the app or worker:

```sh
npm run db:migrate
npm run worker
```

The worker checks once per second. `npm run worker -- --once` runs one maintenance pass and exits, suitable for a supervised scheduler. Each pass processes at most 20 affected markets with their bounded order books. Repeating or restarting maintenance does not release a reservation twice. Expired quotes are filtered from public reads immediately, and matching removes stale makers even if maintenance has been delayed. The market deadline is enforced inside trading transactions independently of the worker. Balances can remain reserved until maintenance or an owner cancellation when only the deadline has passed.

Financial writes acquire one shared PostgreSQL transaction advisory lock before any user, session, market, or balance row lock. Sign-in, host administrator recovery, account controls, market controls and the worker follow the same order. This intentionally serializes writes across processes for the small community and avoids cross-market wallet races and deadlocks between traders and administrators. Read snapshots do not take that write lock. Higher throughput will require a separate, measured lock-partitioning change.

`trading_outbox` stores immutable events in the transaction that changed the market. Public records contain only market invalidations or outcome/price/quantity executions. Private records are owner-scoped order or portfolio invalidations. No events are published before commit. Stream delivery, retention/acknowledgements and reconnection are part of the trading UI PR; this worker performs expiry only. Do not expose the table directly through a public endpoint.

The migration retains administrator-only issuance guards and adds trading journal shapes, escrow coverage, share projections, order reservations, fill/order linkage, immutable history and commit-time eligibility checks. The database is authoritative; in-memory responses and browser state cannot post balances.

## Quick verification

Use a dedicated disposable PostgreSQL database whose name ends in `_test`, configured as `TEST_DATABASE_URL`. The database role needs `CREATEDB` for the isolated integration and HTTP suites. Never point tests at the community database. HTTP migrations and fixtures use a disposable per-run database and leave the configured test database unchanged. Production sign-in requires the trusted proxy configuration described in README; the HTTP suite supplies a synthetic trusted header on its loopback test server.

```sh
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
npm run test:http
```

The integration suite exercises mint/burn, resting-price execution in both directions, FIFO, partial fills, reservations, refunds, IOC/GTD/GTC, cancel-newest self-trade prevention, concurrent retries, cross-market overspending, share races, cancellation/fill and closure races, suspension, expiry, history bounds and database tampering. A deterministic mixed trading sequence checks collateral conservation after each step.

The production HTTP suite creates synthetic administrator/participant accounts, signs in, grants internal credits, publishes a synthetic market, mints pairs, places an ask and executes a purchase from a second account. It checks CSRF/origin protections, owner isolation, anonymous depth, partial fills, balances, private execution history and close-time releases, and confirms the built health version matches `package.json`. It finishes with a pass/fail message containing no credentials or user values.

For an initial manual pilot after the UI arrives, create two ordinary participant accounts, grant each a small credit balance, have one mint pairs and offer shares, then have the other buy them. A manually funded liquidity account uses these same operations; there is no privileged liquidity endpoint or fabricated executable quote.
