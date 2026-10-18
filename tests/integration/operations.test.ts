import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { markets, orders, marketResolutions, users } from "../../src/db/schema";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "../../src/db/client";
import { assertRestrictedRole, grantRuntimeRole } from "../../src/db/runtime-role";
import { operationsSnapshot } from "../../src/db/operations";
import { recordWorkerStatus } from "../../src/domain/worker-status";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const suffix = randomUUID().replaceAll("-", "");
const database = `jader_ops_${suffix}_test`;
const role = `jader_runtime_${suffix}`;
const password = randomBytes(24).toString("hex");
const ownerUrl = new URL(url); ownerUrl.pathname = `/${database}`;
const runtimeUrl = new URL(ownerUrl); runtimeUrl.username = role; runtimeUrl.password = password;
const owner = createDatabase(ownerUrl.toString());
const runtime = createDatabase(runtimeUrl.toString());
let directory: string;
let file: string;
let created = false;
let roleCreated = false;
beforeAll(async () => {
  await control.client.unsafe(`CREATE DATABASE "${database}"`); created = true;
  await migrate(owner.db, { migrationsFolder: "drizzle" });
  await control.client.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`); roleCreated = true;
  await grantRuntimeRole(owner.db, role);
  directory = await mkdtemp(join(tmpdir(), "jader-ops-")); file = join(directory, "status.json");
});
afterAll(async () => {
  await runtime.client.end(); await owner.client.end();
  if (created) await control.client.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
  if (roleCreated) await control.client.unsafe(`DROP ROLE "${role}"`);
  await control.client.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});
describe("restricted production role and worker monitoring", () => {
  it("permits authoritative readiness/metrics reads while rejecting unsafe runtime credentials", async () => {
    await expect(assertRestrictedRole(runtime.db)).resolves.toBeUndefined();
    await expect(assertRestrictedRole(owner.db)).rejects.toThrow();
    expect(await operationsSnapshot(runtime.db, file)).toMatchObject({ status: "critical", alerts: ["worker_stale"] });
    await recordWorkerStatus(file, true);
    expect(await operationsSnapshot(runtime.db, file)).toMatchObject({ status: "ok", expiryLagSeconds: 0, settlementLagSeconds: 0 });
  });
  it("cannot disable guards, replace functions, truncate journals, change migration state or create objects", async () => {
    for (const statement of [
      'ALTER TABLE public.journals DISABLE TRIGGER ALL', 'TRUNCATE public.journals CASCADE',
      'DROP TABLE public.journals CASCADE', 'DELETE FROM public.journals',
      'CREATE TABLE public.untrusted (id integer)', 'CREATE TEMP TABLE untrusted (id integer)',
      'CREATE DATABASE untrusted_test', 'CREATE ROLE untrusted',
      "UPDATE drizzle.__drizzle_migrations SET hash = 'changed'", "SET session_replication_role = replica",
      'CREATE OR REPLACE FUNCTION public.reject_record_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
    ]) await expect(runtime.client.unsafe(statement)).rejects.toThrow();
  });
  it("detects stalled settlement and expiry even while the worker heartbeat is healthy", async () => {
    // A disposable stopped-work fixture: keep constraint values realistic but
    // bypass financial triggers only while constructing the stalled queue.
    const marketId = randomUUID(); const userId = randomUUID();
    await owner.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.insert(users).values({ id: userId, handle: "ops_fixture", passwordHash: "unused" });
      await tx.insert(markets).values({ id: marketId, slug: "ops-fixture", question: "Will the fictional monitor fixture resolve?", description: "Synthetic queue only", category: "test", resolutionRules: "Synthetic operational queue fixture", resolutionSource: "Synthetic", closesAt: new Date(Date.now() + 3600_000), publishedAt: new Date(), status: "settling" });
      await tx.insert(marketResolutions).values({ id: randomUUID(), marketId, actorId: userId, result: "YES", evidence: "Synthetic operational monitoring evidence", requestHash: "unused", createdAt: new Date(Date.now() - 301_000) });
      await tx.insert(orders).values({ id: randomUUID(), operationId: randomUUID(), ownerId: userId, marketId, outcome: "YES", side: "buy", price: 5000n, quantity: 1n, remaining: 1n, timeInForce: "GTD", status: "open", expiresAt: new Date(Date.now() - 61_000) });
    });
    await recordWorkerStatus(file, true);
    const snapshot = await operationsSnapshot(runtime.db, file);
    expect(snapshot.alerts).toEqual(["expiry_lag", "settlement_stalled"]);
    expect(JSON.stringify(snapshot)).not.toContain(marketId);
    await owner.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM orders WHERE market_id = ${marketId}`);
      await tx.execute(sql`DELETE FROM market_resolutions WHERE market_id = ${marketId}`);
      await tx.execute(sql`DELETE FROM markets WHERE id = ${marketId}`);
      await tx.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    });
  });
  it("alerts on failed work, stale heartbeat and future timestamps without disclosing private identifiers", async () => {
    for (let i = 0; i < 3; i++) await recordWorkerStatus(file, false);
    expect((await operationsSnapshot(runtime.db, file)).alerts).toContain("worker_failures");
    await writeFile(file, JSON.stringify({ checkedAt: Date.now(), lastSuccess: Date.now() - 31_000, consecutiveFailures: 0 }));
    expect((await operationsSnapshot(runtime.db, file)).alerts).toContain("worker_stale");
    await writeFile(file, JSON.stringify({ checkedAt: Date.now() + 60_000, lastSuccess: Date.now() + 60_000, consecutiveFailures: 0 }));
    expect((await operationsSnapshot(runtime.db, file)).alerts).toContain("worker_stale");
    await recordWorkerStatus(file, true);
    expect((await operationsSnapshot(runtime.db, file)).status).toBe("ok");
  });
});
