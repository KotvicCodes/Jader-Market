import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "../src/db/client";
import { ledgerAccounts, sessions, users } from "../src/db/schema";
import { digest, hashPassword, totp } from "../src/domain/identity";
import { version } from "../package.json";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) {
  console.error("HTTP checks require a dedicated test database.");
  process.exit(1);
}
const connection = createDatabase(url);
const origin = "http://127.0.0.1:3107";
const secret = randomBytes(32).toString("hex");
const password = randomBytes(24).toString("base64url");
const suffix = randomUUID().slice(0, 8);
const adminHandle = `http_admin_${suffix}`;
const participantHandle = `http_user_${suffix}`;
let stage = "startup";
let child: ReturnType<typeof spawn> | undefined;
const adminCookies = new Map<string, string>();
const participantCookies = new Map<string, string>();

function check(condition: unknown) { if (!condition) throw new Error("HTTP assertion failed"); }

async function request(path: string, jar: Map<string, string>, body?: Record<string, unknown>, options: { origin?: string; csrf?: string; raw?: string } = {}) {
  const headers: Record<string, string> = { Cookie: Array.from(jar, ([key, value]) => `${key}=${value}`).join("; ") };
  if (body || options.raw) {
    headers["Content-Type"] = "application/json";
    headers.Origin = options.origin ?? origin;
    headers["X-CSRF-Token"] = options.csrf ?? jar.get("jader_csrf") ?? "";
  }
  const response = await fetch(`${origin}${path}`, { method: body || options.raw ? "POST" : "GET", headers, body: options.raw ?? (body ? JSON.stringify(body) : undefined), redirect: "manual" });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";");
    const split = pair.indexOf("=");
    jar.set(pair.slice(0, split), pair.slice(split + 1));
  }
  return response;
}

try {
  await migrate(connection.db, { migrationsFolder: "drizzle" });
  const [admin] = await connection.db.insert(users).values({ handle: adminHandle, role: "admin", passwordHash: await hashPassword(password) }).returning();
  await connection.db.insert(ledgerAccounts).values([{ kind: "wallet", ownerId: admin.id }, { kind: "reserved", ownerId: admin.id }]);
  await connection.db.insert(ledgerAccounts).values({ kind: "issuance" }).onConflictDoNothing();
  const temporaryDirectory = resolve(".cache/tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3107"], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: url, AUTH_SECRET: secret, APP_ORIGIN: origin, NEXT_TELEMETRY_DISABLED: "1", TMPDIR: temporaryDirectory },
  });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error("Test server stopped");
    try {
      const health = await (await fetch(`${origin}/api/health`)).json();
      check(health.version === version);
      ready = true;
      break;
    } catch { await delay(200); }
  }
  check(ready);

  stage = "anonymous access and origin checks";
  check((await request("/api/admin/credits", new Map(), {})).status === 401);
  check((await request("/api/auth/sign-in", new Map(), {}, { origin: "https://example.invalid" })).status === 403);
  check((await request("/admin", new Map())).status === 200);
  check(!(await (await request("/admin", new Map())).text()).includes(adminHandle));

  stage = "administrator sign-in and authenticator setup";
  const login = await request("/api/auth/sign-in", adminCookies, { handle: adminHandle, password });
  check(login.status === 200);
  check(login.headers.getSetCookie().every(cookie => cookie.includes("HttpOnly") && cookie.includes("SameSite=strict")));
  check((await request("/api/admin/create-account", adminCookies, { handle: participantHandle, password })).status === 403);
  const setup = await request("/api/account/mfa-start", adminCookies, { password });
  check(setup.status === 200);
  const { secret: mfaSecret } = await setup.json();
  const code = totp(mfaSecret, Math.floor(Date.now() / 30000));
  check((await request("/api/account/mfa-confirm", adminCookies, { code })).status === 200);
  check((await request("/api/auth/sign-in", new Map(), { handle: adminHandle, password, code })).status === 401);

  stage = "account creation and authorization";
  const created = await request("/api/admin/create-account", adminCookies, { handle: participantHandle, password, role: "admin" });
  check(created.status === 201);
  const { id: participantId } = await created.json();
  check((await connection.db.select().from(users).where(eq(users.id, participantId)))[0].role === "participant");
  check((await request("/api/auth/sign-in", participantCookies, { handle: participantHandle, password })).status === 200);
  check((await request("/api/admin/create-account", participantCookies, { handle: `forbidden_${suffix}`, password })).status === 403);
  const adjustment = { recipientId: participantId, amount: "150.125", kind: "credit", reason: "demo_grant", operationKey: randomUUID(), confirmed: true };
  check((await request("/api/admin/credits", participantCookies, adjustment)).status === 403);
  check((await request("/api/admin/credits", adminCookies, adjustment, { csrf: "invalid" })).status === 403);
  check((await request("/api/admin/credits", adminCookies, adjustment, { origin: "https://example.invalid" })).status === 403);
  check((await request("/api/admin/credits", adminCookies, { ...adjustment, confirmed: false })).status === 400);
  check((await request("/api/admin/credits", adminCookies, {}, { raw: JSON.stringify({ value: "x".repeat(5000) }) })).status === 413);

  stage = "persistent credits and idempotent retries";
  const first = await request("/api/admin/credits", adminCookies, adjustment);
  const repeated = await request("/api/admin/credits", adminCookies, adjustment);
  check(first.status === 200 && repeated.status === 200);
  check((await first.json()).id === (await repeated.json()).id);
  const portfolio = await request(`/portfolio?userId=${admin.id}`, participantCookies);
  check(portfolio.headers.get("cache-control")?.includes("no-store"));
  const html = (await portfolio.text()).replace(/<[^>]*>/g, "");
  check(html.includes(participantHandle) && html.includes("150.125") && !html.includes(adminHandle));
  check((await connection.db.select().from(ledgerAccounts).where(eq(ledgerAccounts.ownerId, participantId))).find(account => account.kind === "wallet")?.balance === 1_501_250n);

  stage = "recent administrator authentication";
  await connection.db.update(sessions).set({ authenticatedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(sessions.tokenHash, digest(adminCookies.get("jader_session")!)));
  check((await request("/api/admin/credits", adminCookies, { ...adjustment, operationKey: randomUUID() })).status === 403);
  const freshCode = totp(mfaSecret, Math.floor(Date.now() / 30000) + 1);
  check((await request("/api/account/reauthenticate", adminCookies, { password, code: freshCode })).status === 200);

  stage = "session revocation and password recovery";
  check((await request("/api/admin/suspend", adminCookies, { targetId: participantId, confirmed: true })).status === 200);
  check((await request("/api/account/reauthenticate", participantCookies, { password })).status === 401);
  check((await request("/api/auth/sign-in", new Map(), { handle: participantHandle, password })).status === 401);
  check((await request("/api/admin/resume", adminCookies, { targetId: participantId, confirmed: true })).status === 200);
  const replacement = randomBytes(24).toString("base64url");
  check((await request("/api/admin/reset-password", adminCookies, { targetId: participantId, password: replacement, confirmed: true })).status === 200);
  check((await request("/api/auth/sign-in", participantCookies, { handle: participantHandle, password: replacement })).status === 200);
  check((await request("/api/auth/sign-out", participantCookies, {})).status === 200);
  check((await request("/api/account/reauthenticate", participantCookies, { password: replacement })).status === 401);
  check((await request("/api/auth/sign-out", adminCookies, {})).status === 200);
  console.info("HTTP account, credit, privacy, CSRF, and session workflows passed.");
} catch {
  console.error(`HTTP verification failed during ${stage}.`);
  process.exitCode = 1;
} finally {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([new Promise<void>(resolveExit => child!.once("exit", () => resolveExit())), delay(3000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await connection.client.end();
}
