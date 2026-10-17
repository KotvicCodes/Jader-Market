ALTER TYPE "public"."market_status" ADD VALUE 'settling' BEFORE 'proposed';--> statement-breakpoint
CREATE TABLE "market_payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resolution_id" uuid NOT NULL,
	"holding_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"quantity" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"journal_id" uuid,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "market_payouts_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"transaction_id" bigint DEFAULT txid_current() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_payouts_journal_id_unique" UNIQUE("journal_id"),
	CONSTRAINT "payout_valid" CHECK ("market_payouts"."quantity" BETWEEN 1 AND 1000000 AND "market_payouts"."amount" BETWEEN 0 AND 10000000000 AND (("market_payouts"."amount" = 0) = ("market_payouts"."journal_id" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "market_resolutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"market_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"result" text NOT NULL,
	"evidence" text NOT NULL,
	"request_hash" text NOT NULL,
	"transaction_id" bigint DEFAULT txid_current() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_resolutions_market_id_unique" UNIQUE("market_id"),
	CONSTRAINT "resolution_valid" CHECK ("market_resolutions"."result" IN ('YES', 'NO', 'invalid') AND length(trim("market_resolutions"."evidence")) BETWEEN 20 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "journals" DROP CONSTRAINT "journal_kind_valid";--> statement-breakpoint
ALTER TABLE "market_audit" DROP CONSTRAINT "market_audit_action_valid";--> statement-breakpoint
ALTER TABLE "share_movements" DROP CONSTRAINT "movement_valid";--> statement-breakpoint
ALTER TABLE "trading_operations" DROP CONSTRAINT "trading_action_valid";--> statement-breakpoint
ALTER TABLE "market_payouts" ADD CONSTRAINT "market_payouts_resolution_id_market_resolutions_id_fk" FOREIGN KEY ("resolution_id") REFERENCES "public"."market_resolutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_payouts" ADD CONSTRAINT "market_payouts_holding_id_holdings_id_fk" FOREIGN KEY ("holding_id") REFERENCES "public"."holdings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_payouts" ADD CONSTRAINT "market_payouts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_payouts" ADD CONSTRAINT "market_payouts_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_resolutions" ADD CONSTRAINT "market_resolutions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_resolutions" ADD CONSTRAINT "market_resolutions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payout_owner_sequence_index" ON "market_payouts" USING btree ("owner_id","sequence");--> statement-breakpoint
CREATE INDEX "payout_resolution_index" ON "market_payouts" USING btree ("resolution_id");--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journal_kind_valid" CHECK ("journals"."kind" IN ('credit', 'debit', 'mint', 'burn', 'reserve', 'release', 'trade', 'payout'));--> statement-breakpoint
ALTER TABLE "market_audit" ADD CONSTRAINT "market_audit_action_valid" CHECK ("market_audit"."action" IN ('create', 'edit', 'publish', 'pause', 'resume', 'close', 'resolve'));--> statement-breakpoint
ALTER TABLE "share_movements" ADD CONSTRAINT "movement_valid" CHECK ("share_movements"."kind" IN ('mint', 'burn', 'reserve', 'release', 'trade', 'payout') AND ("share_movements"."available_delta" <> 0 OR "share_movements"."reserved_delta" <> 0));--> statement-breakpoint
ALTER TABLE "trading_operations" ADD CONSTRAINT "trading_action_valid" CHECK ("trading_operations"."action" IN ('mint', 'burn', 'place', 'cancel', 'maintenance', 'settle'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_market_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN RAISE EXCEPTION 'Published market cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Market identity or revision cannot be changed';
  END IF;
  IF OLD.published_at IS NOT NULL AND ROW(NEW.slug, NEW.question, NEW.description, NEW.category, NEW.resolution_rules, NEW.resolution_source, NEW.closes_at, NEW.published_at, NEW.synthetic)
      IS DISTINCT FROM ROW(OLD.slug, OLD.question, OLD.description, OLD.category, OLD.resolution_rules, OLD.resolution_source, OLD.closes_at, OLD.published_at, OLD.synthetic) THEN
    RAISE EXCEPTION 'Published market terms are immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status = 'open') OR (OLD.status = 'open' AND NEW.status = 'closed') OR
    (OLD.status = 'closed' AND NEW.status::text = 'settling' AND EXISTS (SELECT 1 FROM market_resolutions WHERE market_id=NEW.id AND transaction_id=txid_current())) OR
    (OLD.status::text = 'settling' AND NEW.status::text IN ('resolved','void'))) THEN
    RAISE EXCEPTION 'Invalid market transition';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'open' AND NEW.closes_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Publication deadline has passed';
  END IF;
  IF NEW.paused IS DISTINCT FROM OLD.paused AND NEW.status = 'open' AND NEW.closes_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Market deadline has passed';
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION verify_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op trading_operations; n integer; total numeric; src uuid; dst uuid; f fills; b orders; s orders; expected bigint; p market_payouts; r market_resolutions;
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
  ELSIF NEW.kind='payout' THEN
    SELECT * INTO p FROM market_payouts WHERE journal_id=NEW.id AND id=op.id;
    SELECT * INTO r FROM market_resolutions WHERE id=p.resolution_id;
    IF p.id IS NULL OR op.action<>'settle' OR op.market_id<>r.market_id OR op.owner_id IS DISTINCT FROM r.actor_id
      OR NEW.actor_id<>r.actor_id OR NEW.recipient_id<>p.owner_id OR NEW.amount<>p.amount THEN RAISE EXCEPTION 'Invalid payout journal'; END IF;
    SELECT id INTO src FROM ledger_accounts WHERE market_id=r.market_id AND kind='escrow';
    SELECT id INTO dst FROM ledger_accounts WHERE owner_id=p.owner_id AND kind='wallet';
    expected := NEW.amount;
  ELSE RAISE EXCEPTION 'Unknown journal'; END IF;
  IF src IS NULL OR dst IS NULL OR NOT EXISTS (SELECT 1 FROM ledger_entries WHERE journal_id=NEW.id AND account_id=src AND delta=-expected)
    OR NOT EXISTS (SELECT 1 FROM ledger_entries WHERE journal_id=NEW.id AND account_id=dst AND delta=expected) THEN RAISE EXCEPTION 'Invalid journal accounts'; END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION verify_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op trading_operations; h holdings; j journals; f fills; b orders; s orders; p market_payouts;
BEGIN
  SELECT * INTO op FROM trading_operations WHERE id=NEW.operation_id;
  SELECT * INTO h FROM holdings WHERE id=NEW.holding_id;
  IF op.transaction_id IS DISTINCT FROM txid_current() OR h.market_id<>op.market_id THEN RAISE EXCEPTION 'Invalid share operation'; END IF;
  IF NEW.kind IN ('mint','burn') THEN
    SELECT * INTO j FROM journals WHERE id=NEW.group_id;
    IF j.kind IS DISTINCT FROM NEW.kind OR j.trading_operation_id<>op.id OR h.owner_id<>op.owner_id OR NEW.reserved_delta<>0 OR NEW.available_delta<>(CASE WHEN NEW.kind='mint' THEN j.amount/10000 ELSE -j.amount/10000 END) THEN RAISE EXCEPTION 'Invalid set movement'; END IF;
  ELSIF NEW.kind IN ('reserve','release') THEN
    IF op.action NOT IN ('place','cancel','maintenance') OR NEW.available_delta<>-NEW.reserved_delta OR (NEW.kind='reserve' AND (NEW.reserved_delta<=0 OR h.owner_id<>op.owner_id OR op.action<>'place')) OR (NEW.kind='release' AND NEW.reserved_delta>=0) THEN RAISE EXCEPTION 'Invalid share reservation'; END IF;
  ELSIF NEW.kind='payout' THEN
    SELECT * INTO p FROM market_payouts WHERE id=op.id AND id=NEW.group_id AND holding_id=h.id;
    IF op.action<>'settle' OR p.id IS NULL OR NEW.available_delta<>-p.quantity OR NEW.reserved_delta<>0 THEN RAISE EXCEPTION 'Invalid payout movement'; END IF;
  ELSE
    SELECT * INTO f FROM fills WHERE id=NEW.group_id AND operation_id=op.id;
    SELECT * INTO b FROM orders WHERE id=f.buy_order_id;
    SELECT * INTO s FROM orders WHERE id=f.sell_order_id;
    IF f.id IS NULL OR h.outcome<>f.outcome OR NOT ((h.owner_id=b.owner_id AND NEW.available_delta=f.quantity AND NEW.reserved_delta=0) OR (h.owner_id=s.owner_id AND NEW.available_delta=0 AND NEW.reserved_delta=-f.quantity)) THEN RAISE EXCEPTION 'Invalid trade movement'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION verify_trading_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.transaction_id<>txid_current() THEN RAISE EXCEPTION 'Invalid operation transaction'; END IF;
  IF NEW.action IN ('mint','burn','place') AND (NEW.owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.owner_id AND NOT suspended) OR NOT EXISTS (SELECT 1 FROM markets WHERE id=NEW.market_id AND status='open' AND NOT paused AND closes_at>clock_timestamp())) THEN RAISE EXCEPTION 'Trading unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM journals WHERE trading_operation_id=NEW.id AND NOT ((NEW.action IN ('mint','burn') AND kind=NEW.action) OR (NEW.action='place' AND kind IN ('reserve','release','trade')) OR (NEW.action IN ('cancel','maintenance') AND kind='release') OR (NEW.action='settle' AND kind='payout'))) THEN RAISE EXCEPTION 'Invalid operation journals'; END IF;
  IF NEW.action IN ('mint','burn') AND (SELECT count(*) FROM journals WHERE trading_operation_id=NEW.id)<>1 THEN RAISE EXCEPTION 'Missing set journal'; END IF;
  IF EXISTS (SELECT 1 FROM share_movements WHERE operation_id=NEW.id AND NOT ((NEW.action IN ('mint','burn') AND kind=NEW.action) OR (NEW.action='place' AND kind IN ('reserve','release','trade')) OR (NEW.action IN ('cancel','maintenance') AND kind='release') OR (NEW.action='settle' AND kind='payout'))) THEN RAISE EXCEPTION 'Invalid operation movements'; END IF;
  IF NEW.action='settle' AND (NOT EXISTS (SELECT 1 FROM market_payouts p JOIN market_resolutions r ON r.id=p.resolution_id
      WHERE p.id=NEW.id AND r.market_id=NEW.market_id AND NEW.owner_id=r.actor_id AND p.transaction_id=txid_current())
      OR (SELECT count(*) FROM share_movements WHERE operation_id=NEW.id)<>1
      OR (SELECT count(*) FROM journals WHERE trading_operation_id=NEW.id)<>(SELECT CASE WHEN amount=0 THEN 0 ELSE 1 END FROM market_payouts WHERE id=NEW.id)) THEN
    RAISE EXCEPTION 'Invalid settlement operation'; END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION verify_trading_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a ledger_accounts; needed numeric; yes_supply numeric; no_supply numeric; result text;
BEGIN
  SELECT * INTO a FROM ledger_accounts WHERE id=NEW.id;
  IF a.kind='reserved' THEN
    SELECT coalesce(sum(price*remaining),0) INTO needed FROM orders WHERE owner_id=a.owner_id AND side='buy' AND status='open';
    IF a.balance<>needed THEN RAISE EXCEPTION 'Credit reservation mismatch'; END IF;
  ELSIF a.kind='escrow' THEN
    SELECT coalesce(sum(available+reserved) FILTER (WHERE outcome='YES'),0),coalesce(sum(available+reserved) FILTER (WHERE outcome='NO'),0) INTO yes_supply,no_supply FROM holdings WHERE market_id=a.market_id;
    SELECT r.result INTO result FROM market_resolutions r WHERE r.market_id=a.market_id;
    IF result IS NULL THEN
      IF yes_supply<>no_supply OR a.balance<>yes_supply*10000 THEN RAISE EXCEPTION 'Collateral mismatch'; END IF;
    ELSIF a.balance<>(CASE WHEN result='YES' THEN yes_supply*10000 WHEN result='NO' THEN no_supply*10000 ELSE (yes_supply+no_supply)*5000 END) THEN RAISE EXCEPTION 'Settlement collateral mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
ALTER TABLE market_payouts ADD CONSTRAINT payout_operation_fk FOREIGN KEY (id) REFERENCES trading_operations(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER resolutions_immutable BEFORE UPDATE OR DELETE ON market_resolutions FOR EACH ROW EXECUTE FUNCTION reject_record_change();
CREATE TRIGGER payouts_immutable BEFORE UPDATE OR DELETE ON market_payouts FOR EACH ROW EXECUTE FUNCTION reject_record_change();
CREATE FUNCTION verify_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.transaction_id<>txid_current()
    OR NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_id AND role='admin' AND NOT suspended)
    OR NOT EXISTS (SELECT 1 FROM markets WHERE id=NEW.market_id AND status::text='settling')
    OR NOT EXISTS (SELECT 1 FROM market_audit WHERE operation_key=NEW.id AND market_id=NEW.market_id AND actor_id=NEW.actor_id AND action='resolve' AND request_hash=NEW.request_hash)
    OR EXISTS (SELECT 1 FROM orders WHERE market_id=NEW.market_id AND status='open') THEN RAISE EXCEPTION 'Invalid resolution'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER resolution_guard AFTER INSERT ON market_resolutions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_resolution();
CREATE FUNCTION verify_payout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r market_resolutions; h holdings; op trading_operations; rate integer;
BEGIN
  SELECT * INTO r FROM market_resolutions WHERE id=NEW.resolution_id;
  SELECT * INTO h FROM holdings WHERE id=NEW.holding_id;
  SELECT * INTO op FROM trading_operations WHERE id=NEW.id;
  rate:=CASE WHEN r.result='invalid' THEN 5000 WHEN r.result=h.outcome THEN 10000 ELSE 0 END;
  IF NEW.transaction_id<>txid_current() OR op.transaction_id IS DISTINCT FROM txid_current()
    OR op.action IS DISTINCT FROM 'settle' OR op.market_id<>r.market_id OR op.owner_id IS DISTINCT FROM r.actor_id
    OR h.market_id<>r.market_id OR NEW.owner_id<>h.owner_id OR NEW.amount<>NEW.quantity*rate
    OR NOT EXISTS (SELECT 1 FROM markets WHERE id=r.market_id AND status::text IN ('settling','resolved','void'))
    OR EXISTS (SELECT 1 FROM orders WHERE market_id=r.market_id AND status='open')
    OR (SELECT count(*) FROM share_movements WHERE operation_id=NEW.id AND group_id=NEW.id AND holding_id=h.id AND kind='payout' AND available_delta=-NEW.quantity AND reserved_delta=0)<>1
    OR (NEW.amount>0 AND NOT EXISTS (SELECT 1 FROM journals WHERE id=NEW.journal_id AND kind='payout' AND trading_operation_id=NEW.id AND amount=NEW.amount))
    THEN RAISE EXCEPTION 'Invalid payout receipt'; END IF;
  -- Check collateral even for zero-value losing shares (no ledger update).
  IF EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.market_id=r.market_id AND a.kind='escrow' AND a.balance<>(
    SELECT coalesce(sum((available+reserved)*(CASE WHEN r.result='invalid' THEN 5000 WHEN r.result=outcome THEN 10000 ELSE 0 END)),0) FROM holdings WHERE market_id=r.market_id
  )) THEN RAISE EXCEPTION 'Payout collateral mismatch'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER payout_guard AFTER INSERT ON market_payouts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_payout();
CREATE FUNCTION verify_settlement_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m markets; r market_resolutions;
BEGIN
  SELECT * INTO m FROM markets WHERE id=NEW.id;
  SELECT * INTO r FROM market_resolutions WHERE market_id=m.id;
  IF TG_OP='INSERT' AND NEW.status::text IN ('settling','resolved','void') THEN RAISE EXCEPTION 'Resolution requires closed market'; END IF;
  IF r.id IS NOT NULL AND m.status::text NOT IN ('settling','resolved','void') THEN RAISE EXCEPTION 'Resolution lifecycle mismatch'; END IF;
  IF m.status::text IN ('settling','resolved','void') AND r.id IS NULL THEN RAISE EXCEPTION 'Missing resolution'; END IF;
  IF m.status::text IN ('resolved','void') AND (
    m.status::text<>(CASE WHEN r.result='invalid' THEN 'void' ELSE 'resolved' END)
    OR EXISTS (SELECT 1 FROM holdings WHERE market_id=m.id AND (available<>0 OR reserved<>0))
    OR EXISTS (SELECT 1 FROM ledger_accounts WHERE market_id=m.id AND kind='escrow' AND balance<>0)
    OR EXISTS (SELECT 1 FROM orders WHERE market_id=m.id AND status='open')) THEN RAISE EXCEPTION 'Unfinished settlement'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER settlement_lifecycle_guard AFTER INSERT OR UPDATE ON markets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_settlement_lifecycle();
