import { sql } from "drizzle-orm";
import type { Database } from "./transaction-lock";

// Run only with the migration owner's connection, after every migration. No
// default grants: a new table needs an explicit privilege decision here.
export async function grantRuntimeRole(db: Database, role: string) {
  if (!/^jader_runtime(?:_[a-f0-9]+)?$/.test(role)) throw new Error("invalid_runtime_role");
  const ident = sql.identifier(role);
  await db.transaction(async tx => {
    const roles = await tx.execute(sql`SELECT 1 FROM pg_roles r WHERE r.rolname = ${role}
      AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datdba = r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner = r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid)`);
    if (roles.length !== 1) throw new Error("unsafe_runtime_role");
    const [database] = await tx.execute<{ name: string }>(sql`SELECT current_database() AS name`);
    await tx.execute(sql`REVOKE ALL ON DATABASE ${sql.identifier(database.name)} FROM PUBLIC`);
    await tx.execute(sql`REVOKE ALL ON DATABASE ${sql.identifier(database.name)} FROM ${ident}`);
    await tx.execute(sql`REVOKE ALL ON SCHEMA public, drizzle FROM ${ident}`);
    await tx.execute(sql`GRANT CONNECT ON DATABASE ${sql.identifier(database.name)} TO ${ident}`);
    await tx.execute(sql`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await tx.execute(sql`GRANT USAGE ON SCHEMA public, drizzle TO ${ident}`);
    await tx.execute(sql`REVOKE ALL ON ALL TABLES IN SCHEMA public, drizzle FROM ${ident}`);
    await tx.execute(sql`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public, drizzle FROM ${ident}`);
    const select = ["markets", "users", "sessions", "rate_limits", "ledger_accounts", "journals", "ledger_entries", "admin_audit", "market_audit", "trading_operations", "holdings", "orders", "fills", "share_movements", "trading_outbox", "market_deadline_events", "market_resolutions", "market_payouts", "withdrawals", "withdrawal_operations"];
    for (const table of select) await tx.execute(sql`GRANT SELECT ON TABLE ${sql.identifier(table)} TO ${ident}`);
    await tx.execute(sql`GRANT SELECT ON drizzle.__drizzle_migrations TO ${ident}`);
    for (const table of select) await tx.execute(sql`GRANT INSERT ON TABLE ${sql.identifier(table)} TO ${ident}`);
    for (const table of ["markets", "users", "sessions", "rate_limits", "ledger_accounts", "holdings", "orders", "withdrawals"]) await tx.execute(sql`GRANT UPDATE ON TABLE ${sql.identifier(table)} TO ${ident}`);
    await tx.execute(sql`GRANT DELETE ON sessions, rate_limits TO ${ident}`);
    await tx.execute(sql`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${ident}`);
  });
}

export async function assertRestrictedRole(db: Database) {
  const rows = await db.execute(sql`SELECT 1 FROM pg_roles r WHERE r.rolname = current_user
    AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datdba = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p')
        AND has_table_privilege(current_user, c.oid, 'TRUNCATE,TRIGGER'))
    AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
    AND NOT has_database_privilege(current_user, current_database(), 'CREATE')
    AND NOT has_database_privilege(current_user, current_database(), 'TEMP')
    AND NOT has_table_privilege(current_user, 'drizzle.__drizzle_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE')`);
  if (rows.length !== 1) throw new Error("unsafe_runtime_role");
}
