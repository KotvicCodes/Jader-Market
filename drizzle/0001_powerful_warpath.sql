CREATE TABLE "admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"amount" bigint NOT NULL,
	"transaction_id" bigint DEFAULT txid_current() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journals_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "journal_kind_valid" CHECK ("journals"."kind" IN ('credit', 'debit')),
	CONSTRAINT "journal_reason_valid" CHECK ("journals"."reason" IN ('demo_grant', 'offline_credit', 'offline_debit', 'correction')),
	CONSTRAINT "journal_amount_valid" CHECK ("journals"."amount" BETWEEN 1 AND 10000000000)
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid,
	"kind" text NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ledger_account_kind_valid" CHECK ("ledger_accounts"."kind" IN ('issuance', 'wallet', 'reserved')),
	CONSTRAINT "ledger_owner_valid" CHECK (("ledger_accounts"."kind" = 'issuance' AND "ledger_accounts"."owner_id" IS NULL) OR ("ledger_accounts"."kind" <> 'issuance' AND "ledger_accounts"."owner_id" IS NOT NULL)),
	CONSTRAINT "ledger_balance_valid" CHECK ("ledger_accounts"."balance" BETWEEN -9000000000000000 AND 9000000000000000 AND ("ledger_accounts"."kind" = 'issuance' OR "ledger_accounts"."balance" >= 0))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"delta" bigint NOT NULL,
	CONSTRAINT "ledger_delta_valid" CHECK ("ledger_entries"."delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"authenticated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_mfa" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'participant' NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"mfa_secret" text,
	"last_mfa_step" integer DEFAULT -1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_handle_unique" UNIQUE("handle"),
	CONSTRAINT "user_handle_valid" CHECK ("users"."handle" ~ '^[a-z][a-z0-9_-]{2,31}$'),
	CONSTRAINT "user_role_valid" CHECK ("users"."role" IN ('admin', 'participant'))
);
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_recipient_index" ON "journals" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_owner_kind_unique" ON "ledger_accounts" USING btree ("owner_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_issuance_unique" ON "ledger_accounts" USING btree ("kind") WHERE "ledger_accounts"."kind" = 'issuance';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entry_account_unique" ON "ledger_entries" USING btree ("journal_id","account_id");--> statement-breakpoint
CREATE INDEX "ledger_entry_account_index" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "session_user_index" ON "sessions" USING btree ("user_id");--> statement-breakpoint
-- Keep journals, ledger lines, and administrator audit events append-only.
CREATE FUNCTION reject_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable record';
END;
$$;--> statement-breakpoint
CREATE TRIGGER journals_immutable BEFORE UPDATE OR DELETE ON journals FOR EACH ROW EXECUTE FUNCTION reject_record_change();--> statement-breakpoint
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_record_change();--> statement-breakpoint
CREATE TRIGGER admin_audit_immutable BEFORE UPDATE OR DELETE ON admin_audit FOR EACH ROW EXECUTE FUNCTION reject_record_change();--> statement-breakpoint
CREATE FUNCTION apply_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal_transaction bigint;
BEGIN
  SELECT transaction_id INTO journal_transaction FROM journals WHERE id = NEW.journal_id;
  IF journal_transaction IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'Journal already finalized';
  END IF;
  UPDATE ledger_accounts SET balance = balance + NEW.delta WHERE id = NEW.account_id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER ledger_apply AFTER INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry();--> statement-breakpoint
CREATE FUNCTION verify_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_count integer; total numeric; expected bigint;
BEGIN
  SELECT count(*), coalesce(sum(delta), 0) INTO line_count, total FROM ledger_entries WHERE journal_id = NEW.id;
  expected := CASE WHEN NEW.kind = 'credit' THEN NEW.amount ELSE -NEW.amount END;
  IF NEW.transaction_id <> txid_current() OR line_count <> 2 OR total <> 0
    OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.actor_id AND role = 'admin' AND suspended = false)
    OR NOT EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.journal_id = NEW.id AND a.kind = 'wallet' AND a.owner_id = NEW.recipient_id AND e.delta = expected)
    OR NOT EXISTS (SELECT 1 FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.journal_id = NEW.id AND a.kind = 'issuance' AND e.delta = -expected)
  THEN RAISE EXCEPTION 'Invalid journal'; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_journal();--> statement-breakpoint
CREATE FUNCTION verify_account_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stored bigint; projected numeric;
BEGIN
  SELECT balance INTO stored FROM ledger_accounts WHERE id = NEW.id;
  SELECT coalesce(sum(delta), 0) INTO projected FROM ledger_entries WHERE account_id = NEW.id;
  IF stored IS DISTINCT FROM projected THEN RAISE EXCEPTION 'Ledger projection mismatch'; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER account_projection AFTER INSERT OR UPDATE ON ledger_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_account_projection();--> statement-breakpoint
CREATE FUNCTION preserve_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Immutable ledger account identity';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER account_identity BEFORE UPDATE ON ledger_accounts FOR EACH ROW EXECUTE FUNCTION preserve_account_identity();
