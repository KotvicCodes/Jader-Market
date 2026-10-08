import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "../src/db/client";
import { ledgerAccounts, markets, sessions, users } from "../src/db/schema";
import { digest, hashPassword, totp } from "../src/domain/identity";
import { version } from "../package.json";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) {
  console.error("HTTP checks require a dedicated test database.");
  process.exit(1);
}
const control = createDatabase(url);
const databaseName = `jader_http_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
const isolatedUrl = new URL(url);
isolatedUrl.pathname = `/${databaseName}`;
const connection = createDatabase(isolatedUrl.toString());
let databaseCreated = false;
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

async function request(path: string, jar: Map<string, string>, body?: Record<string, unknown>, options: { origin?: string; csrf?: string; raw?: string; client?: string } = {}) {
  const headers: Record<string, string> = { "X-Test-Client-IP": options.client ?? "192.0.2.1", Cookie: Array.from(jar, ([key, value]) => `${key}=${value}`).join("; ") };
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
  await control.client.unsafe(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  await migrate(connection.db, { migrationsFolder: "drizzle" });
  const [admin] = await connection.db.insert(users).values({ handle: adminHandle, role: "admin", passwordHash: await hashPassword(password) }).returning();
  await connection.db.insert(ledgerAccounts).values([{ kind: "wallet", ownerId: admin.id }, { kind: "reserved", ownerId: admin.id }]);
  await connection.db.insert(ledgerAccounts).values({ kind: "issuance" }).onConflictDoNothing();
  const temporaryDirectory = resolve(".cache/tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3107"], {
    cwd: process.cwd(), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: isolatedUrl.toString(), AUTH_SECRET: secret, APP_ORIGIN: origin, AUTH_TRUSTED_IP_HEADER: "x-test-client-ip", NEXT_TELEMETRY_DISABLED: "1", TMPDIR: temporaryDirectory },
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

  stage = "market draft authorization and privacy";
  const draft = { question: `Will the synthetic HTTP launch ${suffix} happen?`, description: "A synthetic private market draft for HTTP verification.", category: "technology", resolutionRules: "Resolve YES only if the fictional launch is verified before closing. Otherwise resolve NO.", resolutionSource: "Synthetic launch record supplied by the operator.", closesAt: "2035-12-31T12:00:00Z", operationKey: randomUUID() };
  check((await request("/api/admin/markets/create", new Map(), draft)).status === 401);
  check((await request("/api/admin/markets/create", participantCookies, draft)).status === 403);
  check((await request("/api/admin/markets/create", adminCookies, draft, { csrf: "invalid" })).status === 403);
  check((await request("/api/admin/markets/create", adminCookies, draft, { origin: "https://example.invalid" })).status === 403);
  const newDraft = await request("/api/admin/markets/create", adminCookies, draft);
  check(newDraft.status === 201);
  const { id: marketId } = await newDraft.json();
  const slug = `market-${marketId}`;
  check((await (await request("/api/admin/markets/create", adminCookies, draft)).json()).id === marketId);
  check((await request(`/markets/${slug}`, new Map())).status === 404);
  check(!(await (await request("/", new Map())).text()).includes(draft.question));
  for (const jar of [new Map<string, string>(), participantCookies]) {
    const privatePage = await request(`/admin/markets/${marketId}`, jar);
    check(privatePage.headers.get("cache-control")?.includes("no-store"));
    check(!(await privatePage.text()).includes(draft.question));
  }
  const adminDraftPage = await request(`/admin/markets/${marketId}`, adminCookies);
  check(adminDraftPage.headers.get("cache-control")?.includes("no-store"));
  const adminDraftHtml = await adminDraftPage.text();
  check(adminDraftHtml.includes(draft.question) && adminDraftHtml.includes("Save draft") && adminDraftHtml.includes("Review publication"));
  check(!adminDraftHtml.includes('endpoint="/api/admin/markets/publish"'));
  const reviewHtml = await (await request(`/admin/markets/${marketId}?review=1`, adminCookies)).text();
  check(reviewHtml.includes("Review saved terms") && reviewHtml.includes("Publish market") && reviewHtml.includes(draft.resolutionRules));
  check(adminDraftHtml.includes('type="datetime-local"') && adminDraftHtml.includes('name="revision"'));
  const adminList = await (await request("/admin/markets", adminCookies)).text();
  check(adminList.includes("Create draft") && adminList.includes(draft.question));
  check((await (await request("/admin/markets/new", adminCookies)).text()).includes("Create a YES/NO market"));
  check((await request("/api/admin/markets/create", adminCookies, {}, { raw: JSON.stringify({ value: "x".repeat(17_000) }) })).status === 413);

  stage = "market editing, publication, and immutable terms";
  const edit = { ...draft, description: "Updated synthetic description for publication.", id: marketId, revision: "0", operationKey: randomUUID() };
  check((await request("/api/admin/markets/edit", adminCookies, edit)).status === 200);
  const publication = { id: marketId, revision: "1", operationKey: randomUUID(), confirmed: true };
  check((await request("/api/admin/markets/publish", adminCookies, { ...publication, confirmed: false })).status === 400);
  check((await request("/api/admin/markets/publish", adminCookies, { ...publication, revision: "0" })).status === 409);
  check((await request("/api/admin/markets/publish", adminCookies, publication)).status === 200);
  check((await request("/api/admin/markets/publish", adminCookies, publication)).status === 200);
  check((await request("/api/admin/markets/edit", adminCookies, { ...edit, revision: "2", operationKey: randomUUID() })).status === 409);
  const publicHtml = await (await request(`/markets/${slug}`, new Map())).text();
  check(publicHtml.includes(draft.question) && publicHtml.includes(edit.description) && publicHtml.includes("These published terms are fixed"));
  check(!publicHtml.includes("Administration history") && !publicHtml.includes("requestHash") && !publicHtml.includes("operationKey"));

  stage = "market pause, resume, and permanent close";
  const pause = { id: marketId, revision: "2", operationKey: randomUUID(), confirmed: true };
  check((await request("/api/admin/markets/pause", adminCookies, pause)).status === 200);
  check((await request("/api/admin/markets/pause", adminCookies, pause)).status === 200);
  check((await (await request(`/markets/${slug}`, new Map())).text()).includes("The administrator has paused this market"));
  check((await request("/api/admin/markets/resume", adminCookies, { ...pause, revision: "3", operationKey: randomUUID() })).status === 200);
  check((await request("/api/admin/markets/close", adminCookies, { ...pause, revision: "4", operationKey: randomUUID() })).status === 200);
  check((await request("/api/admin/markets/resume", adminCookies, { ...pause, revision: "5", operationKey: randomUUID() })).status === 409);
  check((await (await request(`/markets/${slug}`, new Map())).text()).includes("This market is closed"));
  check((await connection.db.select().from(markets).where(eq(markets.id, marketId)))[0].status === "closed");

  stage = "client-scoped login isolation";
  for (let i = 0; i < 11; i++) {
    const attempt = await request("/api/auth/sign-in", new Map(), { handle: participantHandle, password: "incorrect-password" }, { client: "198.51.100.2" });
    check(attempt.status === (i < 10 ? 401 : 429));
  }
  const isolatedLogin = await request("/api/auth/sign-in", new Map(), { handle: participantHandle, password }, { client: "198.51.100.3" });
  check(isolatedLogin.status === 200);
  const invalidClient = await request("/api/auth/sign-in", new Map(), { handle: participantHandle, password }, { client: "198.51.100.3, 198.51.100.4" });
  check(invalidClient.status === 503 && (await invalidClient.json()).error === "configuration");

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
  console.info("HTTP account, credit, market lifecycle, privacy, CSRF, and session workflows passed.");
} catch {
  console.error(`HTTP verification failed during ${stage}.`);
  process.exitCode = 1;
} finally {
  if (child) {
    child.kill("SIGTERM");
    await Promise.race([new Promise<void>(resolveExit => child!.once("exit", () => resolveExit())), delay(3000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  try {
    await connection.client.end();
  } finally {
    try {
      if (databaseCreated) await control.client.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    } catch {
      console.error("HTTP verification cleanup failed.");
      process.exitCode = 1;
    } finally {
      await control.client.end();
    }
  }
}
