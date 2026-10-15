import { sql } from "drizzle-orm";
import journal from "../../drizzle/meta/_journal.json" with { type: "json" };
import type { Database, Transaction } from "./transaction-lock";
import { requiredDatabaseTriggers } from "./readiness-triggers";

// The current artifact must have all of its migrations, including custom guards.
export async function assertDatabaseReady(db: Database | Transaction) {
  const latest = journal.entries.at(-1)!;
  const records = await db.execute(sql`SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = ${latest.when} LIMIT 1`);
  if (!records.length) throw new Error("database_not_ready");
  const triggers = Object.entries(requiredDatabaseTriggers).flatMap(([table, names]) => names.map(name => sql`(${table}, ${name})`));
  const missing = await db.execute(sql`
    SELECT 1 FROM (VALUES ${sql.join(triggers, sql`, `)}) AS required(table_name, trigger_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = required.table_name
        AND t.tgname = required.trigger_name AND NOT t.tgisinternal
        AND t.tgenabled IN ('O', 'A')
    ) LIMIT 1`);
  if (missing.length) throw new Error("database_not_ready");
  // Also check capabilities: a migration marker alone is insufficient after an
  // incomplete restore. LIMIT 0 validates columns without reading private rows.
  await db.execute(sql`SELECT m.paused, m.revision, u.mfa_secret, u.password_hash, s.pending_mfa,
    a.market_id, j.trading_operation_id, h.reserved, o.remaining, f.quantity,
    t.response, b.payload, b.journal_id, ma.revision, d.operation_id, r.evidence, p.quantity
    FROM markets m, users u, sessions s, ledger_accounts a, journals j,
      holdings h, orders o, fills f, trading_operations t, trading_outbox b,
      market_audit ma, market_deadline_events d, market_resolutions r, market_payouts p LIMIT 0`);
}
