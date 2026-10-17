import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "../../src/db/client";
import { sessions, users } from "../../src/db/schema";
import { digest, randomToken, verifyPassword } from "../../src/domain/identity";
import { runAdministrator } from "../fixtures/admin-process";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const name = `jader_operator_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
const isolatedUrl = new URL(url); isolatedUrl.pathname = `/${name}`;
const connection = createDatabase(isolatedUrl.toString());
let created = false;
let directory: string | undefined;
let secret: string;
const password = "synthetic-initial-password";
const replacement = "synthetic-recovery-password";

beforeAll(async () => {
  mkdirSync(resolve(".cache"), { recursive: true });
  directory = mkdtempSync(resolve(".cache/operator-setup-"));
  await control.client.unsafe(`CREATE DATABASE "${name}"`); created = true;
  await migrate(connection.db, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  try { await connection.client.end(); }
  finally {
    try { if (created) await control.client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally {
      try { await control.client.end(); }
      finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
    }
  }
});

describe("administrator setup without native transpilers", () => {
  it("creates the administrator and saves a private key after successful prompts", async () => {
    const result = await runAdministrator(directory!, ["operator_admin\n", `${password}\n`, `${password}\n`], { databaseUrl: isolatedUrl.toString() });
    expect(result.code).toBe(0);
    expect(result.error).toBe("");
    expect(result.output.includes(password)).toBe(false);
    const [admin] = await connection.db.select().from(users);
    expect(admin.role).toBe("admin");
    expect(await verifyPassword(password, admin.passwordHash)).toBe(true);
    const stored = readFileSync(join(directory!, ".env"), "utf8").match(/^AUTH_SECRET=([a-f0-9]{64})$/m);
    expect(Boolean(stored)).toBe(true);
    secret = stored![1];
  });
  it.each([false, true])("refuses repeat creation without replacing configuration (saved key: %s)", async savedKey => {
    const envPath = join(directory!, ".env");
    const previous = readFileSync(envPath, "utf8");
    if (!savedKey) rmSync(envPath);
    try {
      const result = await runAdministrator(directory!, ["operator_admin\n", `${replacement}\n`, `${replacement}\n`], { databaseUrl: isolatedUrl.toString(), secret: "" });
      expect(result.code).toBe(1);
      expect(result.error).toContain("An administrator already exists");
      expect(existsSync(envPath)).toBe(savedKey);
      if (savedKey) expect(readFileSync(envPath, "utf8")).toBe(previous);
      expect(await verifyPassword(password, (await connection.db.select().from(users))[0].passwordHash)).toBe(true);
    } finally {
      if (!savedKey) writeFileSync(envPath, previous, { mode: 0o600 });
    }
  });
  it.each([false, true])("rejects recovery with an empty key without changing saved state (saved key: %s)", async savedKey => {
    const [admin] = await connection.db.select().from(users);
    await connection.db.insert(sessions).values({ userId: admin.id, tokenHash: digest(randomToken()), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now() + 60_000) });
    const previousSessions = (await connection.db.select().from(sessions)).length;
    const envPath = join(directory!, ".env");
    const previous = readFileSync(envPath, "utf8");
    if (!savedKey) rmSync(envPath);
    try {
      const result = await runAdministrator(directory!, ["operator_admin\n", `${replacement}\n`, `${replacement}\n`], { recover: true, databaseUrl: isolatedUrl.toString(), secret: "" });
      expect(result.code).toBe(1);
      expect(result.error).toBe("Administrator setup unavailable. Use an interactive terminal and check database configuration and migrations.\n");
      expect(result.output.includes(replacement)).toBe(false);
      expect(existsSync(envPath)).toBe(savedKey);
      if (savedKey) expect(readFileSync(envPath, "utf8") === previous).toBe(true);
      const [unchanged] = await connection.db.select().from(users);
      expect(await verifyPassword(password, unchanged.passwordHash)).toBe(true);
      expect((await connection.db.select().from(sessions)).length).toBe(previousSessions);
    } finally {
      if (!savedKey) writeFileSync(envPath, previous, { mode: 0o600 });
    }
  });
  it("recovers the administrator, revokes sessions and preserves the saved key", async () => {
    const [admin] = await connection.db.select().from(users);
    await connection.db.insert(sessions).values({ userId: admin.id, tokenHash: digest(randomToken()), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now() + 60_000) });
    const previous = readFileSync(join(directory!, ".env"), "utf8");
    const result = await runAdministrator(directory!, ["operator_admin\n", `${replacement}\n`, `${replacement}\n`], { recover: true, databaseUrl: isolatedUrl.toString(), secret });
    expect(result.code).toBe(0);
    expect(result.error).toBe("");
    expect(result.output.includes(replacement)).toBe(false);
    const [recovered] = await connection.db.select().from(users);
    expect(await verifyPassword(replacement, recovered.passwordHash)).toBe(true);
    expect(await verifyPassword(password, recovered.passwordHash)).toBe(false);
    expect(await connection.db.select().from(sessions)).toHaveLength(0);
    expect(readFileSync(join(directory!, ".env"), "utf8") === previous).toBe(true);
  });
});

async function freshSetup(check: (db: ReturnType<typeof createDatabase>, dbUrl: string, path: string) => Promise<void>) {
  const freshName = `jader_setup_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
  const freshUrl = new URL(url!); freshUrl.pathname = `/${freshName}`;
  const path = mkdtempSync(resolve(".cache/operator-fresh-"));
  const db = createDatabase(freshUrl.toString());
  await control.client.unsafe(`CREATE DATABASE "${freshName}"`);
  try { await check(db, freshUrl.toString(), path); }
  finally {
    await db.client.end();
    await control.client.unsafe(`DROP DATABASE "${freshName}" WITH (FORCE)`);
    rmSync(path, { recursive: true, force: true });
  }
}

describe("administrator configuration failure and concurrency", () => {
  it("saves a reloadable generated key when empty AUTH_SECRET assignments are duplicated", async () => {
    await freshSetup(async (db, dbUrl, path) => {
      await migrate(db.db, { migrationsFolder: "drizzle" });
      writeFileSync(join(path, ".env"), "SYNTHETIC_SENTINEL=unchanged\nAUTH_SECRET=\nAUTH_SECRET=\n");
      const result = await runAdministrator(path, ["operator_admin\n", `${password}\n`, `${password}\n`], { databaseUrl: dbUrl });
      expect(result.code).toBe(0);
      const saved = parse(readFileSync(join(path, ".env")));
      expect(saved.AUTH_SECRET).toMatch(/^[a-f0-9]{64}$/);
      expect(saved.SYNTHETIC_SENTINEL).toBe("unchanged");
      const recovered = await runAdministrator(path, ["operator_admin\n", `${replacement}\n`, `${replacement}\n`], { recover: true, databaseUrl: dbUrl, secret: saved.AUTH_SECRET });
      expect(recovered.code).toBe(0);
    });
  });
  it("leaves configuration unchanged when migrations are missing", async () => {
    await freshSetup(async (_db, dbUrl, path) => {
      const previous = "SYNTHETIC_SENTINEL=unchanged\nAUTH_SECRET=\n";
      writeFileSync(join(path, ".env"), previous);
      const result = await runAdministrator(path, ["operator_admin\n", `${password}\n`, `${password}\n`], { databaseUrl: dbUrl });
      expect(result.code).toBe(1);
      expect(readFileSync(join(path, ".env"), "utf8")).toBe(previous);
    });
  });
  it("restores the original configuration when account creation rolls back", async () => {
    await freshSetup(async (db, dbUrl, path) => {
      await migrate(db.db, { migrationsFolder: "drizzle" });
      await db.db.insert(users).values({ handle: "operator_admin", passwordHash: "unused-synthetic" });
      const previous = "SYNTHETIC_SENTINEL=unchanged\nAUTH_SECRET=\n";
      writeFileSync(join(path, ".env"), previous);
      const result = await runAdministrator(path, ["operator_admin\n", `${password}\n`, `${password}\n`], { databaseUrl: dbUrl });
      expect(result.code).toBe(1);
      expect(readFileSync(join(path, ".env"), "utf8")).toBe(previous);
      expect((await db.db.select().from(users)).map(user => user.role)).toEqual(["participant"]);
    });
  });
  it("refuses an empty environment value masking a saved key on first setup", async () => {
    await freshSetup(async (db, dbUrl, path) => {
      await migrate(db.db, { migrationsFolder: "drizzle" });
      const previous = `AUTH_SECRET=${secret}\n`;
      writeFileSync(join(path, ".env"), previous, { mode: 0o600 });
      const result = await runAdministrator(path, ["operator_admin\n", `${password}\n`, `${password}\n`], { databaseUrl: dbUrl, secret: "" });
      expect(result.code).toBe(1);
      expect(readFileSync(join(path, ".env"), "utf8")).toBe(previous);
      expect(await db.db.select().from(users)).toHaveLength(0);
    });
  });
  it("serializes concurrent first setup and retains the winner's saved key", async () => {
    await freshSetup(async (db, dbUrl, path) => {
      await migrate(db.db, { migrationsFolder: "drizzle" });
      const inputs = ["operator_admin\n", `${password}\n`, `${password}\n`];
      const results = await Promise.all([runAdministrator(path, inputs, { databaseUrl: dbUrl }), runAdministrator(path, inputs, { databaseUrl: dbUrl })]);
      expect(results.map(result => result.code).sort()).toEqual([0, 1]);
      expect(await db.db.select().from(users)).toHaveLength(1);
      expect(readFileSync(join(path, ".env"), "utf8")).toMatch(/^\n?AUTH_SECRET=[a-f0-9]{64}\n$/);
    });
  });
});
