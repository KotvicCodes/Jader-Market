CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"buy_order_id" uuid NOT NULL,
	"sell_order_id" uuid NOT NULL,
	"maker_order_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"price" bigint NOT NULL,
	"quantity" bigint NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "fills_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fill_valid" CHECK ("fills"."outcome" IN ('YES', 'NO') AND "fills"."price" BETWEEN 1 AND 9999 AND "fills"."quantity" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"available" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "holding_valid" CHECK ("holdings"."outcome" IN ('YES', 'NO') AND "holdings"."available" BETWEEN 0 AND 9000000000000000 AND "holdings"."reserved" BETWEEN 0 AND 9000000000000000)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"side" text NOT NULL,
	"price" bigint NOT NULL,
	"quantity" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"time_in_force" text NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "orders_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_valid" CHECK ("orders"."outcome" IN ('YES', 'NO') AND "orders"."side" IN ('buy', 'sell') AND "orders"."price" BETWEEN 1 AND 9999 AND "orders"."quantity" BETWEEN 1 AND 1000000 AND "orders"."remaining" BETWEEN 0 AND "orders"."quantity" AND "orders"."status" IN ('open', 'filled', 'cancelled', 'expired') AND ("orders"."status" <> 'open' OR "orders"."remaining" > 0) AND ("orders"."status" <> 'filled' OR "orders"."remaining" = 0) AND "orders"."time_in_force" IN ('GTC', 'GTD', 'IOC') AND (("orders"."time_in_force" = 'GTD') = ("orders"."expires_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "share_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"holding_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"available_delta" bigint NOT NULL,
	"reserved_delta" bigint NOT NULL,
	CONSTRAINT "movement_valid" CHECK ("share_movements"."kind" IN ('mint', 'burn', 'reserve', 'release', 'trade') AND ("share_movements"."available_delta" <> 0 OR "share_movements"."reserved_delta" <> 0))
);
--> statement-breakpoint
CREATE TABLE "trading_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid,
	"market_id" uuid NOT NULL,
	"action" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"transaction_id" bigint DEFAULT txid_current() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_action_valid" CHECK ("trading_operations"."action" IN ('mint', 'burn', 'place', 'cancel', 'maintenance'))
);
--> statement-breakpoint
CREATE TABLE "trading_outbox" (
	"sequence" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "trading_outbox_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"operation_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"owner_id" uuid,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journals" DROP CONSTRAINT "journal_kind_valid";--> statement-breakpoint
ALTER TABLE "journals" DROP CONSTRAINT "journal_reason_valid";--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_account_kind_valid";--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_owner_valid";--> statement-breakpoint
ALTER TABLE "journals" ADD COLUMN "trading_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "market_id" uuid;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_buy_order_id_orders_id_fk" FOREIGN KEY ("buy_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_sell_order_id_orders_id_fk" FOREIGN KEY ("sell_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_maker_order_id_orders_id_fk" FOREIGN KEY ("maker_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_movements" ADD CONSTRAINT "share_movements_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_operations" ADD CONSTRAINT "trading_operations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_operations" ADD CONSTRAINT "trading_operations_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_outbox" ADD CONSTRAINT "trading_outbox_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_outbox" ADD CONSTRAINT "trading_outbox_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fill_market_index" ON "fills" USING btree ("market_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "holding_owner_market_outcome" ON "holdings" USING btree ("owner_id","market_id","outcome");--> statement-breakpoint
CREATE INDEX "order_book_index" ON "orders" USING btree ("market_id","outcome","side","status","price","sequence");--> statement-breakpoint
CREATE INDEX "order_owner_index" ON "orders" USING btree ("owner_id","status","sequence");--> statement-breakpoint
CREATE INDEX "movement_holding_index" ON "share_movements" USING btree ("holding_id");--> statement-breakpoint
CREATE INDEX "movement_group_index" ON "share_movements" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "outbox_scope_index" ON "trading_outbox" USING btree ("market_id","owner_id","sequence");--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_escrow_unique" ON "ledger_accounts" USING btree ("market_id") WHERE "ledger_accounts"."kind" = 'escrow';--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journal_kind_valid" CHECK ("journals"."kind" IN ('credit', 'debit', 'mint', 'burn', 'reserve', 'release', 'trade'));--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journal_reason_valid" CHECK ("journals"."reason" IN ('demo_grant', 'offline_credit', 'offline_debit', 'correction', 'trading'));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_account_kind_valid" CHECK ("ledger_accounts"."kind" IN ('issuance', 'wallet', 'reserved', 'escrow'));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_owner_valid" CHECK (("ledger_accounts"."kind" = 'issuance' AND "ledger_accounts"."owner_id" IS NULL AND "ledger_accounts"."market_id" IS NULL) OR ("ledger_accounts"."kind" = 'escrow' AND "ledger_accounts"."owner_id" IS NULL AND "ledger_accounts"."market_id" IS NOT NULL) OR ("ledger_accounts"."kind" IN ('wallet', 'reserved') AND "ledger_accounts"."owner_id" IS NOT NULL AND "ledger_accounts"."market_id" IS NULL));--> statement-breakpoint
-- Operations are inserted last with their immutable original response.
ALTER TABLE journals ADD CONSTRAINT journal_trading_operation_fk FOREIGN KEY (trading_operation_id) REFERENCES trading_operations(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE orders ADD CONSTRAINT order_operation_fk FOREIGN KEY (operation_id) REFERENCES trading_operations(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE fills ADD CONSTRAINT fill_operation_fk FOREIGN KEY (operation_id) REFERENCES trading_operations(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE share_movements ADD CONSTRAINT movement_operation_fk FOREIGN KEY (operation_id) REFERENCES trading_operations(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE trading_outbox ADD CONSTRAINT outbox_operation_fk FOREIGN KEY (operation_id) REFERENCES trading_operations(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER trading_operations_immutable BEFORE UPDATE OR DELETE ON trading_operations FOR EACH ROW EXECUTE FUNCTION reject_record_change();
CREATE TRIGGER fills_immutable BEFORE UPDATE OR DELETE ON fills FOR EACH ROW EXECUTE FUNCTION reject_record_change();
CREATE TRIGGER movements_immutable BEFORE UPDATE OR DELETE ON share_movements FOR EACH ROW EXECUTE FUNCTION reject_record_change();
CREATE TRIGGER outbox_immutable BEFORE UPDATE OR DELETE ON trading_outbox FOR EACH ROW EXECUTE FUNCTION reject_record_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION preserve_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.kind, NEW.owner_id, NEW.market_id) IS DISTINCT FROM ROW(OLD.id, OLD.kind, OLD.owner_id, OLD.market_id) THEN
    RAISE EXCEPTION 'Immutable ledger account identity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION guard_order_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Immutable order history'; END IF;
  IF ROW(NEW.id,NEW.operation_id,NEW.owner_id,NEW.market_id,NEW.outcome,NEW.side,NEW.price,NEW.quantity,NEW.time_in_force,NEW.expires_at,NEW.sequence,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.operation_id,OLD.owner_id,OLD.market_id,OLD.outcome,OLD.side,OLD.price,OLD.quantity,OLD.time_in_force,OLD.expires_at,OLD.sequence,OLD.created_at)
    OR OLD.status <> 'open' OR NEW.remaining > OLD.remaining THEN RAISE EXCEPTION 'Invalid order change'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_change_guard BEFORE UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION guard_order_change();
CREATE FUNCTION guard_holding_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(NEW.id,NEW.owner_id,NEW.market_id,NEW.outcome) IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.market_id,OLD.outcome) THEN
    RAISE EXCEPTION 'Immutable holding identity'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER holding_identity BEFORE UPDATE OR DELETE ON holdings FOR EACH ROW EXECUTE FUNCTION guard_holding_identity();
CREATE FUNCTION apply_share_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trading_operations WHERE id=NEW.operation_id AND transaction_id<>txid_current()) THEN RAISE EXCEPTION 'Operation finalized'; END IF;
  UPDATE holdings SET available=available+NEW.available_delta, reserved=reserved+NEW.reserved_delta WHERE id=NEW.holding_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER movement_apply AFTER INSERT ON share_movements FOR EACH ROW EXECUTE FUNCTION apply_share_movement();
--> statement-breakpoint
ALTER FUNCTION verify_journal() RENAME TO verify_admin_journal;
CREATE FUNCTION verify_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op trading_operations; n integer; total numeric; src uuid; dst uuid; f fills; b orders; s orders; expected bigint;
BEGIN
  IF NEW.kind IN ('credit','debit') THEN
    -- The old constraint trigger still invokes the original admin-only verifier.
    RETURN NEW;
  END IF;
  SELECT * INTO op FROM trading_operations WHERE id=NEW.trading_operation_id;
  SELECT count(*),sum(delta) INTO n,total FROM ledger_entries WHERE journal_id=NEW.id;
  IF op.id IS NULL OR NEW.reason<>'trading' OR NEW.transaction_id<>txid_current() OR op.transaction_id<>txid_current() OR n<>2 OR total<>0 THEN RAISE EXCEPTION 'Invalid trading journal'; END IF;
  IF NEW.kind IN ('mint','burn') THEN
    IF op.action<>NEW.kind OR NEW.actor_id<>op.owner_id OR NEW.recipient_id<>op.owner_id OR NEW.amount%10000<>0 THEN RAISE EXCEPTION 'Invalid complete set'; END IF;
    SELECT id INTO src FROM ledger_accounts WHERE owner_id=op.owner_id AND kind='wallet';
    SELECT id INTO dst FROM ledger_accounts WHERE market_id=op.market_id AND kind='escrow';
    expected := CASE WHEN NEW.kind='mint' THEN NEW.amount ELSE -NEW.amount END;
    IF (SELECT count(*) FROM share_movements m JOIN holdings h ON h.id=m.holding_id WHERE m.group_id=NEW.id AND m.operation_id=op.id AND m.kind=NEW.kind AND h.owner_id=op.owner_id AND h.market_id=op.market_id AND m.available_delta=expected/10000 AND m.reserved_delta=0)<>2
       OR (SELECT count(DISTINCT h.outcome) FROM share_movements m JOIN holdings h ON h.id=m.holding_id WHERE m.group_id=NEW.id)<>2 THEN RAISE EXCEPTION 'Invalid complete set shares'; END IF;
  ELSIF NEW.kind IN ('reserve','release') THEN
    IF op.action NOT IN ('place','cancel','maintenance') OR (NEW.kind='reserve' AND (op.action<>'place' OR NEW.recipient_id<>op.owner_id)) THEN RAISE EXCEPTION 'Invalid reservation'; END IF;
    SELECT id INTO src FROM ledger_accounts WHERE owner_id=NEW.recipient_id AND kind='wallet';
    SELECT id INTO dst FROM ledger_accounts WHERE owner_id=NEW.recipient_id AND kind='reserved';
    expected := CASE WHEN NEW.kind='reserve' THEN NEW.amount ELSE -NEW.amount END;
  ELSIF NEW.kind='trade' THEN
    SELECT * INTO f FROM fills WHERE id=NEW.id AND operation_id=op.id;
    SELECT * INTO b FROM orders WHERE id=f.buy_order_id;
    SELECT * INTO s FROM orders WHERE id=f.sell_order_id;
    IF f.id IS NULL OR NEW.amount<>f.price*f.quantity OR NEW.recipient_id<>s.owner_id THEN RAISE EXCEPTION 'Invalid trade journal'; END IF;
    SELECT id INTO src FROM ledger_accounts WHERE owner_id=b.owner_id AND kind='reserved';
    SELECT id INTO dst FROM ledger_accounts WHERE owner_id=s.owner_id AND kind='wallet';
    expected := NEW.amount;
  ELSE RAISE EXCEPTION 'Unknown journal'; END IF;
  IF src IS NULL OR dst IS NULL OR NOT EXISTS (SELECT 1 FROM ledger_entries WHERE journal_id=NEW.id AND account_id=src AND delta=-expected)
    OR NOT EXISTS (SELECT 1 FROM ledger_entries WHERE journal_id=NEW.id AND account_id=dst AND delta=expected) THEN RAISE EXCEPTION 'Invalid journal accounts'; END IF;
  RETURN NEW;
END;
$$;
-- Retain the legacy verifier for credit/debit journals, including admin authorization.
CREATE OR REPLACE FUNCTION verify_admin_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_count integer; total numeric; expected bigint;
BEGIN
  IF NEW.kind NOT IN ('credit','debit') THEN RETURN NEW; END IF;
  SELECT count(*),coalesce(sum(delta),0) INTO line_count,total FROM ledger_entries WHERE journal_id=NEW.id;
  expected:=CASE WHEN NEW.kind='credit' THEN NEW.amount ELSE -NEW.amount END;
  IF NEW.trading_operation_id IS NOT NULL OR NEW.reason='trading' OR NEW.transaction_id<>txid_current() OR line_count<>2 OR total<>0
    OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_id AND role='admin' AND suspended=false)
    OR NOT EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.journal_id=NEW.id AND a.kind='wallet' AND a.owner_id=NEW.recipient_id AND e.delta=expected)
    OR NOT EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.journal_id=NEW.id AND a.kind='issuance' AND e.delta=-expected)
  THEN RAISE EXCEPTION 'Invalid journal'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trading_journal_balanced AFTER INSERT ON journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_journal();
--> statement-breakpoint
CREATE FUNCTION verify_holding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h holdings; a numeric; r numeric; needed numeric;
BEGIN
  SELECT * INTO h FROM holdings WHERE id=NEW.id;
  SELECT coalesce(sum(available_delta),0),coalesce(sum(reserved_delta),0) INTO a,r FROM share_movements WHERE holding_id=h.id;
  SELECT coalesce(sum(remaining),0) INTO needed FROM orders WHERE owner_id=h.owner_id AND market_id=h.market_id AND outcome=h.outcome AND side='sell' AND status='open';
  IF h.available<>a OR h.reserved<>r OR h.reserved<>needed THEN RAISE EXCEPTION 'Holding reconciliation failed'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER holding_projection AFTER INSERT OR UPDATE ON holdings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_holding();
CREATE FUNCTION verify_trading_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a ledger_accounts; needed numeric; yes_supply numeric; no_supply numeric;
BEGIN
  SELECT * INTO a FROM ledger_accounts WHERE id=NEW.id;
  IF a.kind='reserved' THEN
    SELECT coalesce(sum(price*remaining),0) INTO needed FROM orders WHERE owner_id=a.owner_id AND side='buy' AND status='open';
    IF a.balance<>needed THEN RAISE EXCEPTION 'Credit reservation mismatch'; END IF;
  ELSIF a.kind='escrow' THEN
    SELECT coalesce(sum(available+reserved) FILTER (WHERE outcome='YES'),0),coalesce(sum(available+reserved) FILTER (WHERE outcome='NO'),0) INTO yes_supply,no_supply FROM holdings WHERE market_id=a.market_id;
    IF yes_supply<>no_supply OR a.balance<>yes_supply*10000 THEN RAISE EXCEPTION 'Collateral mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trading_account_projection AFTER INSERT OR UPDATE ON ledger_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_trading_account();
CREATE FUNCTION verify_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o orders; op trading_operations; filled numeric; needed numeric; stored numeric;
BEGIN
  SELECT * INTO o FROM orders WHERE id=NEW.id;
  SELECT * INTO op FROM trading_operations WHERE id=o.operation_id;
  SELECT coalesce(sum(quantity),0) INTO filled FROM fills WHERE buy_order_id=o.id OR sell_order_id=o.id;
  IF op.action IS DISTINCT FROM 'place' OR op.owner_id IS DISTINCT FROM o.owner_id OR op.market_id<>o.market_id OR o.id<>op.id OR o.remaining<>o.quantity-filled OR (o.time_in_force='IOC' AND o.status='open') OR (TG_OP='INSERT' AND o.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Invalid order projection'; END IF;
  IF o.side='buy' THEN
    SELECT coalesce(sum(price*remaining),0) INTO needed FROM orders WHERE owner_id=o.owner_id AND side='buy' AND status='open';
    SELECT balance INTO stored FROM ledger_accounts WHERE owner_id=o.owner_id AND kind='reserved';
  ELSE
    SELECT coalesce(sum(remaining),0) INTO needed FROM orders WHERE owner_id=o.owner_id AND market_id=o.market_id AND outcome=o.outcome AND side='sell' AND status='open';
    SELECT reserved INTO stored FROM holdings WHERE owner_id=o.owner_id AND market_id=o.market_id AND outcome=o.outcome;
  END IF;
  IF stored IS NULL OR stored<>needed THEN RAISE EXCEPTION 'Order reservation mismatch'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER order_projection AFTER INSERT OR UPDATE ON orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_order();
--> statement-breakpoint
CREATE FUNCTION verify_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op trading_operations; h holdings; j journals; f fills; b orders; s orders;
BEGIN
  SELECT * INTO op FROM trading_operations WHERE id=NEW.operation_id;
  SELECT * INTO h FROM holdings WHERE id=NEW.holding_id;
  IF op.transaction_id IS DISTINCT FROM txid_current() OR h.market_id<>op.market_id THEN RAISE EXCEPTION 'Invalid share operation'; END IF;
  IF NEW.kind IN ('mint','burn') THEN
    SELECT * INTO j FROM journals WHERE id=NEW.group_id;
    IF j.kind IS DISTINCT FROM NEW.kind OR j.trading_operation_id<>op.id OR h.owner_id<>op.owner_id OR NEW.reserved_delta<>0 OR NEW.available_delta<>(CASE WHEN NEW.kind='mint' THEN j.amount/10000 ELSE -j.amount/10000 END) THEN RAISE EXCEPTION 'Invalid set movement'; END IF;
  ELSIF NEW.kind IN ('reserve','release') THEN
    IF op.action NOT IN ('place','cancel','maintenance') OR NEW.available_delta<>-NEW.reserved_delta OR (NEW.kind='reserve' AND (NEW.reserved_delta<=0 OR h.owner_id<>op.owner_id OR op.action<>'place')) OR (NEW.kind='release' AND NEW.reserved_delta>=0) THEN RAISE EXCEPTION 'Invalid share reservation'; END IF;
  ELSE
    SELECT * INTO f FROM fills WHERE id=NEW.group_id AND operation_id=op.id;
    SELECT * INTO b FROM orders WHERE id=f.buy_order_id;
    SELECT * INTO s FROM orders WHERE id=f.sell_order_id;
    IF f.id IS NULL OR h.outcome<>f.outcome OR NOT ((h.owner_id=b.owner_id AND NEW.available_delta=f.quantity AND NEW.reserved_delta=0) OR (h.owner_id=s.owner_id AND NEW.available_delta=0 AND NEW.reserved_delta=-f.quantity)) THEN RAISE EXCEPTION 'Invalid trade movement'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER movement_guard AFTER INSERT ON share_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_movement();
CREATE FUNCTION verify_fill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b orders; s orders; maker orders; op trading_operations;
BEGIN
  SELECT * INTO b FROM orders WHERE id=NEW.buy_order_id;
  SELECT * INTO s FROM orders WHERE id=NEW.sell_order_id;
  SELECT * INTO maker FROM orders WHERE id=NEW.maker_order_id;
  SELECT * INTO op FROM trading_operations WHERE id=NEW.operation_id;
  IF op.action IS DISTINCT FROM 'place' OR op.transaction_id<>txid_current() OR op.market_id<>NEW.market_id OR b.owner_id=s.owner_id OR b.side<>'buy' OR s.side<>'sell'
    OR b.market_id<>NEW.market_id OR s.market_id<>NEW.market_id OR b.outcome<>NEW.outcome OR s.outcome<>NEW.outcome
    OR maker.id NOT IN (b.id,s.id) OR NEW.price<>maker.price OR NEW.price>b.price OR NEW.price<s.price
    OR maker.sequence>=greatest(b.sequence,s.sequence) OR op.id<>(CASE WHEN maker.id=b.id THEN s.id ELSE b.id END)
    OR op.owner_id<>(CASE WHEN maker.id=b.id THEN s.owner_id ELSE b.owner_id END)
    OR b.remaining<>b.quantity-(SELECT coalesce(sum(quantity),0) FROM fills WHERE buy_order_id=b.id)
    OR s.remaining<>s.quantity-(SELECT coalesce(sum(quantity),0) FROM fills WHERE sell_order_id=s.id)
    OR EXISTS (SELECT 1 FROM users WHERE id IN (b.owner_id,s.owner_id) AND suspended)
    OR b.expires_at<=clock_timestamp() OR s.expires_at<=clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM journals WHERE id=NEW.id AND kind='trade' AND trading_operation_id=op.id)
    OR (SELECT count(*) FROM share_movements WHERE group_id=NEW.id AND kind='trade')<>2
  THEN RAISE EXCEPTION 'Invalid fill'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER fill_guard AFTER INSERT ON fills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_fill();
CREATE FUNCTION verify_trading_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.transaction_id<>txid_current() THEN RAISE EXCEPTION 'Invalid operation transaction'; END IF;
  IF NEW.action IN ('mint','burn','place') AND (NEW.owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.owner_id AND NOT suspended) OR NOT EXISTS (SELECT 1 FROM markets WHERE id=NEW.market_id AND status='open' AND NOT paused AND closes_at>clock_timestamp())) THEN RAISE EXCEPTION 'Trading unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM journals WHERE trading_operation_id=NEW.id AND NOT ((NEW.action IN ('mint','burn') AND kind=NEW.action) OR (NEW.action='place' AND kind IN ('reserve','release','trade')) OR (NEW.action IN ('cancel','maintenance') AND kind='release'))) THEN RAISE EXCEPTION 'Invalid operation journals'; END IF;
  IF NEW.action IN ('mint','burn') AND (SELECT count(*) FROM journals WHERE trading_operation_id=NEW.id)<>1 THEN RAISE EXCEPTION 'Missing set journal'; END IF;
  IF EXISTS (SELECT 1 FROM share_movements WHERE operation_id=NEW.id AND NOT ((NEW.action IN ('mint','burn') AND kind=NEW.action) OR (NEW.action='place' AND kind IN ('reserve','release','trade')) OR (NEW.action IN ('cancel','maintenance') AND kind='release'))) THEN RAISE EXCEPTION 'Invalid operation movements'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER trading_operation_guard AFTER INSERT ON trading_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_trading_operation();

--> statement-breakpoint
CREATE UNIQUE INDEX "movement_group_holding_unique" ON "share_movements" USING btree ("group_id","holding_id");--> statement-breakpoint
CREATE FUNCTION verify_outbox_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trading_operations WHERE id=NEW.operation_id AND market_id=NEW.market_id AND transaction_id=txid_current()) THEN RAISE EXCEPTION 'Invalid outbox operation'; END IF;
  IF NEW.owner_id IS NULL AND NOT ((NEW.event='market.changed' AND NEW.payload='{}'::jsonb) OR (NEW.event='trade.executed' AND NEW.payload ?& ARRAY['price','quantity','outcome'] AND (SELECT count(*) FROM jsonb_object_keys(NEW.payload))=3)) THEN RAISE EXCEPTION 'Invalid public event'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER outbox_operation_guard AFTER INSERT ON trading_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_outbox_operation();
CREATE FUNCTION verify_closed_orders() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='markets' THEN
    IF EXISTS (SELECT 1 FROM markets m JOIN orders o ON o.market_id=m.id WHERE m.id=NEW.id AND m.status<>'open' AND o.status='open') THEN RAISE EXCEPTION 'Closed market reservations remain'; END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM users u JOIN orders o ON o.owner_id=u.id WHERE u.id=NEW.id AND u.suspended AND o.status='open') THEN RAISE EXCEPTION 'Suspended account reservations remain'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER market_order_lifecycle AFTER UPDATE ON markets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_closed_orders();
CREATE CONSTRAINT TRIGGER suspended_order_lifecycle AFTER UPDATE ON users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_closed_orders();

--> statement-breakpoint
CREATE INDEX "fill_buy_order_index" ON "fills" USING btree ("buy_order_id");--> statement-breakpoint
CREATE INDEX "fill_sell_order_index" ON "fills" USING btree ("sell_order_id");--> statement-breakpoint
CREATE INDEX "holding_market_index" ON "holdings" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "journal_trading_operation_index" ON "journals" USING btree ("trading_operation_id");--> statement-breakpoint
CREATE INDEX "movement_operation_index" ON "share_movements" USING btree ("operation_id");