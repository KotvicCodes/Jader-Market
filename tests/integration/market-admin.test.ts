import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, getDatabase } from "../../src/db/client";
import { administratorMarket, administratorMarkets, mutateMarket } from "../../src/db/market-admin";
import { findPublicMarket, listMarkets } from "../../src/db/markets";
import { marketAudit, markets, sessions, users } from "../../src/db/schema";
import { digest, encryptSecret, randomToken } from "../../src/domain/identity";
import { parseMarketQuery } from "../../src/domain/market-query";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required.");
const control = createDatabase(url);
const name = `jader_markets_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
const isolatedUrl = new URL(url);
isolatedUrl.pathname = `/${name}`;
process.env.DATABASE_URL = isolatedUrl.toString();
process.env.AUTH_SECRET = randomBytes(32).toString("hex");
const connection = createDatabase(isolatedUrl.toString());
const adminToken = randomToken();
const participantToken = randomToken();
const terms = { question: "Will the fictional launch happen?", description: "An isolated synthetic test market.", resolutionRules: "Resolve YES only on a verified launch, otherwise NO.", resolutionSource: "Fictional launch record", category: "technology", closesAt: "2035-12-31T12:00:00Z" };
let created = false;
let id: string;

beforeAll(async () => {
  await control.client.unsafe(`CREATE DATABASE "${name}"`);
  created = true;
  await migrate(connection.db, { migrationsFolder: "drizzle" });
  for (const [role, token] of [["admin", adminToken], ["participant", participantToken]]) {
    const [user] = await connection.db.insert(users).values({ handle: `market_${role}`, passwordHash: "unused-test-hash", role, mfaSecret: role === "admin" ? encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") : null }).returning();
    await connection.db.insert(sessions).values({ userId: user.id, tokenHash: digest(token), csrfHash: digest(randomToken()), expiresAt: new Date(Date.now() + 3600_000) });
  }
});
afterAll(async () => {
  await connection.client.end();
  await getDatabase()?.client.end();
  if (created) await control.client.unsafe(`DROP DATABASE "${name}"`);
  await control.client.end();
});
const act = (action: "publish" | "pause" | "resume" | "close", revision: number, extra = {}) => mutateMarket(adminToken, action, { id, revision, confirmed: true, operationKey: randomUUID(), ...extra });

describe("administrator market lifecycle", () => {
  it("keeps drafts private and creates exactly once under concurrent retries", async () => {
    const operationKey = randomUUID();
    const results = await Promise.all([mutateMarket(adminToken, "create", { ...terms, operationKey }), mutateMarket(adminToken, "create", { ...terms, operationKey })]);
    id = results[0].id;
    expect(results[1].id).toBe(id);
    expect((await listMarkets(parseMarketQuery({}))).total).toBe(0);
    expect((await findPublicMarket(`market-${id}`)).state).toBe("missing");
    expect((await administratorMarket(adminToken, id, 1)).history).toHaveLength(1);
    await expect(mutateMarket(adminToken, "create", { ...terms, question: "A changed fictional question?", operationKey })).rejects.toMatchObject({ code: "market_operation_conflict" });
  });
  it("blocks participants, expired administrator authentication, and missing confirmations", async () => {
    await expect(mutateMarket(participantToken, "create", { ...terms, operationKey: randomUUID() })).rejects.toMatchObject({ code: "forbidden" });
    await expect(administratorMarkets(participantToken, 1, "", "all")).rejects.toMatchObject({ code: "forbidden" });
    await expect(act("publish", 0, { confirmed: false })).rejects.toMatchObject({ code: "invalid_request" });
    await connection.db.update(sessions).set({ authenticatedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(sessions.tokenHash, digest(adminToken)));
    await expect(act("publish", 0)).rejects.toMatchObject({ code: "reauth_required" });
    await connection.db.update(sessions).set({ authenticatedAt: new Date() }).where(eq(sessions.tokenHash, digest(adminToken)));
  });
  it("prevents lost edits and concurrent publication of different terms", async () => {
    const results = await Promise.allSettled([
      mutateMarket(adminToken, "edit", { ...terms, description: "Updated synthetic description.", id, revision: 0, operationKey: randomUUID() }),
      act("publish", 0),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "market_stale" } });
    const snapshot = await administratorMarket(adminToken, id, 1);
    if (snapshot.market.status === "draft") await act("publish", 1);
    expect((await findPublicMarket(`market-${id}`)).state).toBe("ready");
  });
  it("locks every published term at both service and database boundaries", async () => {
    const { market } = await administratorMarket(adminToken, id, 1);
    await expect(mutateMarket(adminToken, "edit", { ...terms, id, revision: market.revision, operationKey: randomUUID() })).rejects.toMatchObject({ code: "market_terms_locked" });
    for (const changes of [{ question: "A changed published question?" }, { closesAt: new Date("2036-01-01Z") }, { publishedAt: null }, { slug: "changed-url" }, { resolutionRules: "Changed published resolution rules." }, { status: "draft" as const }]) {
      await expect(connection.db.update(markets).set({ ...changes, revision: market.revision + 1 }).where(eq(markets.id, id))).rejects.toThrow();
    }
    await expect(connection.db.delete(markets).where(eq(markets.id, id))).rejects.toThrow();
  });
  it("pauses, resumes, closes, and safely retries actions without reopening", async () => {
    const { market } = await administratorMarket(adminToken, id, 1);
    const operationKey = randomUUID();
    const first = await act("pause", market.revision, { operationKey });
    expect(await act("pause", market.revision, { operationKey })).toEqual(first);
    expect((await findPublicMarket(`market-${id}`)).state).toBe("ready");
    await act("resume", first.revision);
    await act("close", first.revision + 1);
    await expect(act("resume", first.revision + 2)).rejects.toMatchObject({ code: "market_transition" });
    const snapshot = await administratorMarket(adminToken, id, 1);
    expect(snapshot.market.status).toBe("closed");
    expect(snapshot.market.paused).toBe(false);
    expect(snapshot.history.map(row => row.action)).toContain("close");
    await expect(connection.db.update(marketAudit).set({ action: "resume" }).where(eq(marketAudit.marketId, id))).rejects.toThrow();
    await expect(connection.db.delete(marketAudit).where(eq(marketAudit.marketId, id))).rejects.toThrow();
  });
  it("rejects publication and resumption beyond the deadline", async () => {
    const past = await mutateMarket(adminToken, "create", { ...terms, closesAt: "2000-01-01T00:00:00Z", operationKey: randomUUID() });
    await expect(act("publish", 0, { id: past.id })).rejects.toMatchObject({ code: "invalid_market_deadline" });
    const [expired] = await connection.db.insert(markets).values({ ...terms, slug: `expired-${randomUUID()}`, closesAt: new Date("2000-01-01Z"), status: "open", paused: true, publishedAt: new Date("1999-01-01Z") }).returning();
    await expect(act("resume", 0, { id: expired.id })).rejects.toMatchObject({ code: "market_expired" });
    await act("close", 0, { id: expired.id });
  });
  it("bounds admin list/history pages and treats wildcard searches literally", async () => {
    for (let i = 0; i < 21; i++) await mutateMarket(adminToken, "create", { ...terms, operationKey: randomUUID() });
    expect((await administratorMarkets(adminToken, 1, "", "draft")).items).toHaveLength(20);
    expect((await administratorMarkets(adminToken, 2, "", "draft")).items.length).toBeGreaterThan(0);
    expect((await administratorMarkets(adminToken, 1, "%", "all")).total).toBe(0);
    expect((await administratorMarket(adminToken, id, 2)).history).toHaveLength(0);
  });
});
