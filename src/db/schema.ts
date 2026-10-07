import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
  paused: boolean("paused").notNull().default(false),
  revision: integer("revision").notNull().default(0),
}, (table) => [
  index("market_public_index").on(table.status, table.closesAt),
  check("market_synthetic_valid", sql`${table.synthetic} IN ('yes', 'no')`),
  check("market_question_nonempty", sql`length(trim(${table.question})) BETWEEN 10 AND 240`),
  check("market_published_at_required", sql`${table.status} = 'draft' OR ${table.publishedAt} IS NOT NULL`),
  check("market_pause_valid", sql`NOT ${table.paused} OR ${table.status} = 'open'`),
  check("market_revision_valid", sql`${table.revision} >= 0`),
]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  handle: text("handle").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("participant"),
  suspended: boolean("suspended").notNull().default(false),
  mfaSecret: text("mfa_secret"),
  lastMfaStep: integer("last_mfa_step").notNull().default(-1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("user_handle_valid", sql`${table.handle} ~ '^[a-z][a-z0-9_-]{2,31}$'`),
  check("user_role_valid", sql`${table.role} IN ('admin', 'participant')`),
]);

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  csrfHash: text("csrf_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull().defaultNow(),
  pendingMfa: text("pending_mfa"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("session_user_index").on(table.userId)]);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
});

export const ledgerAccounts = pgTable("ledger_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").references(() => users.id),
  kind: text("kind").notNull(),
  balance: bigint("balance", { mode: "bigint" }).notNull().default(sql`0`),
}, table => [
  uniqueIndex("ledger_owner_kind_unique").on(table.ownerId, table.kind),
  uniqueIndex("ledger_issuance_unique").on(table.kind).where(sql`${table.kind} = 'issuance'`),
  check("ledger_account_kind_valid", sql`${table.kind} IN ('issuance', 'wallet', 'reserved')`),
  check("ledger_owner_valid", sql`(${table.kind} = 'issuance' AND ${table.ownerId} IS NULL) OR (${table.kind} <> 'issuance' AND ${table.ownerId} IS NOT NULL)`),
  check("ledger_balance_valid", sql`${table.balance} BETWEEN -9000000000000000 AND 9000000000000000 AND (${table.kind} = 'issuance' OR ${table.balance} >= 0)`),
]);

export const journals = pgTable("journals", {
  id: uuid("id").defaultRandom().primaryKey(),
  operationKey: uuid("operation_key").notNull().unique(),
  requestHash: text("request_hash").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  recipientId: uuid("recipient_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  reason: text("reason").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  transactionId: bigint("transaction_id", { mode: "bigint" }).notNull().default(sql`txid_current()`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("journal_recipient_index").on(table.recipientId, table.createdAt),
  check("journal_kind_valid", sql`${table.kind} IN ('credit', 'debit')`),
  check("journal_reason_valid", sql`${table.reason} IN ('demo_grant', 'offline_credit', 'offline_debit', 'correction')`),
  check("journal_amount_valid", sql`${table.amount} BETWEEN 1 AND 10000000000`),
]);

export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  journalId: uuid("journal_id").notNull().references(() => journals.id),
  accountId: uuid("account_id").notNull().references(() => ledgerAccounts.id),
  delta: bigint("delta", { mode: "bigint" }).notNull(),
}, table => [
  uniqueIndex("ledger_entry_account_unique").on(table.journalId, table.accountId),
  index("ledger_entry_account_index").on(table.accountId),
  check("ledger_delta_valid", sql`${table.delta} <> 0`),
]);

export const adminAudit = pgTable("admin_audit", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  targetId: uuid("target_id").notNull().references(() => users.id),
  action: text("action").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const marketAudit = pgTable("market_audit", {
  id: uuid("id").defaultRandom().primaryKey(),
  marketId: uuid("market_id").notNull().references(() => markets.id),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  operationKey: uuid("operation_key").notNull().unique(),
  requestHash: text("request_hash").notNull(),
  action: text("action").notNull(),
  revision: integer("revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("market_audit_history_index").on(table.marketId, table.createdAt),
  check("market_audit_action_valid", sql`${table.action} IN ('create', 'edit', 'publish', 'pause', 'resume', 'close')`),
]);
