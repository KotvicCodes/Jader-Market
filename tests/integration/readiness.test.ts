import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
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
  it("rejects an incomplete restore even if migration markers remain", async () => {
    await connection.client.unsafe("ALTER TABLE sessions DROP COLUMN pending_mfa");
    expect((await GET()).status).toBe(503);
  });
});
