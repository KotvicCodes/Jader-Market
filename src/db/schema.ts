import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const marketStatus = pgEnum("market_status", ["draft", "open", "closed", "settling", "proposed", "resolved", "void", "cancelled"]);

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
  marketId: uuid("market_id").references(() => markets.id),
  balance: bigint("balance", { mode: "bigint" }).notNull().default(sql`0`),
}, table => [
  uniqueIndex("ledger_owner_kind_unique").on(table.ownerId, table.kind),
  uniqueIndex("ledger_issuance_unique").on(table.kind).where(sql`${table.kind} = 'issuance'`),
  uniqueIndex("ledger_escrow_unique").on(table.marketId).where(sql`${table.kind} = 'escrow'`),
  check("ledger_account_kind_valid", sql`${table.kind} IN ('issuance', 'wallet', 'reserved', 'withdrawal_reserved', 'escrow')`),
  check("ledger_owner_valid", sql`(${table.kind} = 'issuance' AND ${table.ownerId} IS NULL AND ${table.marketId} IS NULL) OR (${table.kind} = 'escrow' AND ${table.ownerId} IS NULL AND ${table.marketId} IS NOT NULL) OR (${table.kind} IN ('wallet', 'reserved', 'withdrawal_reserved') AND ${table.ownerId} IS NOT NULL AND ${table.marketId} IS NULL)`),
  check("ledger_balance_valid", sql`${table.balance} BETWEEN -9000000000000000 AND 9000000000000000 AND (${table.kind} = 'issuance' OR ${table.balance} >= 0)`),
]);

export const journals = pgTable("journals", {
  id: uuid("id").defaultRandom().primaryKey(),
  operationKey: uuid("operation_key").notNull().unique(),
  requestHash: text("request_hash").notNull(),
  tradingOperationId: uuid("trading_operation_id"),
  withdrawalOperationId: uuid("withdrawal_operation_id"),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  recipientId: uuid("recipient_id").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  reason: text("reason").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  transactionId: bigint("transaction_id", { mode: "bigint" }).notNull().default(sql`txid_current()`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("journal_recipient_index").on(table.recipientId, table.createdAt),
  index("journal_trading_operation_index").on(table.tradingOperationId),
  uniqueIndex("journal_withdrawal_operation_unique").on(table.withdrawalOperationId),
  check("journal_operation_source", sql`${table.tradingOperationId} IS NULL OR ${table.withdrawalOperationId} IS NULL`),
  check("journal_kind_valid", sql`${table.kind} IN ('credit', 'debit', 'mint', 'burn', 'reserve', 'release', 'trade', 'payout')`),
  check("journal_reason_valid", sql`${table.reason} IN ('demo_grant', 'offline_credit', 'offline_debit', 'correction', 'trading', 'withdrawal')`),
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
  check("market_audit_action_valid", sql`${table.action} IN ('create', 'edit', 'publish', 'pause', 'resume', 'close', 'resolve')`),
]);


export const tradingOperations = pgTable("trading_operations", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").references(() => users.id),
  marketId: uuid("market_id").notNull().references(() => markets.id),
  action: text("action").notNull(),
  requestHash: text("request_hash").notNull(),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  transactionId: bigint("transaction_id", { mode: "bigint" }).notNull().default(sql`txid_current()`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [check("trading_action_valid", sql`${table.action} IN ('mint', 'burn', 'place', 'cancel', 'maintenance', 'settle')`)]);

export const holdings = pgTable("holdings", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  marketId: uuid("market_id").notNull().references(() => markets.id),
  outcome: text("outcome").$type<"YES" | "NO">().notNull(),
  available: bigint("available", { mode: "bigint" }).notNull().default(sql`0`),
  reserved: bigint("reserved", { mode: "bigint" }).notNull().default(sql`0`),
}, table => [
  uniqueIndex("holding_owner_market_outcome").on(table.ownerId, table.marketId, table.outcome),
  index("holding_market_index").on(table.marketId),
  check("holding_valid", sql`${table.outcome} IN ('YES', 'NO') AND ${table.available} BETWEEN 0 AND 9000000000000000 AND ${table.reserved} BETWEEN 0 AND 9000000000000000`),
]);

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey(),
  operationId: uuid("operation_id").notNull(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  marketId: uuid("market_id").notNull().references(() => markets.id),
  outcome: text("outcome").$type<"YES" | "NO">().notNull(),
  side: text("side").$type<"buy" | "sell">().notNull(),
  price: bigint("price", { mode: "bigint" }).notNull(),
  quantity: bigint("quantity", { mode: "bigint" }).notNull(),
  remaining: bigint("remaining", { mode: "bigint" }).notNull(),
  timeInForce: text("time_in_force").$type<"GTC" | "GTD" | "IOC">().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  status: text("status").$type<"open" | "filled" | "cancelled" | "expired">().notNull().default("open"),
  reason: text("reason"),
  sequence: bigint("sequence", { mode: "bigint" }).generatedAlwaysAsIdentity(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("order_book_index").on(table.marketId, table.outcome, table.side, table.status, table.price, table.sequence),
  index("order_owner_index").on(table.ownerId, table.status, table.sequence),
  check("order_valid", sql`${table.outcome} IN ('YES', 'NO') AND ${table.side} IN ('buy', 'sell') AND ${table.price} BETWEEN 1 AND 9999 AND ${table.quantity} BETWEEN 1 AND 1000000 AND ${table.remaining} BETWEEN 0 AND ${table.quantity} AND ${table.status} IN ('open', 'filled', 'cancelled', 'expired') AND (${table.status} <> 'open' OR ${table.remaining} > 0) AND (${table.status} <> 'filled' OR ${table.remaining} = 0) AND ${table.timeInForce} IN ('GTC', 'GTD', 'IOC') AND ((${table.timeInForce} = 'GTD') = (${table.expiresAt} IS NOT NULL))`),
]);

export const fills = pgTable("fills", {
  id: uuid("id").primaryKey(),
  operationId: uuid("operation_id").notNull(),
  marketId: uuid("market_id").notNull().references(() => markets.id),
  buyOrderId: uuid("buy_order_id").notNull().references(() => orders.id),
  sellOrderId: uuid("sell_order_id").notNull().references(() => orders.id),
  makerOrderId: uuid("maker_order_id").notNull().references(() => orders.id),
  outcome: text("outcome").$type<"YES" | "NO">().notNull(),
  price: bigint("price", { mode: "bigint" }).notNull(),
  quantity: bigint("quantity", { mode: "bigint" }).notNull(),
  sequence: bigint("sequence", { mode: "bigint" }).generatedAlwaysAsIdentity(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("fill_market_index").on(table.marketId, table.sequence),
  index("fill_buy_order_index").on(table.buyOrderId),
  index("fill_sell_order_index").on(table.sellOrderId),
  check("fill_valid", sql`${table.outcome} IN ('YES', 'NO') AND ${table.price} BETWEEN 1 AND 9999 AND ${table.quantity} BETWEEN 1 AND 1000000`),
]);

export const shareMovements = pgTable("share_movements", {
  id: uuid("id").defaultRandom().primaryKey(),
  operationId: uuid("operation_id").notNull(),
  groupId: uuid("group_id").notNull(),
  holdingId: uuid("holding_id").notNull().references(() => holdings.id),
  kind: text("kind").notNull(),
  availableDelta: bigint("available_delta", { mode: "bigint" }).notNull(),
  reservedDelta: bigint("reserved_delta", { mode: "bigint" }).notNull(),
}, table => [
  index("movement_holding_index").on(table.holdingId),
  index("movement_operation_index").on(table.operationId),
  index("movement_group_index").on(table.groupId),
  uniqueIndex("movement_group_holding_unique").on(table.groupId, table.holdingId),
  check("movement_valid", sql`${table.kind} IN ('mint', 'burn', 'reserve', 'release', 'trade', 'payout') AND (${table.availableDelta} <> 0 OR ${table.reservedDelta} <> 0)`),
]);

export const tradingOutbox = pgTable("trading_outbox", {
  sequence: bigint("sequence", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  operationId: uuid("operation_id"),
  journalId: uuid("journal_id").references(() => journals.id),
  marketId: uuid("market_id").references(() => markets.id),
  ownerId: uuid("owner_id").references(() => users.id),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("outbox_scope_index").on(table.marketId, table.ownerId, table.sequence),
  check("outbox_source_valid", sql`(${table.operationId} IS NOT NULL) <> (${table.journalId} IS NOT NULL)`),
]);

export const marketDeadlineEvents = pgTable("market_deadline_events", {
  marketId: uuid("market_id").primaryKey().references(() => markets.id),
  operationId: uuid("operation_id").notNull().references(() => tradingOperations.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Resolution evidence and payout receipts are append-only and verified at commit.
export const marketResolutions = pgTable("market_resolutions", {
  id: uuid("id").primaryKey(),
  marketId: uuid("market_id").notNull().unique().references(() => markets.id),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  result: text("result").$type<"YES" | "NO" | "invalid">().notNull(),
  evidence: text("evidence").notNull(),
  requestHash: text("request_hash").notNull(),
  transactionId: bigint("transaction_id", { mode: "bigint" }).notNull().default(sql`txid_current()`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [check("resolution_valid", sql`${table.result} IN ('YES', 'NO', 'invalid') AND length(trim(${table.evidence})) BETWEEN 20 AND 2000`)]);

export const marketPayouts = pgTable("market_payouts", {
  id: uuid("id").primaryKey(),
  resolutionId: uuid("resolution_id").notNull().references(() => marketResolutions.id),
  holdingId: uuid("holding_id").notNull().references(() => holdings.id),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  quantity: bigint("quantity", { mode: "bigint" }).notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  journalId: uuid("journal_id").unique().references(() => journals.id),
  sequence: bigint("sequence", { mode: "bigint" }).generatedAlwaysAsIdentity(),
  transactionId: bigint("transaction_id", { mode: "bigint" }).notNull().default(sql`txid_current()`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("payout_owner_sequence_index").on(table.ownerId, table.sequence),
  index("payout_resolution_index").on(table.resolutionId),
  check("payout_valid", sql`${table.quantity} BETWEEN 1 AND 1000000 AND ${table.amount} BETWEEN 0 AND 10000000000 AND ((${table.amount} = 0) = (${table.journalId} IS NULL))`),
]);

export const withdrawals = pgTable("withdrawals", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  status: text("status").$type<"requested" | "processing" | "paid" | "cancelled">().notNull(),
  lastOperationId: uuid("last_operation_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("withdrawal_owner_index").on(table.ownerId, table.createdAt, table.id),
  index("withdrawal_queue_index").on(table.status, table.createdAt, table.id),
  check("withdrawal_valid", sql`${table.amount} BETWEEN 1 AND 10000000000 AND ${table.status} IN ('requested', 'processing', 'paid', 'cancelled')`),
]);

export const withdrawalOperations = pgTable("withdrawal_operations", {
  id: uuid("id").primaryKey(),
  withdrawalId: uuid("withdrawal_id").notNull().references(() => withdrawals.id),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  action: text("action").$type<"request" | "start" | "pay" | "cancel" | "release">().notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  requestHash: text("request_hash").notNull(),
  reference: text("reference").notNull().default(""),
  note: text("note").notNull().default(""),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  transactionId: bigint("transaction_id", { mode: "bigint" }).notNull().default(sql`txid_current()`),
  sequence: bigint("sequence", { mode: "bigint" }).generatedAlwaysAsIdentity(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("withdrawal_operation_history_index").on(table.withdrawalId, table.sequence),
  uniqueIndex("withdrawal_payment_reference_unique").on(table.reference).where(sql`${table.action} = 'pay'`),
  check("withdrawal_operation_valid", sql`${table.action} IN ('request', 'start', 'pay', 'cancel', 'release') AND length(${table.note}) <= 400 AND length(${table.reference}) <= 120`),
]);
