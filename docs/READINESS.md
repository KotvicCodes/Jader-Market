# Release readiness

The application implements the fictional-credit trading workflow and repeatable deployment, recovery, browser and pilot-load rehearsals. Passing local checks provides evidence for the tested revision and workload. A production or real-money pilot still requires acceptance of the intended host, devices, operating procedures and external-payment controls.

## Launch checklist

1. **Offline withdrawals:** requests reserve credits; processing payments remain reserved until confirmed paid or verified unpaid. Rehearse cancellation, payment confirmation and uncertain-payment handling using the [withdrawal runbook](OFFLINE_WITHDRAWALS.md).
2. **Participant trading:** authenticated controls support mint/burn, owned-share selling, limit orders, partial fills and cancellation. Complete the [two-participant rehearsal](PARTICIPANT_TRADING.md#two-participant-rehearsal) with fictional credits.
3. **Portfolio:** private balances, reservations, holdings, all open orders, paginated history and payout receipts share a consistent snapshot. Check both accounts after trading and settlement; see [portfolio](PARTICIPANT_PORTFOLIO.md).
4. **Refresh and recovery:** bounded polling, freshness checks, account binding and exact saved-request replay are implemented. Verify backgrounding, reconnects, session changes and browser storage on intended devices; see [automatic refresh](AUTOMATIC_REFRESH.md).
5. **Reconciliation:** read-only internal accounting and independent complete payment-register matching are implemented. Reconcile after each rehearsal and resolve external-payment exceptions before sending or releasing payments; see [operator reconciliation](OPERATOR_RECONCILIATION.md).
6. **Deployment:** isolated production services, HTTPS proxy, restricted runtime roles, worker supervision and private monitoring are implemented. Accept actual certificates/DNS, firewall, restart behavior, disk capacity and real alert delivery using [production deployment](PRODUCTION_DEPLOYMENT.md).
7. **Recovery:** encrypted replicated backups, release/key binding, isolated restoration, session revocation and accounting/payout checks are implemented. Accept independent archive/key/image custody, scheduling, recovery time and post-snapshot payment/security reconciliation using [backup and recovery](BACKUP_RECOVERY.md).
8. **Browser and capacity:** automated desktop, mobile/touch and keyboard workflows and the agreed 20-participant/10-concurrent-user load profile are implemented. Repeat [pilot acceptance](PILOT_ACCEPTANCE.md) on the intended host; verify physical devices, assistive technology and public-network latency separately.

The browser rehearsal includes account/MFA setup, market publication, committed-response replay, mint/burn, partial fills/cancellation, pause/resume, withdrawal reservation/cancellation, resolution, exact balances/private payout receipts, sign-out, worker restart and reconciliation. Service and HTTP suites also exercise NO and invalid resolutions, privacy, authorization, concurrent writes and database guards.

Use fictional credits until the operator accepts these gates and agrees credit denomination/redemption, limits, timing, liquidity funding, resolution/finality and privacy terms for the proposed pilot. Advanced charts, watchlists, notifications, public signup, disputes and multi-outcome trading remain optional future work.

