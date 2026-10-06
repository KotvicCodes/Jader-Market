import { and, asc, count, eq, ilike, inArray, or } from "drizzle-orm";
import { parseMarketQuery } from "../domain/market-query";
import { getDatabase } from "./client";
import { markets } from "./schema";

const publicStatuses = ["open", "closed", "proposed", "resolved", "void", "cancelled"] as const;

export async function listMarkets(input: ReturnType<typeof parseMarketQuery>) {
  const connection = getDatabase();
  if (!connection) return { state: "unconfigured" as const, items: [], total: 0 };
  const escaped = input.query.replace(/[\\%_]/g, "\\$&");
  const filters = and(
    inArray(markets.status, publicStatuses),
    input.category === "all" ? undefined : eq(markets.category, input.category),
    input.query ? or(ilike(markets.question, `%${escaped}%`), ilike(markets.description, `%${escaped}%`)) : undefined,
  );
  try {
    const [items, totals] = await Promise.all([
      connection.db.select().from(markets).where(filters).orderBy(asc(markets.closesAt), asc(markets.id)).limit(input.pageSize).offset((input.page - 1) * input.pageSize),
      connection.db.select({ total: count() }).from(markets).where(filters),
    ]);
    return { state: "ready" as const, items, total: totals[0].total };
  } catch {
    return { state: "unavailable" as const, items: [], total: 0 };
  }
}

export async function findPublicMarket(slug: string) {
  const connection = getDatabase();
  if (!connection) return { state: "unavailable" as const };
  try {
    const [market] = await connection.db.select().from(markets).where(and(eq(markets.slug, slug), inArray(markets.status, publicStatuses))).limit(1);
    return market ? { state: "ready" as const, market } : { state: "missing" as const };
  } catch {
    return { state: "unavailable" as const };
  }
}
