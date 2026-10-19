# Participant portfolio

The private portfolio implements readiness item 3. Automated desktop, mobile/touch and keyboard workflows are provided by [pilot acceptance](PILOT_ACCEPTANCE.md). Follow the remaining operator checks in [readiness](READINESS.md#launch-checklist).

## Read your account

Sign in and open `/portfolio`. The server chooses the owner from the session, and reads all sections in one read-only repeatable-read transaction. Available credits, order reservations and offline-withdrawal reservations are separate. Holdings list nonzero available/reserved shares across markets. Shares are quantities, without estimated value, cost basis or profit/loss.

All open orders are shown separately from history, up to the existing account-wide maximum of 100. Order history includes completed and cancelled orders, original quantities, unfilled remainders, limits, duration and closure reasons. Fills show actual execution prices and totals; these totals are already reflected in transaction history and must not be added to the balance again. Payout receipts remain after settled shares disappear from active holdings, including losing positions receiving zero credits.

Transaction history includes every owner credit journal and share movement: admin adjustments, offline withdrawals, mint/burn, order reservations/releases, trades and settlement. A single operation may create several rows. Moving funds or shares into a reservation changes their location, not ownership. Buyer spending is selected through the buyer's ledger entries even when the trade journal names the seller. Withdrawal processing notes remain on `/withdrawals`; this history records financial movements, not every workflow event. Rows expose only the signed-in owner's movements, without counterparty orders, account IDs or raw operation responses.

## History and freshness

Each holdings, order, fill, transaction and payout section shows 20 rows per page with independent **Older** and **Latest** links. Paging one section preserves the others. Open-order cancellation remains available on every page. Holdings use a stable holding-ID cursor, orders/fills/payouts use creation sequence, and transaction history uses timestamp, source and ID with PostgreSQL microsecond precision. Invalid or repeated known cursor parameters are rejected. The same optional cursor parameters are available on authenticated `GET /api/account/portfolio`; amounts are integer strings in ticks (10,000 per credit), and private responses disable caching.

Active tabs poll authoritative state every 10 seconds and check it on reconnect/focus. **Refresh portfolio** and confirmed local cancellations also trigger a fresh read. Polling preserves every selected history cursor; it does not jump to the latest history page. Each page request is consistent, but successive history pages are separate snapshots and may include later changes. Return to **Latest** after new activity. See [Automatic refresh](AUTOMATIC_REFRESH.md) for item 4, freshness/error states, bounded backoff and session recovery.

## Cancel and recover

Choose **Cancel remaining … shares**, inspect the review, then **Confirm cancellation**. A fill may win the race; only an actually unfilled remainder is released. Orders remain cancellable while a market is paused or closed until the service has closed them.

Portfolio and market controls use the same per-account/market pending request in this browser tab's session storage. Submission saves the exact action, reference and body before sending. Uncertain responses preserve that record and block new requests in that market; **Retry same request** replays the original operation. The portfolio discovers this account's saved market requests independently of the open-order list. Earlier mint/order/cancellation requests remain recoverable after the last open order disappears, after history navigation and after reload. A saved request without a current open order is identified by its market reference. Keep browser data and the reference while uncertain; do not repeat the request on another device. A late response cannot erase a newer saved request. See [Participant trading](PARTICIPANT_TRADING.md#confirmation-and-recovery) for session/storage limitations.

## Rehearsal and deployment

Use fictional credits in isolated staging. Follow the [two-participant trading rehearsal](PARTICIPANT_TRADING.md#two-participant-rehearsal), checking both portfolios after mint, partial fill, cancellation and burn. Check reservations while a withdrawal is pending, then after cancellation/payment. Close and resolve YES, NO and invalid test markets; run the worker and verify the credit changes, removed holdings and persistent receipts. Page older history and cancel an order older than the latest history page. Confirm the other account's data stays private and an interrupted cancellation can be recovered with the same reference.

Apply all committed migrations using the stop/migrate/restart procedure in [production deployment](PRODUCTION_DEPLOYMENT.md). Automated tests cover reconciliation, concurrent snapshot consistency, pagination, privacy, settlement and cancellation recovery. Repeat the rehearsal on the intended deployment and physical devices before operator acceptance.
