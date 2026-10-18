CREATE TABLE "withdrawal_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"withdrawal_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"request_hash" text NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"response" jsonb NOT NULL,
	"transaction_id" bigint DEFAULT txid_current() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "withdrawal_operations_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_operation_valid" CHECK ("withdrawal_operations"."action" IN ('request', 'start', 'pay', 'cancel', 'release') AND length("withdrawal_operations"."note") <= 400 AND length("withdrawal_operations"."reference") <= 120)
);
--> statement-breakpoint
CREATE TABLE "withdrawals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" text NOT NULL,
	"last_operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawals_last_operation_id_unique" UNIQUE("last_operation_id"),
	CONSTRAINT "withdrawal_valid" CHECK ("withdrawals"."amount" BETWEEN 1 AND 10000000000 AND "withdrawals"."status" IN ('requested', 'processing', 'paid', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "journals" DROP CONSTRAINT "journal_reason_valid";--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_account_kind_valid";--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_owner_valid";--> statement-breakpoint
ALTER TABLE "journals" ADD COLUMN "withdrawal_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "withdrawal_operations" ADD CONSTRAINT "withdrawal_operations_withdrawal_id_withdrawals_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."withdrawals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_operations" ADD CONSTRAINT "withdrawal_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "withdrawal_operation_history_index" ON "withdrawal_operations" USING btree ("withdrawal_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "withdrawal_payment_reference_unique" ON "withdrawal_operations" USING btree ("reference") WHERE "withdrawal_operations"."action" = 'pay';--> statement-breakpoint
CREATE INDEX "withdrawal_owner_index" ON "withdrawals" USING btree ("owner_id","created_at","id");--> statement-breakpoint
CREATE INDEX "withdrawal_queue_index" ON "withdrawals" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_withdrawal_operation_unique" ON "journals" USING btree ("withdrawal_operation_id");--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journal_operation_source" CHECK ("journals"."trading_operation_id" IS NULL OR "journals"."withdrawal_operation_id" IS NULL);--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journal_reason_valid" CHECK ("journals"."reason" IN ('demo_grant', 'offline_credit', 'offline_debit', 'correction', 'trading', 'withdrawal'));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_account_kind_valid" CHECK ("ledger_accounts"."kind" IN ('issuance', 'wallet', 'reserved', 'withdrawal_reserved', 'escrow'));--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_owner_valid" CHECK (("ledger_accounts"."kind" = 'issuance' AND "ledger_accounts"."owner_id" IS NULL AND "ledger_accounts"."market_id" IS NULL) OR ("ledger_accounts"."kind" = 'escrow' AND "ledger_accounts"."owner_id" IS NULL AND "ledger_accounts"."market_id" IS NOT NULL) OR ("ledger_accounts"."kind" IN ('wallet', 'reserved', 'withdrawal_reserved') AND "ledger_accounts"."owner_id" IS NOT NULL AND "ledger_accounts"."market_id" IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION verify_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op trading_operations; n integer; total numeric; src uuid; dst uuid; f fills; b orders; s orders; expected bigint; p market_payouts; r market_resolutions;
BEGIN
  IF NEW.withdrawal_operation_id IS NOT NULL THEN RETURN NEW; END IF;
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
CREATE OR REPLACE FUNCTION verify_admin_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_count integer; total numeric; expected bigint;
BEGIN
  IF NEW.withdrawal_operation_id IS NOT NULL THEN RETURN NEW; END IF;
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION verify_outbox_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j journals;
BEGIN
  IF NEW.journal_id IS NOT NULL THEN
    SELECT * INTO j FROM journals WHERE id=NEW.journal_id;
    IF NEW.operation_id IS NOT NULL OR NEW.market_id IS NOT NULL OR j.transaction_id IS DISTINCT FROM txid_current()
      OR NOT (j.kind IN ('credit','debit') OR (j.withdrawal_operation_id IS NOT NULL AND j.kind IN ('reserve','release'))) OR NEW.owner_id IS DISTINCT FROM j.recipient_id
      OR NEW.event<>'portfolio.changed' OR NEW.payload<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid credit event'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.market_id IS NULL OR NOT EXISTS (SELECT 1 FROM trading_operations WHERE id=NEW.operation_id AND market_id=NEW.market_id AND transaction_id=txid_current()) THEN RAISE EXCEPTION 'Invalid outbox operation'; END IF;
  IF NEW.owner_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM markets WHERE id=NEW.market_id AND status='draft') OR NOT (
      (NEW.event='market.changed' AND NEW.payload='{}'::jsonb) OR
      (NEW.event='trade.executed' AND NEW.payload ?& ARRAY['price','quantity','outcome'] AND (SELECT count(*) FROM jsonb_object_keys(NEW.payload))=3)
    ) THEN RAISE EXCEPTION 'Invalid public event'; END IF;
  ELSIF NEW.event='market.admin.changed' THEN
    IF NEW.payload<>'{}'::jsonb OR NOT EXISTS (SELECT 1 FROM users u JOIN trading_operations o ON o.owner_id=u.id WHERE u.id=NEW.owner_id AND u.role='admin' AND NOT u.suspended AND o.id=NEW.operation_id) THEN RAISE EXCEPTION 'Invalid administrator event'; END IF;
  ELSIF NEW.event='portfolio.changed' THEN
    IF NEW.payload<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid portfolio event'; END IF;
  ELSIF NEW.event='order.changed' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(NEW.payload))<>1 OR NOT EXISTS (SELECT 1 FROM orders WHERE id::text=NEW.payload->>'orderId' AND owner_id=NEW.owner_id AND market_id=NEW.market_id) THEN RAISE EXCEPTION 'Invalid private order event'; END IF;
  ELSE RAISE EXCEPTION 'Unknown private event'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Operation history and accounting are committed together; old journals stay intact.
ALTER TABLE journals ADD CONSTRAINT journal_withdrawal_operation_fk FOREIGN KEY (withdrawal_operation_id) REFERENCES withdrawal_operations(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE withdrawals ADD CONSTRAINT withdrawal_last_operation_fk FOREIGN KEY (last_operation_id) REFERENCES withdrawal_operations(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER withdrawal_operations_immutable BEFORE UPDATE OR DELETE ON withdrawal_operations FOR EACH ROW EXECUTE FUNCTION reject_record_change();
CREATE FUNCTION preserve_withdrawal_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable withdrawal history'; END IF;
  IF ROW(NEW.id,NEW.owner_id,NEW.amount,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.owner_id,OLD.amount,OLD.created_at)
    OR OLD.status IN ('paid','cancelled') OR NEW.last_operation_id=OLD.last_operation_id THEN RAISE EXCEPTION 'Invalid withdrawal change'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER withdrawal_identity BEFORE UPDATE OR DELETE ON withdrawals FOR EACH ROW EXECUTE FUNCTION preserve_withdrawal_identity();
--> statement-breakpoint
CREATE FUNCTION verify_withdrawal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op withdrawal_operations;
BEGIN
  SELECT * INTO op FROM withdrawal_operations WHERE id=NEW.last_operation_id;
  IF op.transaction_id IS DISTINCT FROM txid_current() OR op.withdrawal_id IS DISTINCT FROM NEW.id OR op.to_status IS DISTINCT FROM NEW.status
    OR (TG_OP='INSERT' AND (op.action<>'request' OR op.from_status IS NOT NULL OR NEW.status<>'requested' OR op.id<>NEW.id)) THEN RAISE EXCEPTION 'Invalid withdrawal transition'; END IF;
  IF TG_OP='UPDATE' AND (op.from_status IS DISTINCT FROM OLD.status OR NOT (
    (OLD.status='requested' AND NEW.status='processing' AND op.action='start') OR
    (OLD.status='requested' AND NEW.status='cancelled' AND op.action='cancel') OR
    (OLD.status='processing' AND NEW.status='paid' AND op.action='pay') OR
    (OLD.status='processing' AND NEW.status='cancelled' AND op.action='release')
  )) THEN RAISE EXCEPTION 'Invalid withdrawal transition'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER withdrawal_transition_guard AFTER INSERT OR UPDATE ON withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_withdrawal_transition();
--> statement-breakpoint
CREATE FUNCTION verify_withdrawal_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w withdrawals; actor users; expected_journals integer;
BEGIN
  SELECT * INTO w FROM withdrawals WHERE id=NEW.withdrawal_id;
  SELECT * INTO actor FROM users WHERE id=NEW.actor_id;
  expected_journals:=CASE WHEN NEW.action='start' THEN 0 ELSE 1 END;
  IF NEW.transaction_id<>txid_current() OR w.last_operation_id IS DISTINCT FROM NEW.id OR w.status IS DISTINCT FROM NEW.to_status
    OR actor.id IS NULL OR actor.suspended
    OR (NEW.action='request' AND NEW.actor_id<>w.owner_id)
    OR (NEW.action IN ('start','pay','release') AND actor.role<>'admin')
    OR (NEW.action='cancel' AND NEW.actor_id<>w.owner_id AND actor.role<>'admin')
    OR (NEW.action='pay' AND (length(trim(NEW.reference))<3 OR NEW.reference<>trim(NEW.reference)))
    OR (NEW.action<>'pay' AND NEW.reference<>'')
    OR (NEW.action IN ('cancel','release') AND length(trim(NEW.note))<20)
    OR (NEW.action NOT IN ('cancel','release') AND NEW.note<>'')
    OR (SELECT count(*) FROM withdrawal_operations WHERE withdrawal_id=w.id AND transaction_id=txid_current())<>1
    OR (SELECT count(*) FROM journals WHERE withdrawal_operation_id=NEW.id)<>expected_journals
    OR NEW.response IS DISTINCT FROM jsonb_build_object('id',w.id::text,'status',w.status,'amount',w.amount::text,'lastOperationId',NEW.id::text)
    OR (NEW.action='request' AND (SELECT count(*) FROM withdrawals WHERE owner_id=w.owner_id AND status IN ('requested','processing'))>20)
  THEN RAISE EXCEPTION 'Invalid withdrawal operation'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER withdrawal_operation_guard AFTER INSERT ON withdrawal_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_withdrawal_operation();
--> statement-breakpoint
CREATE FUNCTION verify_withdrawal_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op withdrawal_operations; w withdrawals; src uuid; dst uuid; n integer; total numeric;
BEGIN
  IF NEW.withdrawal_operation_id IS NULL THEN
    IF NEW.reason IN ('withdrawal','offline_debit') THEN RAISE EXCEPTION 'Offline debit requires a reserved withdrawal'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO op FROM withdrawal_operations WHERE id=NEW.withdrawal_operation_id;
  SELECT * INTO w FROM withdrawals WHERE id=op.withdrawal_id;
  SELECT count(*),coalesce(sum(delta),0) INTO n,total FROM ledger_entries WHERE journal_id=NEW.id;
  IF op.transaction_id IS DISTINCT FROM txid_current() OR NEW.transaction_id<>txid_current() OR NEW.trading_operation_id IS NOT NULL
    OR NEW.reason<>'withdrawal' OR NEW.actor_id<>op.actor_id OR NEW.recipient_id<>w.owner_id OR NEW.amount<>w.amount
    OR NEW.request_hash<>op.request_hash OR NEW.operation_key<>op.id OR n<>2 OR total<>0
    OR NOT ((op.action='request' AND NEW.kind='reserve') OR (op.action IN ('cancel','release') AND NEW.kind='release') OR (op.action='pay' AND NEW.kind='debit'))
  THEN RAISE EXCEPTION 'Invalid withdrawal journal'; END IF;
  SELECT id INTO src FROM ledger_accounts WHERE owner_id=w.owner_id AND kind=CASE WHEN op.action='request' THEN 'wallet' ELSE 'withdrawal_reserved' END;
  IF op.action='pay' THEN SELECT id INTO dst FROM ledger_accounts WHERE kind='issuance';
  ELSE SELECT id INTO dst FROM ledger_accounts WHERE owner_id=w.owner_id AND kind=CASE WHEN op.action='request' THEN 'withdrawal_reserved' ELSE 'wallet' END;
  END IF;
  IF src IS NULL OR dst IS NULL OR NOT EXISTS (SELECT 1 FROM ledger_entries WHERE journal_id=NEW.id AND account_id=src AND delta=-w.amount)
    OR NOT EXISTS (SELECT 1 FROM ledger_entries WHERE journal_id=NEW.id AND account_id=dst AND delta=w.amount) THEN RAISE EXCEPTION 'Invalid withdrawal accounts'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER withdrawal_journal_guard AFTER INSERT ON journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_withdrawal_journal();
--> statement-breakpoint
CREATE FUNCTION verify_withdrawal_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid; held numeric; needed numeric;
BEGIN
  IF TG_TABLE_NAME='ledger_accounts' THEN
    IF NEW.kind<>'withdrawal_reserved' THEN RETURN NEW; END IF;
    owner:=NEW.owner_id;
  ELSE owner:=NEW.owner_id;
  END IF;
  SELECT balance INTO held FROM ledger_accounts WHERE owner_id=owner AND kind='withdrawal_reserved';
  SELECT coalesce(sum(amount),0) INTO needed FROM withdrawals WHERE owner_id=owner AND status IN ('requested','processing');
  IF held IS DISTINCT FROM needed THEN RAISE EXCEPTION 'Withdrawal reservation mismatch'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER withdrawal_account_guard AFTER INSERT OR UPDATE ON ledger_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_withdrawal_balance();
CREATE CONSTRAINT TRIGGER withdrawal_balance_guard AFTER INSERT OR UPDATE ON withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_withdrawal_balance();
