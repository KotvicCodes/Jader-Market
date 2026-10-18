# PR #13 review — 18 October 2026

Reviewed [PR #13](https://github.com/KotvicCodes/Jader-Market/pull/13), head `e333588007bc21a8ed8630c9924dd39ec9abf843`, against `feat/operator-reconciliation` at `a41a5458bc75b03198996e373d659bfa7e0d2ece`. The review covered all 26 changed files and the related authentication, readiness, financial guards, expiry and settlement code.

Four findings were reproduced. The changes accompanying this report fix all four and add regression coverage.

## 1. P1 — The disposable deployment test accepts production settings

**Location:** `scripts/test-deployment.mjs`, subprocess environment handling.

Compose prioritizes exported variables over `--env-file`. The test wrote synthetic settings to a file but inherited the caller's environment in every Docker invocation. Exported database URLs, credentials, hostname, image or TLS directory could therefore replace its disposable configuration. A reachable production URL could receive the migration/grant commands.

**Reproduction:** Running the original script with only the synthetic marker `JADER_HOST=production.invalid` changed the deployment hostname and failed the HTTPS acceptance stage. No production credentials or databases were used.

**Fix:** Pin all deployment values in each subprocess environment, including cleanup, and discard inherited `COMPOSE_*` defaults. Use separate generated bootstrap, owner and runtime passwords. A unit test intercepts Docker operations and verifies that both startup and cleanup receive only the generated deployment settings. The full rehearsal also runs with deliberately conflicting exported settings.

## 2. P1 — A replacement app container leaves HTTPS pointing at its old address

**Location:** `deploy/nginx.conf`, upstream configuration.

The original `proxy_pass http://app:3000` resolves the app address when Nginx starts. Replacing the app with a container at a different address leaves the proxy using the old address until Nginx reloads or restarts.

**Reproduction:** Remove the app, occupy its released address with a disposable container, and start a replacement app. The replacement passed readiness while HTTPS returned **502**.

**Fix:** Use a shared upstream with Docker DNS and dynamic address resolution. The shared memory allocation supports hosts with 64 KiB memory pages. The deployment regression forces an address change and verifies HTTPS readiness without restarting the proxy.

## 3. P2 — Runtime-role monitoring misses dangerous privilege drift

**Location:** `src/db/runtime-role.ts`, grant reset and role assertion.

Table-level `REVOKE ALL` does not remove independent column grants. The role assertion also checked only table-level migration-marker writes and CREATE in `public`. A column-level migration-marker UPDATE grant, or CREATE in `drizzle`, therefore passed the monitor. These findings require privilege drift; the supplied fresh-volume initializer does not grant those privileges.

**Reproduction:** Grant `UPDATE (hash)` on `drizzle.__drizzle_migrations`, or CREATE on schema `drizzle`, to a disposable runtime role. Both new rejection tests failed against the original implementation because the role assertion accepted the role.

**Fix:** Explicitly revoke direct column ACLs during grant reset, check effective column-level migration writes, and reject CREATE in either application schema. PostgreSQL regression tests verify detection, repair and denial of the subsequent migration-marker UPDATE.

## 4. P2 — npm interrupts graceful worker shutdown

**Location:** `deploy/compose.yaml`, worker and monitor commands.

Docker signaled npm rather than the Node process that installs the shutdown handlers. The container could exit before the worker completed its pass and closed its connection pool. Database transaction rollback still protects atomicity, but the advertised graceful shutdown was not delivered.

**Reproduction:** Stopping a production-image worker invoked through the original npm command produced npm's SIGTERM error and container exit code **1**, without the worker's completion message.

**Fix:** Start worker and monitor Node entrypoints directly under Docker's init process. The deployment regression requires exit code **0** and the worker completion message after SIGTERM. Crash recovery must also produce a heartbeat written after the process restarted.

## Additional hardening

The HTTPS default server now rejects unknown TLS names and unexpected HTTP Host values instead of silently forwarding them under the configured hostname. The proxy has a configuration health check so Compose startup waits for a valid Nginx configuration. These changes preserve the fixed HTTP-to-HTTPS redirect and trusted-client-IP overwrite.

## Validation and limits

Validation uses disposable databases, roles, containers, volumes, certificates and fictional accounts. No production deployment or external payment was modified.

All final checks passed:

- TypeScript type checking and ESLint with zero warnings.
- 158 unit/component tests across 19 files.
- 125 PostgreSQL integration tests across 14 files.
- Production Next.js build and the restricted-runtime-role production HTTP workflow suite, including accounts/MFA, credits, trading, withdrawals, settlement, privacy and request protections.
- Production Docker image build on Linux ARM64.
- Expanded Compose/TLS deployment rehearsal with conflicting exported hostname, image, database URLs/passwords, authentication key, TLS directory and Compose profile settings.
- Regression checks for app address changes, unexpected HTTPS hosts, real worker crash recovery, fresh durable progress, graceful shutdown, stale-worker alerts and restart recovery.
- Git whitespace/error checks.

The actual production host still requires public DNS/TLS, firewall, alert delivery and reboot acceptance. The supplied systemd alert writes locally; an independent notification route and external uptime/TLS monitoring remain necessary. Backup plus key restore and browser/load acceptance are separate launch gates. This review does not certify production capacity or a real-money launch.

This report accompanies the fixes submitted to PR #13.
