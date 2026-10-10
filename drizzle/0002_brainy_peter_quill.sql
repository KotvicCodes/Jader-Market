CREATE TABLE "market_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"operation_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"action" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_audit_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "market_audit_action_valid" CHECK ("market_audit"."action" IN ('create', 'edit', 'publish', 'pause', 'resume', 'close'))
);
--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "market_audit" ADD CONSTRAINT "market_audit_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_audit" ADD CONSTRAINT "market_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "market_audit_history_index" ON "market_audit" USING btree ("market_id","created_at");--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "market_pause_valid" CHECK (NOT "markets"."paused" OR "markets"."status" = 'open');--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "market_revision_valid" CHECK ("markets"."revision" >= 0);
--> statement-breakpoint
CREATE TRIGGER market_audit_immutable BEFORE UPDATE OR DELETE ON market_audit FOR EACH ROW EXECUTE FUNCTION reject_record_change();
--> statement-breakpoint
CREATE FUNCTION guard_market_terms() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status = 'open') OR (OLD.status = 'open' AND NEW.status = 'closed')) THEN
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
CREATE TRIGGER market_terms_guard BEFORE UPDATE OR DELETE ON markets FOR EACH ROW EXECUTE FUNCTION guard_market_terms();
