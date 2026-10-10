import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, getDatabase } from "../../src/db/client";
import { ledgerAccounts, rateLimits, sessions, users } from "../../src/db/schema";
import { digest, hashPassword, randomToken, rateKey, totp } from "../../src/domain/identity";
import { accountSnapshot, adjustCredits, administratorSnapshot, bootstrapAdministrator, changePassword, confirmMfa, createParticipant, manageParticipant, readSession, requireAdministrator, signIn, signOut, startMfa, takeRateLimit } from "../../src/db/members";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
process.env.DATABASE_URL = url;
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
const connection = createDatabase(url);
const suffix = randomUUID().slice(0, 8);
const adminHandle = `member_admin_${suffix}`;
const handle = `member_user_${suffix}`;
const password = "synthetic-member-password";
let adminId: string;
let adminToken: string;
let userId: string;
let userToken: string;
let mfaSecret: string;

beforeAll(async () => {
  await migrate(connection.db, { migrationsFolder: "drizzle" });
  const [admin] = await connection.db.insert(users).values({ handle: adminHandle, passwordHash: await hashPassword(password), role: "admin" }).returning();
  adminId = admin.id;
  await connection.db.insert(ledgerAccounts).values([{ ownerId: adminId, kind: "wallet" }, { ownerId: adminId, kind: "reserved" }]);
  await connection.db.insert(ledgerAccounts).values({ kind: "issuance" }).onConflictDoNothing();
});
afterAll(async () => { await connection.client.end(); await getDatabase()?.client.end(); });

const grant = (amount: string, operationKey = randomUUID(), kind = "credit") => adjustCredits(adminToken, { recipientId: userId, amount, operationKey, kind, reason: kind === "credit" ? "demo_grant" : "correction", confirmed: true });

describe("private accounts and administrator credits", () => {
  it("signs in without preset credentials and blocks admin controls before MFA enrollment", async () => {
    await expect(signIn(adminHandle, "incorrect-password", undefined)).rejects.toMatchObject({ code: "invalid_credentials" });
    adminToken = (await signIn(adminHandle, password, undefined)).token;
    expect(() => requireAdministrator({ tokenHash: "unused", csrfHash: "unused", authenticatedAt: new Date(), user: { id: adminId, handle: adminHandle, role: "admin", mfaEnabled: false } })).toThrow();
    await expect(createParticipant(adminToken, handle, password)).rejects.toMatchObject({ code: "mfa_required" });
  });
  it("enrolls an authenticator and rejects replayed admin sign-in codes", async () => {
    mfaSecret = await startMfa(adminToken, password);
    await expect(confirmMfa(adminToken, "invalid")).rejects.toMatchObject({ code: "invalid_mfa" });
    const code = totp(mfaSecret, Math.floor(Date.now() / 30000));
    await confirmMfa(adminToken, code);
    expect((await readSession(adminToken))?.user.mfaEnabled).toBe(true);
    await expect(signIn(adminHandle, password, code)).rejects.toMatchObject({ code: "invalid_credentials" });
  });
  it("creates zero-balance participant accounts and prevents another administrator bootstrap", async () => {
    userId = await createParticipant(adminToken, handle, password);
    userToken = (await signIn(handle, password, undefined)).token;
    expect((await accountSnapshot(userToken)).available).toBe(0n);
    expect((await readSession(userToken))?.user.role).toBe("participant");
    await expect(bootstrapAdministrator(`another_${suffix}`, password)).rejects.toMatchObject({ code: "admin_exists" });
    await expect(createParticipant(adminToken, handle, password)).rejects.toMatchObject({ code: "handle_unavailable" });
  });
  it("rejects participant credit issuance and admin account creation", async () => {
    await expect(adjustCredits(userToken, { recipientId: userId, amount: "100", kind: "credit", reason: "demo_grant", operationKey: randomUUID(), confirmed: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createParticipant(userToken, `forbidden_${suffix}`, password)).rejects.toMatchObject({ code: "forbidden" });
    await expect(administratorSnapshot(userToken)).rejects.toMatchObject({ code: "forbidden" });
    expect((await accountSnapshot(userToken)).available).toBe(0n);
  });
  it("issues credits exactly once under concurrent retries and detects key reuse with different inputs", async () => {
    const key = randomUUID();
    const ids = await Promise.all(Array.from({ length: 4 }, () => grant("100", key)));
    expect(new Set(ids).size).toBe(1);
    const snapshot = await accountSnapshot(userToken);
    expect(snapshot.available).toBe(1_000_000n);
    expect(snapshot.history).toHaveLength(1);
    await expect(grant("101", key)).rejects.toMatchObject({ code: "operation_conflict" });
    await expect(adjustCredits(adminToken, { recipientId: userId, amount: "100", kind: "credit", reason: "demo_grant", operationKey: randomUUID(), confirmed: false })).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("serializes simultaneous debits so credits cannot be overspent", async () => {
    const attempts = await Promise.allSettled([grant("80", randomUUID(), "debit"), grant("80", randomUUID(), "debit")]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await accountSnapshot(userToken)).available).toBe(200_000n);
    expect((await accountSnapshot(userToken)).history).toHaveLength(2);
  });
  it("keeps balance history scoped to the session's owner and supports admin pagination", async () => {
    const otherHandle = `other_user_${suffix}`;
    const otherId = await createParticipant(adminToken, otherHandle, password);
    const otherToken = (await signIn(otherHandle, password, undefined)).token;
    expect((await accountSnapshot(otherToken)).history).toHaveLength(0);
    expect((await accountSnapshot(otherToken)).session.user.id).toBe(otherId);
    const page = await administratorSnapshot(adminToken, 1, suffix);
    expect(page.accounts.some(account => account.id === userId)).toBe(true);
    await signOut(otherToken);
    expect(await readSession(otherToken)).toBeUndefined();
  });
  it("requires recent authentication for credit changes", async () => {
    await connection.db.update(sessions).set({ authenticatedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(sessions.tokenHash, digest(adminToken)));
    await expect(grant("1")).rejects.toMatchObject({ code: "reauth_required" });
    await connection.db.update(sessions).set({ authenticatedAt: new Date() }).where(eq(sessions.tokenHash, digest(adminToken)));
  });
  it("revokes sessions on suspension and prevents participant management of the administrator", async () => {
    await manageParticipant(adminToken, userId, "suspend");
    expect(await readSession(userToken)).toBeUndefined();
    await expect(signIn(handle, password, undefined)).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(manageParticipant(adminToken, adminId, "suspend")).rejects.toMatchObject({ code: "forbidden" });
    await manageParticipant(adminToken, userId, "resume");
    userToken = (await signIn(handle, password, undefined)).token;
  });
  it("allows admin password recovery and invalidates the participant's sessions", async () => {
    await manageParticipant(adminToken, userId, "reset-password", "replacement-synthetic-password");
    expect(await readSession(userToken)).toBeUndefined();
    await expect(signIn(handle, password, undefined)).rejects.toMatchObject({ code: "invalid_credentials" });
    userToken = (await signIn(handle, "replacement-synthetic-password", undefined)).token;
    await changePassword(userToken, "replacement-synthetic-password", "changed-synthetic-password", undefined);
    expect(await readSession(userToken)).toBeUndefined();
    expect((await signIn(handle, "changed-synthetic-password", undefined)).token).toBeTruthy();
  });
  it("rejects expired and forged sessions", async () => {
    const token = randomToken();
    await connection.db.insert(sessions).values({ tokenHash: digest(token), csrfHash: digest(randomToken()), userId, expiresAt: new Date(Date.now() - 1000) });
    expect(await readSession(token)).toBeUndefined();
    expect(await readSession(randomToken())).toBeUndefined();
  });
  it("revokes every session when a participant signs out everywhere", async () => {
    const first = (await signIn(handle, "changed-synthetic-password", undefined)).token;
    const second = (await signIn(handle, "changed-synthetic-password", undefined)).token;
    await signOut(first, true);
    expect(await readSession(first)).toBeUndefined();
    expect(await readSession(second)).toBeUndefined();
  });
  it("isolates abusive sign-in attempts by client instead of globally or by handle", async () => {
    const attacker = "198.51.100.20";
    for (let i = 0; i < 10; i++) await expect(signIn(handle, "incorrect-password", undefined, undefined, attacker)).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(signIn(handle, "changed-synthetic-password", undefined, undefined, attacker)).rejects.toMatchObject({ code: "rate_limited" });
    expect((await signIn(handle, "changed-synthetic-password", undefined, undefined, "198.51.100.21")).token).toBeTruthy();
    // Rotating target handles still hits the attacker's client-wide budget.
    for (let i = 0; i < 19; i++) await expect(signIn(`invalid_${i}`, 0, undefined, undefined, attacker)).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(signIn("another_invalid", 0, undefined, undefined, attacker)).rejects.toMatchObject({ code: "rate_limited" });
    const keys = await connection.db.select({ key: rateLimits.key }).from(rateLimits);
    expect(keys.some(row => row.key === rateKey("signin_global", "all"))).toBe(false);
    for (const value of [attacker, "198.51.100.21", handle]) expect(keys.some(row => row.key.includes(value))).toBe(false);
  });
  it("rate-limits attempts without retaining raw handles", async () => {
    await takeRateLimit("test_limit", handle, 1);
    await expect(takeRateLimit("test_limit", handle, 1)).rejects.toMatchObject({ code: "rate_limited" });
    const keys = await connection.db.select({ key: rateLimits.key }).from(rateLimits);
    expect(keys.some(record => record.key.includes(handle))).toBe(false);
  });
});
