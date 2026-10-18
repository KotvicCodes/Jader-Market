# PR #13 independent follow-up review

Reviewed PR head `27402f47254940ba7a9775bf2553b2b9fbee9a95` against `feat/operator-reconciliation` at `a41a5458bc75b03198996e373d659bfa7e0d2ece`. This review covered all 28 changed files and traced their interactions with authentication, application readiness, database guards, order expiry, payouts and reconciliation. The four fixes in the [earlier review](PR_13_REVIEW.md) were already present in this head and passed independent verification.

## P2 — Database initialization can report healthy before application connections work

**Location:** `deploy/compose.yaml`, database health check.

The original check invokes `pg_isready` without a host. PostgreSQL's official entrypoint starts a temporary server that accepts Unix-socket connections while initialization scripts run. Docker can therefore report the database as healthy before role initialization finishes and before the final TCP server starts. The documented `up --wait db` followed by `run migrate` can race initialization, failing an otherwise valid first deployment. App and worker startup also depend on this health result.

**Reproduction:** Start a fresh disposable PostgreSQL container with the original health check and a delayed initialization script. Docker reports `healthy`, while `pg_isready -h 127.0.0.1` reports `no response` and the initialization script is still running. No existing database was used.

**Fix:** Check `127.0.0.1` over TCP. The entrypoint's temporary server cannot satisfy this check; the final server starts after initialization scripts finish.

**Regression:** The deployment rehearsal mounts a final initialization script that waits for an explicit release. It observes the initializer, waits for a health-check execution, and asserts that the database remains unready. It then releases initialization and runs migrations plus the complete HTTPS/worker rehearsal. This regression fails at database initialization with the original health check and passes with the TCP check.

## Worker restart test improvement

The crash-recovery assertion now compares Docker's restart count with the count immediately before the deliberate crash. A restart from an earlier startup problem can no longer satisfy this assertion. The existing requirement for a heartbeat written after process startup is retained.

## CodeRabbit follow-up — Status recording must not stop maintenance

Verified [CodeRabbit's worker finding](https://github.com/KotvicCodes/Jader-Market/pull/13#discussion_r4306686459). A rejected success-status write entered the maintenance failure handler and attempted a second, false-status write. If that also failed, the worker exited even though expiry and payouts had completed successfully. A failed maintenance pass could likewise stop continuous retries when recording the failure failed.

Status recording now runs separately with a safe generic error message. Maintenance continues despite status-storage failures, while the monitor's stale-heartbeat alert remains effective. One-shot exit status still reflects maintenance success or failure. Three regression tests fail against the original worker and pass after the fix; they cover continued successful work, successful one-shot work and failed one-shot work when status writes reject.

## Verification

- TypeScript type checking and ESLint with zero warnings.
- All 161 unit/component tests across 19 files, including the three CodeRabbit regressions.
- All 125 PostgreSQL integration tests across 14 files, using a separate disposable PostgreSQL container.
- Production Next.js build and restricted-role production HTTP workflows for accounts/MFA, credits, trading, withdrawals, settlement, privacy and request protections.
- Production Docker image build and complete deployment rehearsal passed before the CodeRabbit worker adjustment. That adjustment is additionally covered by worker regressions, type checking and lint; CI rebuilds the final image and reruns the deployment rehearsal after push.
- Isolated deployment rehearsal: initialization gating, non-superuser migrations/grants, TLS verification, readiness/version, redirects/HSTS, private cookies/caching, origin rejection, client-IP overwrite, private networks/ports, app address replacement, worker crash recovery, graceful shutdown and stale-worker alert/recovery.
- Supplied systemd units accepted by `systemd-analyze verify`; Git whitespace checks passed.

The host dependency download encountered network/storage errors. Local checks used an existing dependency installation with an identical `package-lock.json`; the independent Docker build and deployment rehearsal also passed. Test databases, roles, containers, volumes and certificates were disposable. The existing development database and production data were not modified.

## Remaining acceptance

No additional blocking defect was found in the reviewed changes after this fix. This is evidence for the tested local deployment, not proof that every production condition is covered. Public DNS/TLS, firewall exposure, external alert delivery, host reboot, backup plus authentication-key restore, and browser/load acceptance still need their documented operator checks. The supplied systemd alert writes locally and checks the app/monitor; the runbook separately requires an external HTTPS/TLS probe.

The follow-up fixes are submitted to PR #13 for CI and CodeRabbit review. This review did not merge or deploy the pull request.
