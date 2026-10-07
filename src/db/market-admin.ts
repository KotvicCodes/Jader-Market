import { and, count, desc, eq, ilike, sql } from "drizzle-orm";
import { digest, MemberError } from "../domain/identity";
import { marketRevision, marketUuid, parseMarketTerms, type MarketAction } from "../domain/market-admin";
import { memberDatabase, readSession, requireAdministrator } from "./members";
import { marketAudit, markets } from "./schema";

export async function mutateMarket(token: string, action: MarketAction, input: Record<string, unknown>) {
  const operationKey = marketUuid(input.operationKey);
  const id = action === "create" ? operationKey : marketUuid(input.id);
  const revision = action === "create" ? 0 : marketRevision(input.revision);
  const terms = action === "create" || action === "edit" ? parseMarketTerms(input) : undefined;
  if (!terms && input.confirmed !== true) throw new MemberError("invalid_request");
  return memberDatabase().db.transaction(async tx => {
    const actor = await readSession(token, tx, true);
    requireAdministrator(actor);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))`);
    const requestHash = digest(JSON.stringify([actor.user.id, action, id, revision, terms]));
    const [prior] = await tx.select().from(marketAudit).where(eq(marketAudit.operationKey, operationKey));
    if (prior) {
      if (prior.requestHash !== requestHash) throw new MemberError("market_operation_conflict", 409);
      return { id: prior.marketId, revision: prior.revision };
    }
    let nextRevision = 0;
    if (action === "create") {
      // Stable generated URLs never incorporate private draft text.
      await tx.insert(markets).values({ id, slug: `market-${id}`, ...terms! });
    } else {
      const [market] = await tx.select().from(markets).where(eq(markets.id, id)).for("update");
      if (!market) throw new MemberError("market_missing", 404);
      if (market.revision !== revision) throw new MemberError("market_stale", 409);
      nextRevision = revision + 1;
      const now = new Date();
      let changes: Partial<typeof markets.$inferInsert>;
      if (action === "edit") {
        if (market.status !== "draft") throw new MemberError("market_terms_locked", 409);
        changes = terms!;
      } else if (action === "publish") {
        if (market.status !== "draft") throw new MemberError("market_transition", 409);
        // Revalidate stored terms before exposing drafts or legacy records.
        parseMarketTerms({ ...market, closesAt: market.closesAt.toISOString().replace(".000Z", "Z") });
        if (market.closesAt <= now) throw new MemberError("invalid_market_deadline");
        changes = { status: "open", publishedAt: now };
      } else {
        if (market.status !== "open") throw new MemberError("market_transition", 409);
        if (action === "close") changes = { status: "closed", paused: false };
        else {
          if (market.closesAt <= now) throw new MemberError("market_expired", 409);
          if (market.paused === (action === "pause")) throw new MemberError("market_transition", 409);
          changes = { paused: action === "pause" };
        }
      }
      await tx.update(markets).set({ ...changes, revision: nextRevision }).where(eq(markets.id, id));
    }
    await tx.insert(marketAudit).values({ marketId: id, actorId: actor.user.id, operationKey, requestHash, action, revision: nextRevision });
    return { id, revision: nextRevision };
  });
}

export async function administratorMarkets(token: string, page: number, query: string, status: string) {
  const db = memberDatabase().db;
  requireAdministrator(await readSession(token, db));
  const escaped = query.slice(0, 120).replace(/[\\%_]/g, "\\$&");
  const filter = and(escaped ? ilike(markets.question, `%${escaped}%`) : undefined, status === "draft" || status === "open" || status === "closed" ? eq(markets.status, status) : undefined);
  const [items, totals] = await Promise.all([
    db.select().from(markets).where(filter).orderBy(desc(markets.createdAt), desc(markets.id)).limit(20).offset((page - 1) * 20),
    db.select({ total: count() }).from(markets).where(filter),
  ]);
  return { items, total: totals[0].total };
}

export async function administratorMarket(token: string, inputId: string, auditPage: number) {
  const db = memberDatabase().db;
  requireAdministrator(await readSession(token, db));
  const id = marketUuid(inputId);
  const [market] = await db.select().from(markets).where(eq(markets.id, id));
  if (!market) throw new MemberError("market_missing", 404);
  const history = await db.select({ id: marketAudit.id, action: marketAudit.action, revision: marketAudit.revision, createdAt: marketAudit.createdAt }).from(marketAudit).where(eq(marketAudit.marketId, id)).orderBy(desc(marketAudit.createdAt), desc(marketAudit.id)).limit(21).offset((auditPage - 1) * 20);
  return { market, history: history.slice(0, 20), hasNext: history.length > 20 };
}
