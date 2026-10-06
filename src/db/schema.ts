import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const marketStatus = pgEnum("market_status", ["draft", "open", "closed", "proposed", "resolved", "void", "cancelled"]);

export const markets = pgTable("markets", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  question: text("question").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  resolutionRules: text("resolution_rules").notNull(),
  resolutionSource: text("resolution_source").notNull(),
  status: marketStatus("status").notNull().default("draft"),
  closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  synthetic: text("synthetic").notNull().default("no"),
}, (table) => [
  index("market_public_index").on(table.status, table.closesAt),
  check("market_synthetic_valid", sql`${table.synthetic} IN ('yes', 'no')`),
  check("market_question_nonempty", sql`length(trim(${table.question})) BETWEEN 10 AND 240`),
  check("market_published_at_required", sql`${table.status} = 'draft' OR ${table.publishedAt} IS NOT NULL`),
]);
