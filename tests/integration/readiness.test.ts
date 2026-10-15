import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql, TransactionRollbackError } from "drizzle-orm";
import { createDatabase, getDatabase } from "../../src/db/client";
import { assertDatabaseReady } from "../../src/db/readiness";
import { GET } from "../../src/app/api/ready/route";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const name = `jader_ready_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
const isolatedUrl = new URL(url); isolatedUrl.pathname = `/${name}`;
process.env.DATABASE_URL = isolatedUrl.toString();
const connection = createDatabase(isolatedUrl.toString());
const secret = randomBytes(32).toString("hex");

beforeAll(async () => { await control.client.unsafe(`CREATE DATABASE "${name}"`); });
afterAll(async () => {
  vi.unstubAllEnvs();
  await connection.client.end(); await getDatabase()?.client.end();
  await control.client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); await control.client.end();
});

describe("application readiness", () => {
  it("rejects an empty database and a legacy markets-only schema", async () => {
    await expect(assertDatabaseReady(connection.db)).rejects.toThrow();
    await connection.client.unsafe(readFileSync("drizzle/0000_wooden_snowbird.sql", "utf8"));
    expect((await GET()).status).toBe(503);
    await connection.client.unsafe("DROP TABLE markets; DROP TYPE market_status");
  });
  it("accepts current migrations and rejects missing authentication configuration", async () => {
    await migrate(connection.db, { migrationsFolder: "drizzle" });
    await expect(assertDatabaseReady(connection.db)).resolves.toBeUndefined();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    vi.stubEnv("AUTH_TRUSTED_IP_HEADER", "x-real-ip");
    expect((await GET()).status).toBe(503);
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("AUTH_TRUSTED_IP_HEADER", "");
    expect((await GET()).status).toBe(503);
    vi.stubEnv("AUTH_TRUSTED_IP_HEADER", "x-real-ip");
    vi.stubEnv("APP_ORIGIN", "http://example.invalid");
    expect((await GET()).status).toBe(503);
    vi.stubEnv("APP_ORIGIN", undefined);
    const missingOrigin = await GET();
    expect(missingOrigin.status).toBe(503);
    expect(await missingOrigin.json()).toEqual({ status: "unavailable", code: "APPLICATION_NOT_READY" });
    vi.stubEnv("APP_ORIGIN", "https://example.invalid");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });
  it("rejects a restore missing password hashes while migration markers remain", async () => {
    await connection.client.unsafe("ALTER TABLE users DROP COLUMN password_hash");
    try {
      await expect(assertDatabaseReady(connection.db)).rejects.toThrow();
      expect((await GET()).status).toBe(503);
    } finally {
      await connection.client.unsafe("ALTER TABLE users ADD COLUMN password_hash text NOT NULL");
    }
  });
  it.each(["drop", "disable", "replica"] as const)("rejects every required application trigger when its restore state is %s", async state => {
    const triggers = await connection.db.execute<{ table_name: string; trigger_name: string }>(sql`
      SELECT c.relname AS table_name, t.tgname AS trigger_name
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal`);
    expect(triggers.length).toBeGreaterThan(0);
    for (const trigger of triggers) {
      await expect(connection.db.transaction(async tx => {
        const table = sql`${sql.identifier("public")}.${sql.identifier(trigger.table_name)}`;
        const name = sql.identifier(trigger.trigger_name);
        if (state === "drop") await tx.execute(sql`DROP TRIGGER ${name} ON ${table}`);
        else if (state === "disable") await tx.execute(sql`ALTER TABLE ${table} DISABLE TRIGGER ${name}`);
        else await tx.execute(sql`ALTER TABLE ${table} ENABLE REPLICA TRIGGER ${name}`);
        await expect(assertDatabaseReady(tx), `${trigger.table_name}.${trigger.trigger_name}`).rejects.toThrow("database_not_ready");
        tx.rollback();
      })).rejects.toBeInstanceOf(TransactionRollbackError);
    }
    expect((await GET()).status).toBe(200);
  });
  it("reports unavailable until the ledger application trigger is restored", async () => {
    await connection.client.unsafe("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_apply");
    try {
      const response = await GET();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable", code: "APPLICATION_NOT_READY" });
    } finally {
      await connection.client.unsafe("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_apply");
    }
    expect((await GET()).status).toBe(200);
  });
  it("rejects an incomplete restore even if migration markers remain", async () => {
    await connection.client.unsafe("ALTER TABLE sessions DROP COLUMN pending_mfa");
    expect((await GET()).status).toBe(503);
  });
});
