CREATE TYPE "public"."ad_budget_level" AS ENUM('campaign', 'ad_set', 'none');--> statement-breakpoint
CREATE TABLE "ad_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "ad_campaign_status" DEFAULT 'PAUSED' NOT NULL,
	"daily_budget_cents" bigint DEFAULT 0 NOT NULL,
	"lifetime_budget_cents" bigint,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD COLUMN "budget_level" "ad_budget_level" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_sets" ADD CONSTRAINT "ad_sets_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_sets_campaign_external_uq" ON "ad_sets" USING btree ("campaign_id","external_id");