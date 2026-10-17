// Keep this list aligned with the application triggers installed by migrations.
// Migration markers and table columns do not prove a restore included its guards.
export const requiredDatabaseTriggers: Record<string, readonly string[]> = {
  journals: ["journals_immutable", "journal_balanced", "trading_journal_balanced"],
  ledger_entries: ["entries_immutable", "ledger_apply"],
  admin_audit: ["admin_audit_immutable"],
  ledger_accounts: ["account_projection", "account_identity", "trading_account_projection"],
  market_audit: ["market_audit_immutable"],
  markets: ["market_terms_guard", "market_order_lifecycle"],
  trading_operations: ["trading_operations_immutable", "trading_operation_guard", "synthetic_trading_guard"],
  fills: ["fills_immutable", "fill_guard"],
  share_movements: ["movements_immutable", "movement_apply", "movement_guard"],
  trading_outbox: ["outbox_immutable", "outbox_operation_guard"],
  orders: ["order_change_guard", "order_projection"],
  holdings: ["holding_identity", "holding_projection"],
  users: ["suspended_order_lifecycle"],
  market_deadline_events: ["deadline_events_immutable", "deadline_event_guard"],
};
