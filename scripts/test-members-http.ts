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
import { spawnSync } from "node:child_process";
import { syntheticMarkets } from "../src/db/fixtures";

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
const buyerHandle = `http_buyer_${suffix}`;
let stage = "startup";
let child: ReturnType<typeof spawn> | undefined;
const adminCookies = new Map<string, string>();
const participantCookies = new Map<string, string>();
const buyerCookies = new Map<string, string>();

function check(condition: unknown) { if (!condition) { const frame = new Error().stack?.split("\n")[2]?.match(/:(\d+):\d+\)?$/)?.[1]; throw new Error(`HTTP assertion failed at check line ${frame ?? "unknown"}`); } }

async function request(path: string, jar: Map<string, string>, body?: Record<string, unknown>, options: { origin?: string; csrf?: string; raw?: string; client?: string; expectedOwner?: string } = {}) {
  const headers: Record<string, string> = { "X-Test-Client-IP": options.client ?? "192.0.2.1", Cookie: Array.from(jar, ([key, value]) => `${key}=${value}`).join("; ") };
  if (body || options.raw) {
    headers["Content-Type"] = "application/json";
    headers.Origin = options.origin ?? origin;
    headers["X-CSRF-Token"] = options.csrf ?? jar.get("jader_csrf") ?? "";
  }
  if (options.expectedOwner) headers["X-Account-ID"] = options.expectedOwner;
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
  const buyerCreated = await request("/api/admin/create-account", adminCookies, { handle: buyerHandle, password });
  check(buyerCreated.status === 201);
  const { id: buyerId } = await buyerCreated.json();
  check((await request("/api/auth/sign-in", buyerCookies, { handle: buyerHandle, password })).status === 200);
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

  stage = "private cross-market portfolio API and cursor validation";
  check((await request("/api/account/portfolio", new Map())).status === 401);
  const portfolioResponse = await request(`/api/account/portfolio?ownerId=${admin.id}`, participantCookies);
  check(portfolioResponse.status === 200 && portfolioResponse.headers.get("cache-control")?.includes("no-store"));
  const portfolioData = await portfolioResponse.json();
  check(portfolioData.member.id === participantId && portfolioData.availableCredits === "1501250");
  for (const privateField of ["csrfHash", "tokenHash", "passwordHash", "requestHash", adminHandle]) check(!JSON.stringify(portfolioData).includes(privateField));
  check((await request("/api/account/portfolio?ordersBefore=invalid", participantCookies)).status === 400);
  check((await request("/api/account/portfolio?fillsBefore=1&fillsBefore=2", participantCookies)).status === 400);
  check((await (await request("/portfolio?activityBefore=invalid", participantCookies)).text()).includes("Invalid portfolio link"));

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
  check((await request(`/api/markets/${marketId}/book`, new Map())).status === 404);
  check((await request(`/api/markets/${marketId}/portfolio`, participantCookies)).status === 404);
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
  check(publicHtml.includes("Sign in to trade"));
  check(!publicHtml.includes("Administration history") && !publicHtml.includes("requestHash") && !publicHtml.includes("operationKey"));

  stage = "trading authorization, reservations, matching, and privacy";
  const mint = { marketId, operationKey: randomUUID(), quantity: "5" };
  check((await request("/api/trading/mint", new Map(), mint)).status === 401);
  check((await request("/api/trading/mint", participantCookies, mint, { csrf: "invalid" })).status === 403);
  check((await request("/api/trading/mint", participantCookies, mint, { origin: "https://example.invalid" })).status === 403);
  check((await request("/api/trading/mint", participantCookies, { ...mint, quantity: 5 })).status === 400);
  check((await request("/api/trading/mint", participantCookies, mint)).status === 200);
  check((await request("/api/trading/mint", participantCookies, mint)).status === 200);
  const sell = { marketId, operationKey: randomUUID(), outcome: "YES", side: "sell", price: "2500", quantity: "3", timeInForce: "GTC" };
  const sellResult = await request("/api/trading/place", participantCookies, sell);
  check(sellResult.status === 200);
  const { order: sellOrder } = await sellResult.json();
  check((await request("/api/trading/cancel", adminCookies, { marketId, operationKey: randomUUID(), orderId: sellOrder.id })).status === 404);
  check((await request(`/api/markets/${marketId}/portfolio`, new Map())).status === 401);
  const own = await request(`/api/markets/${marketId}/portfolio?ownerId=${admin.id}`, participantCookies);
  check(own.headers.get("cache-control")?.includes("no-store"));
  const ownData = await own.json();
  check(ownData.holdings.find((h: { outcome: string }) => h.outcome === "YES").reserved === "3");
  check((await (await request(`/api/markets/${marketId}/portfolio`, adminCookies)).json()).orders.length === 0);
  const publicBook = await request(`/api/markets/${marketId}/book`, new Map());
  check(publicBook.headers.get("cache-control")?.includes("no-store"));
  const bookText = await publicBook.text();
  for (const value of [participantId, admin.id, sellOrder.id, participantHandle, "ownerId", "reservedCredits"]) check(!bookText.includes(value));
  check(JSON.parse(bookText).book[0].quantity === "3");
  const bookPage = await (await request(`/markets/${slug}`, new Map())).text();
  check(bookPage.includes("Ask") && bookPage.includes("0.25") && !bookPage.includes("No executable orders"));
  stage = "automatic market snapshots and account-bound submissions";
  const anonymousSnapshotResponse = await request(`/api/markets/${marketId}/snapshot`, new Map());
  check(anonymousSnapshotResponse.status === 200 && anonymousSnapshotResponse.headers.get("cache-control")?.includes("no-store"));
  const anonymousSnapshotText = await anonymousSnapshotResponse.text();
  const anonymousSnapshot = JSON.parse(anonymousSnapshotText);
  check(anonymousSnapshot.account === null && anonymousSnapshot.trading.book[0].quantity === "3");
  for (const value of [participantId, admin.id, sellOrder.id, participantHandle, participantCookies.get("jader_csrf")!]) check(!anonymousSnapshotText.includes(value));
  const ownerSnapshot = await (await request(`/api/markets/${marketId}/snapshot`, participantCookies)).json();
  check(ownerSnapshot.account.ownerId === participantId && ownerSnapshot.account.csrf === participantCookies.get("jader_csrf"));
  check(ownerSnapshot.account.portfolio.openOrders[0].id === sellOrder.id);
  const changedAccount = await request("/api/trading/mint", participantCookies, { ...mint, operationKey: randomUUID() }, { expectedOwner: buyerId });
  check(changedAccount.status === 401 && (await changedAccount.json()).error === "account_changed");
  check((await (await request(`/api/markets/${marketId}/snapshot`, participantCookies)).json()).account.portfolio.availableCredits === ownerSnapshot.account.portfolio.availableCredits);
  check((await request("/api/markets/not-a-uuid/snapshot", new Map())).status === 400);
  stage = "authenticated market controls and privacy";
  const tradingPage = await request(`/markets/${slug}`, participantCookies);
  check(tradingPage.headers.get("cache-control")?.includes("no-store"));
  const tradingHtml = await tradingPage.text();
  check(tradingHtml.includes('aria-label="Trading ticket"'));
  const tradingVisible = tradingHtml.replace(/<[^>]*>/g, "");
  for (const label of ["Review order", "Your shares in this market", "Your open orders", "Cancel remaining", sellOrder.id]) check(tradingVisible.includes(label));
  for (const privateValue of [sellOrder.id, participantId, buyerId, participantCookies.get("jader_csrf")!]) check(!bookPage.includes(privateValue));
  check(!tradingHtml.includes(buyerId) && !tradingHtml.includes(buyerCookies.get("jader_csrf")!));
  stage = "synthetic market controls";
  const [browsingExample] = await connection.db.insert(markets).values(syntheticMarkets[0]).returning();
  check((await request("/api/trading/mint", participantCookies, { ...mint, marketId: browsingExample.id, operationKey: randomUUID() })).status === 409);
  check((await (await request(`/api/markets/${browsingExample.id}/book`, new Map())).json()).executable === false);
  check((await (await request(`/markets/${browsingExample.slug}`, new Map())).text()).includes("Browsing example only"));
  stage = "second participant funding and execution";
  check((await request("/api/admin/credits", adminCookies, { recipientId: buyerId, operationKey: randomUUID(), amount: "10", kind: "credit", reason: "demo_grant", confirmed: true })).status === 200);
  const purchase = await request("/api/trading/place", buyerCookies, { ...sell, operationKey: randomUUID(), side: "buy", price: "3000", quantity: "2", timeInForce: "IOC" });
  check(purchase.status === 200);
  const purchaseData = await purchase.json();
  check(purchaseData.order.status === "filled" && purchaseData.fills[0].price === "2500");
  const sellerPortfolio = await (await request(`/api/markets/${marketId}/portfolio`, participantCookies)).json();
  check(sellerPortfolio.orders[0].remaining === "1" && sellerPortfolio.fills[0].side === "sell");
  const buyerPortfolio = await (await request(`/api/markets/${marketId}/portfolio`, buyerCookies)).json();
  check(buyerPortfolio.availableCredits === "95000" && buyerPortfolio.reservedCredits === "0" && buyerPortfolio.holdings[0].available === "2");
  check((await request(`/api/markets/${marketId}/book?before=invalid`, new Map())).status === 400);

  const refreshedSnapshot = await (await request(`/api/markets/${marketId}/snapshot`, participantCookies)).json();
  check(refreshedSnapshot.trading.book[0].quantity === "1" && refreshedSnapshot.account.portfolio.fills[0].quantity === "2");
  check(refreshedSnapshot.account.portfolio.openOrders[0].remaining === "1");
  stage = "participant partial-fill display and reviewed cancellation endpoint";
  const partialPage = (await (await request(`/markets/${slug}`, participantCookies)).text()).replace(/<[^>]*>/g, "");
  check(partialPage.includes("2 of 3 shares filled; 1 remain open") && partialPage.includes("Cancel remaining 1 shares"));
  const completePortfolioPage = await request("/portfolio", participantCookies);
  check(completePortfolioPage.headers.get("cache-control")?.includes("no-store"));
  const completePortfolioHtml = await completePortfolioPage.text();
  const completeVisible = completePortfolioHtml.replace(/<[^>]*>/g, "");
  for (const label of ["Holdings across markets", "All open orders", "Order history", "Fills across markets", "Transaction history", "Cancel remaining 1 shares", sellOrder.id]) check(completeVisible.includes(label));
  check(!completePortfolioHtml.includes(buyerId) && !completePortfolioHtml.includes(purchaseData.order.id));
  const buyerComplete = await (await request("/api/account/portfolio", buyerCookies)).json();
  check(buyerComplete.fills.items[0].side === "buy" && buyerComplete.fills.items[0].total === "5000");
  check(buyerComplete.activity.items.some((a: { source: string; kind: string; orderReserved: string }) => a.source === "credit" && a.kind === "trade" && a.orderReserved === "-5000"));
  const cancellation = { marketId, operationKey: randomUUID(), orderId: sellOrder.id };
  check((await request("/api/trading/cancel", participantCookies, cancellation)).status === 200);
  check((await request("/api/trading/cancel", participantCookies, cancellation)).status === 200);
  const afterCancel = await (await request(`/api/markets/${marketId}/portfolio`, participantCookies)).json();
  check(afterCancel.openOrders.length === 0 && afterCancel.holdings.find((h: { outcome: string }) => h.outcome === "YES").reserved === "0");

  stage = "market pause, resume, and permanent close";
  const pause = { id: marketId, revision: "2", operationKey: randomUUID(), confirmed: true };
  check((await request("/api/admin/markets/pause", adminCookies, pause)).status === 200);
  check((await request("/api/admin/markets/pause", adminCookies, pause)).status === 200);
  check((await (await request(`/markets/${slug}`, new Map())).text()).includes("The administrator has paused this market"));
  check((await request("/api/trading/place", adminCookies, { ...sell, side: "buy", operationKey: randomUUID() })).status === 409);
  check((await request("/api/admin/markets/resume", adminCookies, { ...pause, revision: "3", operationKey: randomUUID() })).status === 200);
  check((await request("/api/admin/markets/close", adminCookies, { ...pause, revision: "4", operationKey: randomUUID() })).status === 200);
  check((await request("/api/admin/markets/resume", adminCookies, { ...pause, revision: "5", operationKey: randomUUID() })).status === 409);
  check((await (await request(`/markets/${slug}`, new Map())).text()).includes("This market is closed"));
  check((await connection.db.select().from(markets).where(eq(markets.id, marketId)))[0].status === "closed");
  const closedPortfolio = await (await request(`/api/markets/${marketId}/portfolio`, participantCookies)).json();
  check(closedPortfolio.orders[0].status === "cancelled" && closedPortfolio.holdings.find((h: { outcome: string }) => h.outcome === "YES").reserved === "0");

  stage = "immutable resolution, collateral payouts, and private receipts";
  const resolution = { id: marketId, revision: "5", operationKey: randomUUID(), result: "YES", evidence: "Synthetic public evidence confirms the published YES outcome.", confirmed: true };
  check((await request("/api/admin/markets/resolve", new Map(), resolution)).status === 401);
  check((await request("/api/admin/markets/resolve", participantCookies, resolution)).status === 403);
  check((await request("/api/admin/markets/resolve", adminCookies, resolution, { csrf: "invalid" })).status === 403);
  check((await request("/api/admin/markets/resolve", adminCookies, resolution, { origin: "https://example.invalid" })).status === 403);
  check((await request("/api/admin/markets/resolve", adminCookies, { ...resolution, evidence: "short" })).status === 400);
  check((await request("/api/admin/markets/resolve", adminCookies, { ...resolution, revision: "4" })).status === 409);
  check((await request("/api/admin/markets/resolve", adminCookies, resolution)).status === 200);
  check((await request("/api/admin/markets/resolve", adminCookies, resolution)).status === 200);
  check((await request("/api/admin/markets/resolve", adminCookies, { ...resolution, result: "NO" })).status === 409);
  const settlingPage = await (await request(`/markets/${slug}`, new Map())).text();
  check(settlingPage.includes("Final result: ") && settlingPage.includes(resolution.evidence) && settlingPage.includes("Collateral payouts are in progress"));
  check(!settlingPage.includes(participantId) && !settlingPage.includes(admin.id));
  const workerEnv = { ...process.env, DATABASE_URL: isolatedUrl.toString(), AUTH_SECRET: secret };
  for (let pass=0; pass<2; pass++) {
    const worker = spawnSync(process.execPath, ["scripts/run.mjs", "node", "--import", "./scripts/register-typescript.mjs", "scripts/worker.ts", "--once"], { cwd: process.cwd(), env: workerEnv, encoding: "utf8", timeout: 30000 });
    check(!worker.error && worker.status === 0);
  }
  check((await connection.db.select().from(markets).where(eq(markets.id, marketId)))[0].status === "resolved");
  check((await request("/api/admin/markets/resolve", adminCookies, resolution)).status === 200);
  const settledPage = await (await request(`/markets/${slug}`, new Map())).text();
  check(settledPage.includes("Payouts complete") && settledPage.includes("0.5 credits per YES share"));
  check((await request("/api/account/payouts", new Map())).status === 401);
  const receiptsResponse = await request(`/api/account/payouts?ownerId=${admin.id}`, participantCookies);
  check(receiptsResponse.headers.get("cache-control")?.includes("no-store"));
  const receipts = (await receiptsResponse.json()).items;
  check(receipts.length === 2 && receipts.every((p: { result: string }) => p.result === "YES"));
  check(receipts.reduce((sum: bigint, p: { amount: string }) => sum+BigInt(p.amount), 0n) === 30000n);
  const buyerReceipts = (await (await request("/api/account/payouts", buyerCookies)).json()).items;
  check(buyerReceipts.length === 1 && buyerReceipts[0].amount === "20000");
  const receiptPage = await (await request("/portfolio", participantCookies)).text();
  check(receiptPage.includes("Market payout receipts") && receiptPage.includes(receipts[0].id) && !receiptPage.includes(buyerReceipts[0].id));
  const settledBuyer = (await (await request(`/api/markets/${marketId}/portfolio`, buyerCookies)).json());
  check(settledBuyer.availableCredits === "115000" && settledBuyer.holdings.every((h: { available: string; reserved: string }) => h.available === "0" && h.reserved === "0"));

  const settledSnapshot = await (await request(`/api/markets/${marketId}/snapshot`, participantCookies)).json();
  check(settledSnapshot.trading.status === "resolved" && settledSnapshot.resolution.result === "YES");
  check(settledSnapshot.account.portfolio.holdings.every((h: { available: string; reserved: string }) => h.available === "0" && h.reserved === "0"));
  const completeSettled = await (await request("/api/account/portfolio", participantCookies)).json();
  check(completeSettled.holdings.items.length === 0 && completeSettled.openOrders.length === 0);
  check(completeSettled.payouts.items.length === 2 && completeSettled.payouts.items.some((p: { amount: string }) => p.amount === "0"));
  if (completeSettled.activity.nextCursor) {
    const olderActivity = await request(`/api/account/portfolio?activityBefore=${encodeURIComponent(completeSettled.activity.nextCursor)}`, participantCookies);
    check(olderActivity.status === 200 && (await olderActivity.json()).activity.items.length > 0);
  }

  stage = "reserved offline withdrawals and private operator queue";
  const withdrawalBefore = await (await request(`/api/markets/${marketId}/portfolio`, participantCookies)).json();
  const withdrawal = { amount: "5.25", operationKey: randomUUID(), confirmed: true, ownerId: admin.id };
  check((await request("/api/withdrawals/request", new Map(), withdrawal)).status === 401);
  check((await request("/api/withdrawals/request", participantCookies, withdrawal, { csrf: "invalid" })).status === 403);
  check((await request("/api/withdrawals/request", participantCookies, withdrawal, { origin: "https://example.invalid" })).status === 403);
  const withdrawalResponse = await request("/api/withdrawals/request", participantCookies, withdrawal);
  check(withdrawalResponse.status === 200 && withdrawalResponse.headers.get("cache-control")?.includes("no-store"));
  const withdrawalRow = await withdrawalResponse.json();
  check(withdrawalRow.status === "requested" && withdrawalRow.amount === "52500");
  check((await (await request("/api/withdrawals/request", participantCookies, withdrawal)).json()).id === withdrawalRow.id);
  const withdrawalBalance = await (await request(`/api/markets/${marketId}/portfolio`, participantCookies)).json();
  check(BigInt(withdrawalBefore.availableCredits) - BigInt(withdrawalBalance.availableCredits) === 52500n && withdrawalBalance.reservedCredits === "52500");
  const privateWithdrawal = await request(`/withdrawals?ownerId=${admin.id}`, participantCookies);
  check(privateWithdrawal.headers.get("cache-control")?.includes("no-store"));
  check((await privateWithdrawal.text()).includes(withdrawalRow.id));
  for (const jar of [new Map<string, string>(), adminCookies]) check(!(await (await request("/withdrawals", jar)).text()).includes(withdrawalRow.id));
  const queue = await request("/admin/withdrawals", adminCookies);
  check(queue.headers.get("cache-control")?.includes("no-store") && (await queue.text()).includes(withdrawalRow.id));
  check(!(await (await request("/admin/withdrawals", participantCookies)).text()).includes(withdrawalRow.id));
  const withdrawAction = { id: withdrawalRow.id, previousOperationId: withdrawalRow.lastOperationId, operationKey: randomUUID(), confirmed: true };
  check((await request("/api/withdrawals/start", participantCookies, withdrawAction)).status === 403);
  check((await request("/api/withdrawals/pay", adminCookies, { ...withdrawAction, reference: `synthetic-early-${suffix}` })).status === 409);
  check((await request("/api/admin/credits", adminCookies, { recipientId: participantId, amount: "1", kind: "debit", reason: "offline_debit", operationKey: randomUUID(), confirmed: true })).status === 400);
  const started = await request("/api/withdrawals/start", adminCookies, withdrawAction);
  check(started.status === 200);
  const processingWithdrawal = await started.json();
  const payment = { ...withdrawAction, previousOperationId: processingWithdrawal.lastOperationId, operationKey: randomUUID(), reference: `synthetic-payment-${suffix}` };
  check((await request("/api/withdrawals/cancel", participantCookies, { ...payment, note: "Synthetic participant cannot cancel processing." })).status === 409);
  const paid = await request("/api/withdrawals/pay", adminCookies, payment);
  check(paid.status === 200 && (await paid.json()).status === "paid");
  check((await request("/api/withdrawals/pay", adminCookies, payment)).status === 200);
  const afterWithdrawal = await (await request(`/api/markets/${marketId}/portfolio`, participantCookies)).json();
  check(afterWithdrawal.availableCredits === withdrawalBalance.availableCredits && afterWithdrawal.reservedCredits === "0");
  check((await (await request("/withdrawals", participantCookies)).text()).includes(payment.reference));
  check(!(await (await request("/withdrawals", adminCookies)).text()).includes(payment.reference));
  const secondWithdrawal = await (await request("/api/withdrawals/request", participantCookies, { ...withdrawal, amount: "1", operationKey: randomUUID() })).json();
  const secondProcessing = await (await request("/api/withdrawals/start", adminCookies, { ...withdrawAction, id: secondWithdrawal.id, previousOperationId: secondWithdrawal.lastOperationId, operationKey: randomUUID() })).json();
  const release = { ...withdrawAction, id: secondProcessing.id, previousOperationId: secondProcessing.lastOperationId, operationKey: randomUUID(), note: "Synthetic external records confirm no transfer was sent." };
  check((await request("/api/withdrawals/release", adminCookies, release)).status === 409);
  check((await request("/api/withdrawals/release", adminCookies, { ...release, verifiedNotSent: true })).status === 200);
  check((await (await request(`/api/markets/${marketId}/portfolio`, participantCookies)).json()).availableCredits === afterWithdrawal.availableCredits);

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
  console.info("HTTP accounts, credits, market lifecycle, trading, reserved withdrawals, privacy, CSRF, and session workflows passed.");
} catch (error) {
  console.error(`HTTP verification failed during ${stage}.`);
  if (error instanceof Error && /^HTTP assertion failed at check line [0-9]+$/.test(error.message)) console.error(error.message);
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
