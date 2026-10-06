import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { createDatabase, getDatabase } from "../../src/db/client";
import { listMarkets } from "../../src/db/markets";
import { parseMarketQuery } from "../../src/domain/market-query";
import { markets } from "../../src/db/schema";
import { syntheticMarkets } from "../../src/db/fixtures";

const url = process.env.TEST_DATABASE_URL;
let safeTestDatabase = false;
try { safeTestDatabase = Boolean(url && new URL(url).pathname.endsWith("_test")); } catch {}
if (!url || !safeTestDatabase) throw new Error("A dedicated test database is required.");
const connection = createDatabase(url);
process.env.DATABASE_URL = url;

beforeAll(async () => {
  await migrate(connection.db, { migrationsFolder: "drizzle" });
  await connection.db.delete(markets);
});
afterAll(async () => { await connection.client.end(); await getDatabase()?.client.end(); });

describe("market storage", () => {
  it("seeds idempotently and does not expose a draft through a public selection", async () => {
    await connection.db.insert(markets).values(syntheticMarkets).onConflictDoNothing();
    await connection.db.insert(markets).values(syntheticMarkets).onConflictDoNothing();
    await connection.db.insert(markets).values({ ...syntheticMarkets[0], slug: "private-draft", status: "draft", publishedAt: null });
    const published = await listMarkets(parseMarketQuery({}));
    expect(published.state).toBe("ready");
    expect(published.items).toHaveLength(3);
    expect(published.items.some(market => market.slug === "private-draft")).toBe(false);
  });
  it("filters public markets and treats wildcard searches literally", async () => {
    expect((await listMarkets(parseMarketQuery({ category: "science" }))).items).toHaveLength(1);
    expect((await listMarkets(parseMarketQuery({ q: "launch" }))).items).toHaveLength(1);
    expect((await listMarkets(parseMarketQuery({ q: "%" }))).items).toHaveLength(0);
  });
  it("rejects a published market without a publication timestamp", async () => {
    await expect(connection.db.insert(markets).values({ ...syntheticMarkets[0], slug: "invalid-publish", publishedAt: null })).rejects.toThrow();
    expect(await connection.db.select().from(markets).where(eq(markets.slug, "invalid-publish"))).toHaveLength(0);
  });
});
