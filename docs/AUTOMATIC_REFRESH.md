# Automatic refresh and reconnect handling

Readiness item 4 is implemented in PR #11 (0.1.11), stacked on PR #10. No schema migration or new dependency is introduced. Deployment and interactive desktop/mobile/keyboard acceptance remain pending; operational reconciliation, deployment security, recovery and load acceptance remain launch gates.

## What refreshes

Active market pages refresh public order-book depth, eligibility/status and resolution evidence alongside the signed-in account's credits, shares, open orders and recent fills. `GET /api/markets/:id/snapshot` reads these in one read-only repeatable-read transaction. Anonymous responses contain no account data. Authenticated responses include only that account's private snapshot and current CSRF value; all responses disable caching. Existing separate book/private APIs remain available.

The portfolio refreshes its full consistent snapshot through `/api/account/portfolio`. Its response now includes the current CSRF value for authenticated cancellation controls. Polling preserves each section's selected cursor; older history stays on that page until **Latest** is chosen. Holdings and all open orders still reflect current account state subject to selected holdings pagination. Financial amounts remain integer strings; there is no inferred valuation or client-side accounting.

## Timing and failure behavior

- Verify the initial server-rendered snapshot on mount, then poll 10 seconds after each successful read. Each mounted page has at most one active snapshot read.
- Timeout a read after 8 seconds. Failure delays are 20, 40, then at most 60 seconds, measured after completion. Successful reads reset the delay. Manual refresh is available.
- Abort reads and suspend polling while offline or hidden. Returning to the tab, reconnecting, focus, and a restored browser-history page trigger a current-state check; repeated focus events are coalesced with a one-second minimum start interval.
- Display the last successful check. An offline, failed, reconnecting or over-30-second-old snapshot blocks trading submissions until a fresh check succeeds. Keep the last good snapshot visible with an explicit stale warning; malformed successful responses also fail closed.
- Session expiry/revocation or account mismatch hides private data and stops polling. Sign in to the intended account, then reload the page. No uncertain trading reference is deleted by session failure. A different account's response is discarded.
- On unmount, abort reads and remove timers/listeners. Ignore late responses from aborted or superseded reads. If a mutation completes during an older poll, discard that poll and queue a new read before re-enabling submissions.

These are bounded polling guarantees, not instantaneous delivery. The service independently checks balances, reservations, ownership, expiry and eligibility at commit time. The worker must remain supervised for order cleanup and settlement. Very large/slow portfolios can hit the read timeout; measure the intended pilot load before operation. Polling does not certify the deployment or worker health.

## Review and request identity

Ordinary updates preserve unfinished ticket inputs. A change in private balances, orders, holdings or market eligibility, or public book depth, permanently invalidates a prepared market review. Portfolio cancellation reviews are invalidated when their group's order details change. Inspect current details and review again. Limits still bind execution if state changes between the last check and confirmation. A local market deadline also invalidates a review and removes new-trade controls.

Website trading submissions include `X-Account-ID` for the displayed account. When supplied, the trading route rejects an identity mismatch before invoking the mutation service; callers using the existing API without this optional guard keep its prior authentication/CSRF requirements. A failed account/session/CSRF check preserves a pending request and triggers a fresh read. The pending payload and operation key never change because of polling or reconnecting.

There is **no automatic mutation retry**. A lost response remains unconfirmed even if a later snapshot appears to show its effect. Use **Retry same request** explicitly once current state is confirmed. The same idempotent request returns the committed result. The portfolio lists saved requests independently from open orders, so cancellation remains recoverable when a fill/closure/worker removes the last open order, including after reload. Session storage remains local to the current tab/session; keep its data and use operator reconciliation if a reference is lost.

## Acceptance rehearsal

In isolated staging with fictional credits, use the [two-participant rehearsal](PARTICIPANT_TRADING.md#two-participant-rehearsal). Keep both markets/portfolios active and verify fills/reservations appear without reload. Leave a ticket draft open during polling. Prepare a review, change the book/balance through the other session, and verify a fresh review is required. Pause, close and expire markets/orders; verify status/controls and worker-released reservations update. Resolve YES, NO and invalid markets; verify evidence, credits, removed holdings and receipts update.

Disconnect with a saved uncertain request. Confirm the stale warning, blocked submissions and retained reference. Reconnect and verify GET refreshes without a POST; explicitly replay the original request. Hide/show the tab and restore browser history. Expire/revoke a session and switch accounts, checking private-data hiding and expected-owner rejection. Cancel while another participant fills the last shares, then refresh/reload and recover the saved cancellation from the portfolio. Finally exercise narrow-screen and keyboard use and measure polling/worker load. These interactive checks remain unverified in this environment because the collaborative preview cannot reach the local server.
