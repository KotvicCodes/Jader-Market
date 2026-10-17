CREATE TABLE "market_deadline_events" (
	"market_id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trading_outbox" ALTER COLUMN "operation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_outbox" ALTER COLUMN "market_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_outbox" ADD COLUMN "journal_id" uuid;--> statement-breakpoint
ALTER TABLE "market_deadline_events" ADD CONSTRAINT "market_deadline_events_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_deadline_events" ADD CONSTRAINT "market_deadline_events_operation_id_trading_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."trading_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_outbox" ADD CONSTRAINT "trading_outbox_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_outbox" ADD CONSTRAINT "outbox_source_valid" CHECK (("trading_outbox"."operation_id" IS NOT NULL) <> ("trading_outbox"."journal_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE market_deadline_events ALTER CONSTRAINT market_deadline_events_operation_id_trading_operations_id_fk DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER deadline_events_immutable BEFORE UPDATE OR DELETE ON market_deadline_events FOR EACH ROW EXECUTE FUNCTION reject_record_change();
CREATE FUNCTION verify_deadline_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM markets m JOIN trading_operations o ON o.market_id=m.id
    WHERE m.id=NEW.market_id AND m.status='open' AND m.closes_at<=clock_timestamp()
      AND o.id=NEW.operation_id AND o.action='maintenance' AND o.transaction_id=txid_current()) THEN
    RAISE EXCEPTION 'Invalid deadline event';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER deadline_event_guard AFTER INSERT ON market_deadline_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_deadline_event();
CREATE FUNCTION reject_synthetic_trading() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Legacy complete sets can still return their collateral; never add supply or orders.
  IF NEW.action IN ('mint','place') AND EXISTS (SELECT 1 FROM markets WHERE id=NEW.market_id AND synthetic='yes') THEN
    RAISE EXCEPTION 'Synthetic browsing market is not tradable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER synthetic_trading_guard AFTER INSERT ON trading_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_synthetic_trading();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION verify_outbox_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j journals;
BEGIN
  IF NEW.journal_id IS NOT NULL THEN
    SELECT * INTO j FROM journals WHERE id=NEW.journal_id;
    IF NEW.operation_id IS NOT NULL OR NEW.market_id IS NOT NULL OR j.transaction_id IS DISTINCT FROM txid_current()
      OR j.kind NOT IN ('credit','debit') OR NEW.owner_id IS DISTINCT FROM j.recipient_id
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
