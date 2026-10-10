import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, getDatabase } from "../../src/db/client";
import { adminAudit, ledgerAccounts, sessions, users } from "../../src/db/schema";
import { digest, encryptSecret, randomToken, verifyPassword } from "../../src/domain/identity";
import { bootstrapAdministrator, recoverAdministrator } from "../../src/db/members";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const name = `jader_bootstrap_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
const isolatedUrl = new URL(url);
isolatedUrl.pathname = `/${name}`;
process.env.DATABASE_URL = isolatedUrl.toString();
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
const isolated = createDatabase(isolatedUrl.toString());
const password = "synthetic-bootstrap-password";
let created = false;
let adminId: string;

beforeAll(async () => {
  // A separate disposable database exercises the very first administrator setup.
  await control.client.unsafe(`CREATE DATABASE "${name}"`);
  created = true;
  await migrate(isolated.db, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  await isolated.client.end();
  await getDatabase()?.client.end();
  if (created) await control.client.unsafe(`DROP DATABASE "${name}"`);
  await control.client.end();
});

describe("sole administrator setup and host recovery", () => {
  it("creates exactly one administrator when first-time setup runs concurrently", async () => {
    const attempts = await Promise.allSettled([bootstrapAdministrator("first_admin", password), bootstrapAdministrator("second_admin", password)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const records = await isolated.db.select().from(users);
    expect(records).toHaveLength(1);
    adminId = records[0].id;
    expect(records[0].role).toBe("admin");
    expect(await verifyPassword(password, records[0].passwordHash)).toBe(true);
    const accounts = await isolated.db.select().from(ledgerAccounts);
    expect(accounts).toHaveLength(3);
    expect(accounts.every(account => account.balance === 0n)).toBe(true);
  });
  it("recovers the owner locally and revokes sessions without issuing credits", async () => {
    const [admin] = await isolated.db.select().from(users).where(eq(users.id, adminId));
    await isolated.db.update(users).set({ mfaSecret: encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), lastMfaStep: 1 }).where(eq(users.id, adminId));
    await isolated.db.insert(sessions).values({ tokenHash: digest(randomToken()), csrfHash: digest(randomToken()), userId: adminId, expiresAt: new Date(Date.now() + 60_000) });
    await recoverAdministrator(admin.handle, "recovered-synthetic-password");
    const [recovered] = await isolated.db.select().from(users).where(eq(users.id, adminId));
    expect(recovered.mfaSecret).toBeNull();
    expect(await verifyPassword("recovered-synthetic-password", recovered.passwordHash)).toBe(true);
    expect(await isolated.db.select().from(sessions)).toHaveLength(0);
    expect((await isolated.db.select().from(ledgerAccounts)).every(account => account.balance === 0n)).toBe(true);
    expect((await isolated.db.select().from(adminAudit)).map(event => event.action)).toEqual(["admin_bootstrap", "admin_host_recovery"]);
  });
});
