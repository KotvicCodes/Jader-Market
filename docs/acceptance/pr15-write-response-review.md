# PR #15 write-response review — 18 October 2026

Reviewed head `cf39838ca23907a136383ae0608d25c16940dea3` against current `main`, including the browser/load harness, its regression tests and retained evidence, dependency/CI changes, accessibility changes, shared snapshot validation, and backup subprocess/cancellation changes. Traced the authentication, origin/CSRF/account binding, financial locking, trading, withdrawals, settlement, reconciliation, runtime-role and recovery paths exercised by acceptance. Existing review fixes and published history are preserved. The current worktree and the earlier PR review worktrees checked had no uncommitted changes to incorporate.

## Confirmed finding and correction

**P2 — load acceptance accepted unusable financial-write acknowledgements.** The driver consumed each write body as bytes and checked only `response.ok`. Fault injection performed all 120 real HTTP writes, then replaced their acknowledgements with empty HTTP 200 JSON. The original driver passed with zero errors, all 1,060 fills, 70 active-market mint operations, both 1,060-share totals, 40 payout receipts and complete reconciliation. The UI rejects those empty acknowledgements and keeps requests unconfirmed, so persisted accounting alone did not prove a usable financial workflow.

Writes now require HTTP 200 JSON with `Cache-Control: no-store`, no followed redirect, and the trading UI's result validation against the submitted request. This checks mint reference/action/quantity and order reference/state/quantities. The driver derives each mutation URL and body from one typed request. JSON decoding and validation are included in write latency, and failed writes retain their timing samples. The same full-profile fault now fails with **120 unexpected errors**, while all persisted financial/reconciliation checks still pass. No workload, guard, rate limit or acceptance threshold was relaxed.

Ten new regression tests cover usable mint/order results, empty/non-object/malformed/HTML acknowledgements, mismatched references/action/quantity, invalid order state/quantities, redirects, cacheability, content type/status, and the shared burn/cancellation result contract.

## Independent verification

- TypeScript, ESLint, **221 unit/component tests**, a fresh local production build, **130 PostgreSQL integration tests** and the restricted-role production HTTP workflows passed.
- Desktop, mobile/touch and keyboard browser workflows passed, including axe/reflow, keyboard focus, committed-response loss/replay, partial fills/cancellation, pause/resume, withdrawals, exact balances/holdings/payouts and sign-out. The desktop interruption lifecycle test also passed; its duplicate mobile/keyboard instances are intentionally skipped. A verified real-worker restart and complete synthetic reconciliation passed afterward.
- The unchanged corrected load profile passed in **62.345 seconds**: 1,200 validated reads, 120 validated writes, zero request/sampling errors, read/write p95 **32/114 ms**, and a **151 ms** conservative financial-lock wait bound. Maximum heartbeat/settlement/expiry lag was 1,084/1,184/34 ms. All 1,060 fills, 40 receipts, 70 active-market mint operations and both 1,060-share totals matched; restart produced no duplicate payouts and complete reconciliation passed. [Retained aggregate](item8-write-response-review-load.json).
- The committed production Dockerfile independently completed a fresh dependency installation and application build. Review artifact: `sha256:f2719ded033c3f8f1152e4b74533d5396336fa35982ce1299c8b21b1a1049c8e`.
- The full Docker deployment rehearsal passed using that artifact: initialization gating, owner migrations/runtime grants, HTTPS health/readiness/version, redirects/HSTS, secure cookies, origin rejection, trusted-IP overwrite, private networking, application address replacement, worker crash/restart, graceful shutdown and stale-worker alert/recovery.
- The isolated backup/restore drill passed using that fresh artifact: source release/key binding, encrypted replication/retention/freshness, wrong-key/corruption/SQL-failure rejection, immutable-image restoration, private logs, exact restored history/MFA, session revocation, backed reservations/collateral and resumed payouts without duplicates. The subprocess cancellation/deadline regression tests passed as part of the unit suite.
- The full dependency audit reported **zero known vulnerabilities**.

No additional application business-logic defect was reproduced. Passing these checks does not establish correctness for every input or deployment.

## Reproduce the rejected fault

With the production application built, create this local preload and run the normal disposable profile. Expect exit 1, `unexpectedErrors: 120`, `financialWritesApplied: true`, `reconciliation: "pass"` and `passed: false` in `.cache/load-acceptance.json`.

```sh
mkdir -p .cache
cat > .cache/empty-write-response.mjs <<'JS'
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await realFetch(...args);
  if (args[1]?.method === 'POST' && new URL(String(args[0])).pathname.startsWith('/api/trading/')) {
    await response.arrayBuffer();
    return new Response('{}', {status: 200, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
  }
  return response;
};
JS
node --import ./scripts/register-typescript.mjs --import ./.cache/empty-write-response.mjs scripts/test-load.ts
```

## Environment and limits

Node 22.22.1, npm 11.21.0, PostgreSQL 17.6, Linux ARM64. Local browser tests used the documented Chromium 153 executable override; Playwright's pinned browser remains a CI check. The nearly full shared filesystem required hard-linked local dependencies from a checkout with a byte-identical lockfile; the Docker build separately verified a fresh `npm ci`. The reviewed head's two GitHub verification runs passed; those results precede this correction and do not validate the new commit.

Physical devices, other browser engines, assistive technology, public-network latency, intended-host capacity, actual alert delivery and off-host storage/key custody remain operator acceptance work. No merge, real deployment or external payment was performed. All review data was disposable and synthetic; the existing development database was left untouched.

The review containers, databases, volumes, application/worker processes, private temporary directories and review image tag were removed after validation. Existing development resources were preserved.
