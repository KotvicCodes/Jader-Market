import { sql } from "drizzle-orm";
import journal from "../../drizzle/meta/_journal.json" with { type: "json" };
import type { Database, Transaction } from "./transaction-lock";

// The current artifact must have all of its migrations, including custom guards.
export async function assertDatabaseReady(db: Database | Transaction) {
  const latest = journal.entries.at(-1)!;
  const records = await db.execute(sql`SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = ${latest.when} LIMIT 1`);
  if (!records.length) throw new Error("database_not_ready");
  // Also check capabilities: a migration marker alone is insufficient after an
  // incomplete restore. LIMIT 0 validates columns without reading private rows.
  await db.execute(sql`SELECT m.paused, m.revision, u.mfa_secret, s.pending_mfa,
    a.market_id, j.trading_operation_id, h.reserved, o.remaining, f.quantity,
    t.response, b.payload, ma.revision
    FROM markets m, users u, sessions s, ledger_accounts a, journals j,
      holdings h, orders o, fills f, trading_operations t, trading_outbox b,
      market_audit ma LIMIT 0`);
}
