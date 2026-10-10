import { sql } from "drizzle-orm";
import type { createDatabase } from "./client";
export type Database = ReturnType<typeof createDatabase>["db"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// A shared lock precedes all user/session/market/ledger row locks. This deliberately
// serializes financial writes for the closed-community prototype across processes.
export async function lockTransactions(tx: Transaction | Database) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(72491948)`);
}
