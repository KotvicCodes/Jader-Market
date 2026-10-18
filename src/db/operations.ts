import { sql } from "drizzle-orm";
import { assertDatabaseReady } from "./readiness";
import { assertRestrictedRole } from "./runtime-role";
import type { Database } from "./transaction-lock";
import { readWorkerStatus } from "../domain/worker-status";

export async function operationsSnapshot(db: Database, statusFile: string) {
  await assertDatabaseReady(db);
  await assertRestrictedRole(db);
  const heartbeat = await readWorkerStatus(statusFile);
  const [queue] = await db.execute<{ expiryLagSeconds: number; settlementLagSeconds: number }>(sql`
    SELECT COALESCE((SELECT max(EXTRACT(EPOCH FROM now() - LEAST(o.expires_at, m.closes_at)))
      FROM orders o JOIN markets m ON m.id = o.market_id
      WHERE o.status = 'open' AND (o.expires_at <= now() OR m.closes_at <= now())), 0)::float8 AS "expiryLagSeconds",
    COALESCE((SELECT max(EXTRACT(EPOCH FROM now() - GREATEST(r.created_at,
      COALESCE((SELECT max(p.created_at) FROM market_payouts p WHERE p.resolution_id = r.id), r.created_at))))
      FROM markets m JOIN market_resolutions r ON r.market_id = m.id WHERE m.status = 'settling'), 0)::float8 AS "settlementLagSeconds"`);
  const now = Date.now();
  const workerAgeSeconds = heartbeat?.lastSuccess ? Math.max(0, (now - heartbeat.lastSuccess) / 1000) : null;
  const alerts: string[] = [];
  if (workerAgeSeconds === null || workerAgeSeconds > 30 || heartbeat!.checkedAt > now + 5000) alerts.push("worker_stale");
  if (heartbeat && heartbeat.consecutiveFailures >= 3) alerts.push("worker_failures");
  if (queue.expiryLagSeconds > 60) alerts.push("expiry_lag");
  if (queue.settlementLagSeconds > 300) alerts.push("settlement_stalled");
  return { status: alerts.length ? "critical" : "ok", alerts, workerAgeSeconds,
    consecutiveFailures: heartbeat?.consecutiveFailures ?? null, ...queue };
}
