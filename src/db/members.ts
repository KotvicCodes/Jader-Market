import { and, asc, count, desc, eq, gt, ilike, lt, sql } from "drizzle-orm";
import { createDatabase, getDatabase } from "./client";
import { adminAudit, journals, ledgerAccounts, ledgerEntries, rateLimits, sessions, users } from "./schema";
import { decryptSecret, digest, encryptSecret, hashPassword, MemberError, newMfaSecret, normalizeHandle, parseCredits, randomToken, rateKey, verifyMfa, verifyPassword } from "../domain/identity";

type Database = ReturnType<typeof createDatabase>["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;
export type MemberSession = {
  tokenHash: string; csrfHash: string; authenticatedAt: Date;
  user: { id: string; handle: string; role: string; mfaEnabled: boolean };
};
const recentWindow = 10 * 60 * 1000;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function memberDatabase() {
  const connection = getDatabase();
  if (!connection) throw new MemberError("configuration", 503);
  return connection;
}

export async function readSession(token: string | undefined, executor: Executor = memberDatabase().db, lock = false): Promise<MemberSession | undefined> {
  if (!token || !/^[a-zA-Z0-9_-]{43}$/.test(token)) return undefined;
  const query = executor.select({ tokenHash: sessions.tokenHash, csrfHash: sessions.csrfHash, authenticatedAt: sessions.authenticatedAt, id: users.id, handle: users.handle, role: users.role, mfaSecret: users.mfaSecret })
    .from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, digest(token)), gt(sessions.expiresAt, new Date()), eq(users.suspended, false))).limit(1);
  if (lock) {
    const [preliminary] = await query;
    if (!preliminary) return undefined;
    // Every mutation locks its user before its session to avoid sign-in/logout races.
    await executor.select({ id: users.id }).from(users).where(eq(users.id, preliminary.id)).for("update");
  }
  const [record] = lock ? await query.for("update", { of: sessions }) : await query;
  if (!record) return undefined;
  return { tokenHash: record.tokenHash, csrfHash: record.csrfHash, authenticatedAt: record.authenticatedAt, user: { id: record.id, handle: record.handle, role: record.role, mfaEnabled: Boolean(record.mfaSecret) } };
}

export function requireMember(session: MemberSession | undefined): asserts session is MemberSession {
  if (!session) throw new MemberError("unauthenticated", 401);
}

export function requireAdministrator(session: MemberSession | undefined): asserts session is MemberSession {
  requireMember(session);
  if (session.user.role !== "admin") throw new MemberError("forbidden", 403);
  if (!session.user.mfaEnabled) throw new MemberError("mfa_required", 403);
  if (Date.now() - session.authenticatedAt.getTime() > recentWindow) throw new MemberError("reauth_required", 403);
}

export async function takeRateLimit(scope: string, value: string, maximum = 10, windowMs = 15 * 60 * 1000) {
  const db = memberDatabase().db;
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMs);
  const [record] = await db.insert(rateLimits).values({ key: rateKey(scope, value), attempts: 1, windowStart: now }).onConflictDoUpdate({
    target: rateLimits.key,
    set: { attempts: sql`CASE WHEN ${rateLimits.windowStart} < ${cutoff.toISOString()}::timestamptz THEN 1 ELSE ${rateLimits.attempts} + 1 END`, windowStart: sql`CASE WHEN ${rateLimits.windowStart} < ${cutoff.toISOString()}::timestamptz THEN ${now.toISOString()}::timestamptz ELSE ${rateLimits.windowStart} END` },
  }).returning();
  if (record.attempts > maximum) throw new MemberError("rate_limited", 429);
}

async function newSession(tx: Transaction, userId: string) {
  const token = randomToken();
  const csrf = randomToken();
  await tx.insert(sessions).values({ tokenHash: digest(token), csrfHash: digest(csrf), userId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
  return { token, csrf };
}

export async function signIn(handleInput: unknown, password: unknown, mfaCode: unknown, previousToken?: string) {
  await takeRateLimit("signin_global", "all", 120, 60_000);
  let handle: string;
  try { handle = normalizeHandle(handleInput); } catch { handle = ""; }
  await takeRateLimit("signin", handle);
  const db = memberDatabase().db;
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, new Date(Date.now() - 24 * 60 * 60 * 1000)));
  const [candidate] = await db.select().from(users).where(eq(users.handle, handle)).limit(1);
  const correct = await verifyPassword(password, candidate?.passwordHash);
  if (!correct || !candidate || candidate.suspended) throw new MemberError("invalid_credentials", 401);
  return db.transaction(async tx => {
    const [user] = await tx.select().from(users).where(eq(users.id, candidate.id)).for("update");
    if (!user || user.suspended || user.passwordHash !== candidate.passwordHash) throw new MemberError("invalid_credentials", 401);
    if (user.mfaSecret) {
      const step = verifyMfa(decryptSecret(user.mfaSecret), mfaCode, user.lastMfaStep);
      if (step === undefined) throw new MemberError("invalid_credentials", 401);
      await tx.update(users).set({ lastMfaStep: step }).where(eq(users.id, user.id));
    }
    if (previousToken) await tx.delete(sessions).where(eq(sessions.tokenHash, digest(previousToken)));
    // Cap retained sessions per account, without collecting device or network data.
    const existing = await tx.select({ tokenHash: sessions.tokenHash }).from(sessions).where(eq(sessions.userId, user.id)).orderBy(desc(sessions.createdAt));
    for (const old of existing.slice(9)) await tx.delete(sessions).where(eq(sessions.tokenHash, old.tokenHash));
    return newSession(tx, user.id);
  });
}

export async function signOut(token: string, all = false) {
  await memberDatabase().db.transaction(async tx => {
    const session = await readSession(token, tx, true);
    requireMember(session);
    await tx.delete(sessions).where(all ? eq(sessions.userId, session.user.id) : eq(sessions.tokenHash, session.tokenHash));
  });
}

async function verifyCurrentCredential(tx: Transaction, session: MemberSession, password: unknown, code: unknown, mfaRequired = true) {
  const [user] = await tx.select().from(users).where(eq(users.id, session.user.id)).for("update");
  if (!user || !(await verifyPassword(password, user.passwordHash))) throw new MemberError("invalid_credentials", 401);
  if (mfaRequired && user.mfaSecret) {
    const step = verifyMfa(decryptSecret(user.mfaSecret), code, user.lastMfaStep);
    if (step === undefined) throw new MemberError("invalid_credentials", 401);
    await tx.update(users).set({ lastMfaStep: step }).where(eq(users.id, user.id));
  }
  return user;
}

export async function reauthenticate(token: string, password: unknown, code: unknown) {
  await takeRateLimit("reauth", digest(token));
  await memberDatabase().db.transaction(async tx => {
    const session = await readSession(token, tx, true);
    requireMember(session);
    await verifyCurrentCredential(tx, session, password, code);
    await tx.update(sessions).set({ authenticatedAt: new Date() }).where(eq(sessions.tokenHash, session.tokenHash));
  });
}

export async function startMfa(token: string, password: unknown) {
  await takeRateLimit("mfa_setup", digest(token));
  return memberDatabase().db.transaction(async tx => {
    const session = await readSession(token, tx, true);
    requireMember(session);
    const user = await verifyCurrentCredential(tx, session, password, undefined, false);
    if (user.mfaSecret) throw new MemberError("mfa_enabled", 409);
    const secret = newMfaSecret();
    await tx.update(sessions).set({ pendingMfa: encryptSecret(secret) }).where(eq(sessions.tokenHash, session.tokenHash));
    return secret;
  });
}

export async function confirmMfa(token: string, code: unknown) {
  await takeRateLimit("mfa_confirm", digest(token));
  await memberDatabase().db.transaction(async tx => {
    const session = await readSession(token, tx, true);
    requireMember(session);
    const [record] = await tx.select().from(sessions).where(eq(sessions.tokenHash, session.tokenHash));
    if (!record.pendingMfa || session.user.mfaEnabled) throw new MemberError("invalid_mfa");
    const step = verifyMfa(decryptSecret(record.pendingMfa), code);
    if (step === undefined) throw new MemberError("invalid_mfa");
    await tx.update(users).set({ mfaSecret: record.pendingMfa, lastMfaStep: step }).where(eq(users.id, session.user.id));
    await tx.delete(sessions).where(and(eq(sessions.userId, session.user.id), sql`${sessions.tokenHash} <> ${session.tokenHash}`));
    await tx.update(sessions).set({ pendingMfa: null, authenticatedAt: new Date() }).where(eq(sessions.tokenHash, session.tokenHash));
  });
}

export async function changePassword(token: string, currentPassword: unknown, password: unknown, code: unknown) {
  if (typeof password !== "string") throw new MemberError("invalid_password");
  await takeRateLimit("password", digest(token));
  const passwordHash = await hashPassword(password);
  await memberDatabase().db.transaction(async tx => {
    const session = await readSession(token, tx, true);
    requireMember(session);
    await verifyCurrentCredential(tx, session, currentPassword, code);
    await tx.update(users).set({ passwordHash }).where(eq(users.id, session.user.id));
    await tx.delete(sessions).where(eq(sessions.userId, session.user.id));
  });
}

async function createWallets(tx: Transaction, ownerId: string) {
  await tx.insert(ledgerAccounts).values([{ kind: "wallet", ownerId }, { kind: "reserved", ownerId }]);
  await tx.insert(ledgerAccounts).values({ kind: "issuance" }).onConflictDoNothing();
}

export async function bootstrapAdministrator(handleInput: unknown, password: string) {
  const handle = normalizeHandle(handleInput);
  const passwordHash = await hashPassword(password);
  return memberDatabase().db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(72491947)`);
    if ((await tx.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1)).length) throw new MemberError("admin_exists", 409);
    const [user] = await tx.insert(users).values({ handle, passwordHash, role: "admin" }).returning({ id: users.id });
    await createWallets(tx, user.id);
    await tx.insert(adminAudit).values({ actorId: user.id, targetId: user.id, action: "admin_bootstrap" });
    return user.id;
  });
}

export async function createParticipant(token: string, handleInput: unknown, password: unknown) {
  const handle = normalizeHandle(handleInput);
  if (typeof password !== "string") throw new MemberError("invalid_password");
  const passwordHash = await hashPassword(password);
  return memberDatabase().db.transaction(async tx => {
    const actor = await readSession(token, tx, true);
    requireAdministrator(actor);
    if ((await tx.select({ id: users.id }).from(users).where(eq(users.handle, handle)).limit(1)).length) throw new MemberError("handle_unavailable", 409);
    const [user] = await tx.insert(users).values({ handle, passwordHash, role: "participant" }).returning({ id: users.id });
    await createWallets(tx, user.id);
    await tx.insert(adminAudit).values({ actorId: actor.user.id, targetId: user.id, action: "account_created" });
    return user.id;
  });
}

export async function manageParticipant(token: string, targetId: unknown, action: "suspend" | "resume" | "reset-password", password?: unknown) {
  if (typeof targetId !== "string" || !uuidPattern.test(targetId)) throw new MemberError("invalid_request");
  const passwordHash = action === "reset-password" ? await hashPassword(typeof password === "string" ? password : "") : undefined;
  await memberDatabase().db.transaction(async tx => {
    const actor = await readSession(token, tx, true);
    requireAdministrator(actor);
    const [target] = await tx.select().from(users).where(eq(users.id, targetId)).for("update");
    if (!target || target.role !== "participant") throw new MemberError("forbidden", 403);
    await tx.update(users).set(passwordHash ? { passwordHash, mfaSecret: null, lastMfaStep: -1 } : { suspended: action === "suspend" }).where(eq(users.id, target.id));
    await tx.delete(sessions).where(eq(sessions.userId, target.id));
    await tx.insert(adminAudit).values({ actorId: actor.user.id, targetId: target.id, action });
  });
}

export async function adjustCredits(token: string, input: { recipientId: unknown; amount: unknown; kind: unknown; reason: unknown; operationKey: unknown; confirmed: unknown }) {
  const { recipientId, kind, reason, operationKey } = input;
  if (typeof recipientId !== "string" || !uuidPattern.test(recipientId) || typeof operationKey !== "string" || !uuidPattern.test(operationKey) || input.confirmed !== true) throw new MemberError("invalid_request");
  if ((kind !== "credit" && kind !== "debit") || typeof reason !== "string" || !(kind === "credit" ? ["demo_grant", "offline_credit", "correction"] : ["offline_debit", "correction"]).includes(reason)) throw new MemberError("invalid_request");
  const amount = parseCredits(input.amount);
  return memberDatabase().db.transaction(async tx => {
    const actor = await readSession(token, tx, true);
    requireAdministrator(actor);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))`);
    const requestHash = digest(JSON.stringify([actor.user.id, recipientId, amount.toString(), kind, reason]));
    const [prior] = await tx.select().from(journals).where(eq(journals.operationKey, operationKey));
    if (prior) {
      if (prior.requestHash !== requestHash) throw new MemberError("operation_conflict", 409);
      return prior.id;
    }
    const [target] = await tx.select().from(users).where(eq(users.id, recipientId)).for("update");
    if (!target || target.suspended) throw new MemberError("account_unavailable", 409);
    const accounts = await tx.select().from(ledgerAccounts).where(sql`${ledgerAccounts.kind} = 'issuance' OR (${ledgerAccounts.ownerId} = ${recipientId} AND ${ledgerAccounts.kind} = 'wallet')`).orderBy(asc(ledgerAccounts.id)).for("update");
    const wallet = accounts.find(account => account.kind === "wallet");
    const funding = accounts.find(account => account.kind === "issuance");
    if (!wallet || !funding) throw new MemberError("configuration", 503);
    if (kind === "debit" && wallet.balance < amount) throw new MemberError("insufficient_credits", 409);
    const [journal] = await tx.insert(journals).values({ operationKey, requestHash, actorId: actor.user.id, recipientId, amount, kind, reason }).returning({ id: journals.id });
    const change = kind === "credit" ? amount : -amount;
    await tx.insert(ledgerEntries).values(accounts.map(account => ({ journalId: journal.id, accountId: account.id, delta: account.id === wallet.id ? change : -change })));
    return journal.id;
  });
}

export async function accountSnapshot(token: string, page = 1) {
  const db = memberDatabase().db;
  const session = await readSession(token, db);
  requireMember(session);
  const balances = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.ownerId, session.user.id));
  const history = await db.select({ id: journals.id, kind: journals.kind, reason: journals.reason, amount: journals.amount, createdAt: journals.createdAt }).from(journals).where(eq(journals.recipientId, session.user.id)).orderBy(desc(journals.createdAt), desc(journals.id)).limit(21).offset((page - 1) * 20);
  return { session, available: balances.find(account => account.kind === "wallet")?.balance ?? 0n, reserved: balances.find(account => account.kind === "reserved")?.balance ?? 0n, history: history.slice(0, 20), hasNext: history.length > 20 };
}

export async function administratorSnapshot(token: string, page = 1, query = "") {
  const db = memberDatabase().db;
  const session = await readSession(token, db);
  requireAdministrator(session);
  const escaped = query.slice(0, 32).replace(/[\\%_]/g, "\\$&");
  const filter = escaped ? ilike(users.handle, `%${escaped}%`) : undefined;
  const accounts = await db.select({ id: users.id, handle: users.handle, role: users.role, suspended: users.suspended, balance: ledgerAccounts.balance }).from(users).innerJoin(ledgerAccounts, and(eq(ledgerAccounts.ownerId, users.id), eq(ledgerAccounts.kind, "wallet"))).where(filter).orderBy(asc(users.handle)).limit(20).offset((page - 1) * 20);
  const [totals] = await db.select({ total: count() }).from(users).where(filter);
  return { session, accounts, total: totals.total };
}

// Explicit local-host recovery for the sole administrator, never exposed over HTTP.
export async function recoverAdministrator(handleInput: unknown, password: string) {
  const handle = normalizeHandle(handleInput);
  const passwordHash = await hashPassword(password);
  await memberDatabase().db.transaction(async tx => {
    const [user] = await tx.select().from(users).where(and(eq(users.handle, handle), eq(users.role, "admin"))).for("update");
    if (!user) throw new MemberError("account_unavailable", 404);
    await tx.update(users).set({ passwordHash, mfaSecret: null, lastMfaStep: -1 }).where(eq(users.id, user.id));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await tx.insert(adminAudit).values({ actorId: user.id, targetId: user.id, action: "admin_host_recovery" });
  });
}
