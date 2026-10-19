# Participant trading controls

Published market pages now use the existing authenticated trading API for complete-set mint/burn, limit orders and cancellation. This implements readiness checklist item 2. The cross-market portfolio implements item 3; see [Participant portfolio](PARTICIPANT_PORTFOLIO.md). Bounded automatic refresh and reconnect handling implement item 4; see [Automatic refresh](AUTOMATIC_REFRESH.md). [Operator reconciliation](OPERATOR_RECONCILIATION.md) implements item 5; [deployment](PRODUCTION_DEPLOYMENT.md), [recovery](BACKUP_RECOVERY.md) and [browser/load](PILOT_ACCEPTANCE.md) rehearsals are implemented, with host and operator acceptance tracked in [readiness](READINESS.md).

## Two-participant rehearsal

Use an isolated staging database and fictional credits first. Seeded synthetic browsing examples intentionally reject minting and new orders; create a published non-synthetic test market with a future deadline.

1. The administrator creates two ordinary participant accounts, Alice and Bob, and explicitly grants each 100 fictional credits. Use two separate browser sessions.
2. Alice opens the market, selects **Mint complete sets**, enters 5 and chooses **Review mint**. Confirm the 5-credit cost for 5 YES and 5 NO shares, then submit. Her available balance becomes 95 credits; each outcome shows 5 available shares.
3. Alice selects sell, YES, 3 shares, limit price `0.25`, until cancelled. Review the reservation of 3 owned YES shares and minimum proceeds of 0.75 credits if fully filled. Confirm. The order appears under **Your open orders**; YES shows 2 available and 3 reserved.
4. Bob waits for the automatic update (or chooses **Refresh market**) and buys 2 YES shares with a maximum price of `0.30`, immediate or cancel. Review the maximum 0.60-credit reservation and confirm. The existing 0.25 ask fills at its maker price: Bob spends 0.50 credits and owns 2 YES shares, with no remaining credit reservation.
5. Alice waits for the automatic update (or chooses **Refresh market**). Her order reports 2 of 3 shares filled, 1 open; the recent fills show the actual 0.25 execution. Review and confirm cancellation of the remainder. Alice has 3 YES and 5 NO available shares, zero reserved shares and 95.50 available credits. Cancellation cannot undo the 2 completed shares.
6. Alice burns 1 complete set after reviewing the return. Her balance becomes 96.50 credits, with 2 YES and 4 NO available shares. Bob still holds 2 YES shares. Check the private snapshots against the UI and reconcile the staging ledger.

Repeat buys/sells for NO, a partial immediate-or-cancel fill, a UTC expiry, insufficient credits/shares, a paused/closed market, a passed deadline and a self-crossing order. Available legacy pairs in synthetic examples remain burnable while open, and existing open orders remain cancellable even while paused/closed.

## Confirmation and recovery

Prices convert directly from decimal credit strings to integer ticks (10,000 ticks per credit). Whole quantities and maximum exposure are calculated with integer arithmetic. Review text discloses reservations, zero fees, duration and possible partial/no execution. The server remains authoritative for balances, matching and eligibility at commit time.

The browser stores one pending request per account and market in **session storage before sending it**. Until a recognizable success or explicit transaction rejection is received, new actions stay blocked. **Retry same request** resends the same action, operation key and payload; the API replays an already-committed result. Reloading or returning after sign-in restores the pending request. A 20-second request timeout retains it as unconfirmed. There is no automatic submission after reload.

Do not clear browser data, switch to another device to repeat a request, or interpret an HTTP/network failure as proof of failure. Session storage is local to this browser tab; it is not an account-wide recovery history and may be lost when the tab/browser session is closed. Reconcile an uncertain operation with the operator if its saved reference is lost. Disabled/corrupt storage blocks new submissions. Authentication, server, malformed-response and conflicting-reference failures preserve the pending reference.

## Current limits

Active tabs refresh public depth, private balances/holdings/orders/fills, status and resolution every 10 seconds, after confirmed local actions, and on reconnect/focus. **Refresh market** remains available. Hidden/offline tabs pause polling. Failed reads use bounded backoff and block submissions until a successful check. Session loss or account changes hide private data and require sign-in/reload; pending references remain saved. Changed balances, orders, quotes or eligibility invalidate an existing review, so inspect it again before confirming. Unsubmitted inputs survive ordinary polling. The closing deadline disables new actions locally; the server independently enforces eligibility. Every open order in this market is returned separately from paginated recent order history, so an old order cannot lose its cancellation control behind newer completed orders. Recent fills are bounded to the latest 50 in this market; the portfolio provides independently paginated cross-market order/fill and credit/share histories without that recent-fill limit.

Market pages now contain private account data when signed in and disable caching. Tokens and other users' order references are never included in public order-book responses. The practice `/demo` experience remains separate and does not spend account credits.

No schema migration is introduced by these controls. They require the reserved-withdrawal base (including migration `0006`). Apply that migration using its documented stop/migrate/restart procedure before deploying this branch.
