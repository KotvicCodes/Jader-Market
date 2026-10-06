CREATE TYPE "public"."market_status" AS ENUM('draft', 'open', 'closed', 'proposed', 'resolved', 'void', 'cancelled');--> statement-breakpoint
CREATE TABLE "markets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"question" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"resolution_rules" text NOT NULL,
	"resolution_source" text NOT NULL,
	"status" "market_status" DEFAULT 'draft' NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synthetic" text DEFAULT 'no' NOT NULL,
	CONSTRAINT "markets_slug_unique" UNIQUE("slug"),
	CONSTRAINT "market_synthetic_valid" CHECK ("markets"."synthetic" IN ('yes', 'no')),
	CONSTRAINT "market_question_nonempty" CHECK (length(trim("markets"."question")) BETWEEN 10 AND 240),
	CONSTRAINT "market_published_at_required" CHECK ("markets"."status" = 'draft' OR "markets"."published_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "market_public_index" ON "markets" USING btree ("status","closes_at");