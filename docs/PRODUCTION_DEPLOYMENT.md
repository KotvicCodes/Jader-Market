# Production deployment and operations — readiness item 6

This is a repeatable single-host Linux deployment for the binary-market prototype. It runs a production Next.js artifact, PostgreSQL, a supervised worker, a private monitor and an HTTPS reverse proxy. Only the proxy publishes ports. The app/worker use `jader_runtime`; schema migration uses a separate `jader_owner`. Neither is a superuser. The bootstrap database account is confined to the database service and trusted-host maintenance.

This implements the deployment tooling and local verification for checklist item 6. **The actual host, public certificate/DNS, firewall, alert delivery and operator rehearsal still need acceptance before a pilot.** A local self-signed certificate check cannot certify the target host. Protected backups and an isolated database-plus-key restore are the separate item 7 gate; browser/load acceptance is item 8. Do not infer their completion from this deployment.

## Prepare a host

Use a dedicated Linux host with Docker Engine and Compose **2.24.4 or later**, the pinned source revision, and sufficient storage for database growth, protected backups, build cache and container logs. Place the checkout at `/opt/jader-market`. Restrict SSH/host access; only the administrator should have Docker access (Docker is equivalent to root). Enable Docker on boot. Keep database ports closed at the host/cloud firewall; expose only HTTPS, the HTTP redirect and restricted administration. Do not combine this file with the development `compose.yaml`.

Copy [the environment template](../deploy/production.env.example) to `/etc/jader-market/production.env`, with parent directory mode 0700 and file mode 0600. Keep it outside git, images, logs and web roots. Set:

- `JADER_HOST`: exact DNS hostname, without scheme, path or port. The template serves standard HTTPS port 443. `APP_ORIGIN` becomes exactly `https://JADER_HOST`.
- Three different strong URL-safe database passwords. Set the corresponding owner/runtime URLs to match, with hostname `db` and database `jader_market`. URL-encode password characters if needed. Generate the bootstrap password separately; never give its URL to app/worker/monitor.
- `AUTH_SECRET`: the original matching key for an existing installation. For a new database, generate 32 random bytes encoded as hex, preserve the original, and set it **before** administrator creation. Do not regenerate it on deployment/recovery.
- `JADER_IMAGE`: an immutable release tag, preferably an image digest once built/published. Record the source commit and built `/api/health` version.
- `JADER_TLS_DIRECTORY`: absolute protected directory containing a valid certificate chain as `fullchain.pem` and matching key as `privkey.pem`. The proxy mounts it read-only. Obtain/renew the certificate through your approved DNS/certificate process; after renewal, run `docker compose ... exec proxy nginx -s reload`. Monitor certificate expiry independently.

Never paste environment contents or `docker inspect`/resolved Compose configuration into tickets. Those can expose credentials. The database and app images remain pinned by version here; record their resolved digests for release and dependency review. Set host log rotation (for example Docker `local` logging) and bounded retention before launch.

## Initialize and start

Run the following from the checkout. The `dc` function avoids putting secret values into command arguments:

```sh
dc() { docker compose --env-file /etc/jader-market/production.env -f deploy/compose.yaml "$@"; }
dc build app
dc up -d --wait db
dc run --rm -T migrate
# First installation only, interactive trusted host:
dc run --rm migrate npm run admin:create
dc up -d --wait app worker monitor proxy
```

The database initializer runs only on a **fresh** PostgreSQL volume. It creates `jader_owner` and `jader_runtime`, then transfers database/public-schema ownership to the owner. The database health check uses TCP so the entrypoint's temporary Unix-socket server cannot admit migrations before initialization finishes. Changing password environment variables does not rotate credentials on an existing volume. Rotate through a private trusted SQL session, update matching URLs and restart services. Existing databases require a deliberate ownership/role migration; do not run the initializer against existing records or point this stack at development volumes.

`migrate` runs all committed migrations under the owner and then `db:runtime-grants`. The grant command validates that the runtime role has no elevated attributes, memberships or owned objects, revokes old direct table/column/sequence grants, and applies an explicit table list. The bootstrap initializer sets runtime role defaults; the migration owner does not have CREATEROLE or permission to change runtime credentials. Runtime gets necessary SELECT/INSERT, UPDATE only for mutable projections/state, DELETE only for session/rate-limit cleanup, and sequence usage. It cannot CREATE/TEMP, edit migration markers, truncate financial records, replace functions, disable triggers, or drop tables. Triggers run as the invoker and keep their normal accounting protections. New tables require updating/reviewing the grant list; run grants after **every** migration. Runtime defaults bound statements to 15 seconds, lock waits to 5 seconds and idle transactions to 30 seconds. Reconciliation intentionally overrides its read timeout to 30 seconds.

App, worker and monitor run as the unprivileged `node` OS user, with no added Linux capabilities and no privilege escalation. Docker `init` forwards termination directly to the worker and monitor Node processes; the worker finishes a bounded pass and closes its database pool. `unless-stopped` restarts exited processes and restores running services after host reboot. Unhealthy-but-running containers are **alerted**, not automatically restarted: repeated restarts should not conceal a broken migration or financial invariant. The separate monitor/host timer detects stopped or stalled work.

## Accept the actual deployment

Record commit, image digest, `/api/health` version, date and operator for each check. Keep evidence private and use fictional accounts, credits and markets for rehearsal.

1. Browse through the public HTTPS hostname. Verify the valid chain, expected hostname, HTTPS-only session cookies (`Secure`, `HttpOnly`, `SameSite=Strict`), HSTS, security headers and `no-store` on private responses. Verify HTTP redirects to the fixed HTTPS host and HTTPS requests with any other Host are rejected. Nginx refreshes the app address through Docker DNS, so replacing an app container does not require a proxy restart. Check login, administrator MFA and a participant's private page. Invalid origins must fail mutations.
2. From an external host, confirm ports 3000/5432 and any development database ports are unreachable. Inspect published ports locally: only proxy ports 80/443 should be present. The private backend network is `internal`; app/worker/database have no host port bindings. Do not attach unrelated services to it. This design assumes direct client → proxy connectivity: if adding a CDN/load balancer, explicitly redesign and test trusted-client-IP handling.
3. Submit sign-ins with spoofed `X-Real-IP`/`X-Forwarded-For` headers through the proxy. Nginx overwrites `X-Real-IP` with its connection address and clears `X-Forwarded-For`; app trusts only `x-real-ip`. Confirm rate limits track the real connection. Access/error request logging is disabled in the proxy, and application logging omits request bodies and database errors. Inspect only predefined safe status messages.
4. Run `dc exec -T monitor npm run ops:check`. Expect status `ok` and exit 0. This checks schema/guards, runtime role restrictions (including column-level migration-marker grants and CREATE in either application schema) and durable worker progress. `/api/ready` intentionally checks app/configuration/schema only; a ready app does not prove the worker or TLS/network boundaries.
5. Exercise the two-participant trading/withdrawal/resolution rehearsal from the readiness checklist. Run `dc exec -T monitor npm run reconcile` and follow [operator reconciliation](OPERATOR_RECONCILIATION.md); an internal-only result remains incomplete without independent payment evidence. Exports and evidence stay on the trusted host. Do not print private reconciliation output into general service logs.
6. Stop the worker for over 30 seconds during a fictional rehearsal. Confirm the monitor and host alert signal `worker_stale`; restart the worker, verify reservations/payouts resume once and the alert clears. Test a process exit and a host reboot, then check app readiness and worker progress. Test the actual alert destination while the entire Compose stack is stopped.

## Private monitoring and alerts

The worker atomically writes `/var/lib/jader-worker/status.json` in a persistent named volume after **both** expiry maintenance and the settlement batch succeed. It retains last-success time across process restarts and records consecutive failures; partial/failed passes never advance success. Only worker has write access; monitor mounts it read-only. Use one worker for this volume. A missing/malformed status, future clock jump or unwritable volume fails the check. Synchronize host time.

Status-file write errors emit a generic warning while maintenance continues. They do not turn successful maintenance into a failed pass; the monitor still alerts when the last recorded success becomes stale. `worker --once` reports the maintenance outcome, so run `ops:check` separately to verify monitoring health.

`ops:check` returns safe aggregate JSON and exits 0 for healthy or 1 for critical/unavailable. It exposes no handles, user/market identifiers, positions, amounts, request data, or raw errors. There is no public metrics API. `--watch` checks every 10 seconds and continues after a failure. Monitor health checks run independently every 15 seconds. Alert codes:

| Code | Default trigger | Response |
| --- | --- | --- |
| `worker_stale` | No successful complete pass for 30 seconds, missing status or invalid/future timestamp | Check process/volume, DB access and locks. Restart only after finding the cause. |
| `worker_failures` | Three consecutive failed passes | Hold external payments; inspect safe failures, reconcile and investigate privately. |
| `expiry_lag` | Expired/deadline-crossed open orders overdue by 60 seconds | Check worker/DB contention; server still rejects expired new trades. Verify reservation release. |
| `settlement_stalled` | Any settling market has no receipt progress for 300 seconds since resolution/latest receipt | Pause financial operations, reconcile and investigate the affected settlement privately. A healthy heartbeat does not clear this alert. |
| `operations_unavailable` | Schema/guards, unsafe DB role, missing config, DB access/query failure | Fail closed for deployment acceptance; investigate configuration/migrations and infrastructure. |

These are initial small-pilot thresholds, not measured capacity guarantees. Large holdings/history can legitimately need more work; tune only after workload acceptance. A healthy monitor does not prove financial reconciliation, external payment authenticity, TLS health, disk capacity or backups.

Install the supplied `jader-market-check.service`, `.timer` and `jader-market-alert.service` under `/etc/systemd/system/` after confirming paths. Enable the timer with `systemctl enable --now jader-market-check.timer`. Every 30 seconds it checks the running app and monitor; failures invoke a generic `daemon.crit` journal/syslog alert. Connect that tag (`jader-market`) to your operator's existing alert delivery, and verify receipt. The provided alert unit writes locally; it does not send email/webhooks by itself. Use an **external** uptime/TLS probe and host disk/container monitoring too: an on-host timer cannot detect total host loss. Do not launch until the operator has an independently tested notification route.

## Updates, pause and incidents

Before updating, record the running artifact, perform the protected backup/key procedure from item 7, and reconcile. Announce maintenance; stop proxy/app/worker/monitor to prevent new financial requests while leaving the database running. Build/tag the new artifact, run the one-shot migration/grants, and start the app/worker/monitor before restoring proxy traffic. A failed migration exits nonzero: keep traffic stopped, inspect state in a restricted session and prepare a reviewed forward repair. Never edit applied migration files, fake a migration marker, disable guards, or drop volumes to force startup. Reverting application code is safe only when schema compatibility has been verified; otherwise deploy a forward fix. After updates verify built version, readiness, roles, monitor, reconciliation and a fictional end-to-end rehearsal.

For a suspected accounting/payment incident, stop external payments and new credit issuance immediately. If the app remains trusted, pause affected open markets through administrator controls (server enforces pause). For broad corruption or untrusted access, stop the proxy/app/worker instead and preserve evidence/backups. Do not release ambiguous withdrawals or mark payments paid merely to clear an alert. Use the reconciliation runbook, independently establish external outcomes and apply only an authorized reviewed correction. Resume worker/traffic/payments explicitly after invariants and receipts reconcile. Administrator credential recovery requires the **original** `AUTH_SECRET`; follow README and the private key-custody procedure. Database-plus-key restore evidence belongs to item 7.

## Repeat the local proof

With Docker, Compose >=2.24.4 and OpenSSL:

```sh
docker build -f deploy/Dockerfile -t jader-market:deployment-test .
npm run test:deployment
```

The test creates a randomly named, disposable Compose project, distinct synthetic database credentials, a one-day self-signed localhost certificate and loopback ports. It pins all deployment settings in subprocess environments as well as its explicit environment file, so exported production settings cannot override the synthetic configuration. Inherited Compose defaults are discarded. It verifies non-superuser migrations/grants, HTTPS health/version/readiness, redirect/HSTS, Secure cookies/private caching, origin rejection, proxy IP overwrite, absence of published private ports, restart policy, HTTPS recovery after an app address change, rejection of unexpected HTTPS hosts, automatic restart with a fresh heartbeat after an unexpected worker exit, clean SIGTERM shutdown and worker-stop/restart alerts. It removes only its own containers/volumes/temp files. The separate production HTTP workflow suite runs all financial operations under the restricted runtime role. Integration checks exercise privilege denials, safe worker alerts and stalled queues. No real deployment, existing database or external payment is touched.

Local verification on 18 October 2026 (0.1.13): type checking, lint, 158 unit/component tests, 125 PostgreSQL integration tests, production build and restricted-role production HTTP workflows passed. The Docker image built, and the isolated Compose/TLS rehearsal passed all checks above, including automatic process restart and stopped-worker alert/recovery. Fixtures used disposable databases/projects; existing records and external payments were not used. This evidence covers the local deployment recipe, not an actual production host.

The [follow-up PR review](PR_13_FOLLOWUP_REVIEW.md) adds a deterministic startup regression: hold the database initializer open, verify that a health check rejects the temporary server, then release initialization and complete the deployment rehearsal.
