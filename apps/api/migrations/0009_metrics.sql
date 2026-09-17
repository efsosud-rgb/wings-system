CREATE TYPE "public"."ad_metrics_level" AS ENUM('campaign', 'ad_set', 'ad');--> statement-breakpoint
CREATE TABLE "ad_ads" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"ad_set_id" uuid,
	"campaign_id" uuid,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "ad_campaign_status" DEFAULT 'PAUSED' NOT NULL,
	"effective_status" text,
	"creative_external_id" text,
	"review_feedback" jsonb,
	"issues_info" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_creatives" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text,
	"thumbnail_url" text,
	"title" text,
	"body" text,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ad_metrics_daily" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" bigserial PRIMARY KEY NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"level" "ad_metrics_level" NOT NULL,
	"entity_external_id" text NOT NULL,
	"campaign_id" uuid,
	"ad_set_id" uuid,
	"ad_id" uuid,
	"day" date NOT NULL,
	"spend_cents" bigint DEFAULT 0 NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"reach" bigint DEFAULT 0 NOT NULL,
	"ctr_milli" bigint DEFAULT 0 NOT NULL,
	"frequency_milli" bigint DEFAULT 0 NOT NULL,
	"conversions" bigint DEFAULT 0 NOT NULL,
	"actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quality_ranking" text,
	"engagement_rate_ranking" text,
	"conversion_rate_ranking" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_ads" ADD CONSTRAINT "ad_ads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_ads" ADD CONSTRAINT "ad_ads_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_ads" ADD CONSTRAINT "ad_ads_ad_set_id_ad_sets_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_ads" ADD CONSTRAINT "ad_ads_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD CONSTRAINT "ad_metrics_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD CONSTRAINT "ad_metrics_daily_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD CONSTRAINT "ad_metrics_daily_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD CONSTRAINT "ad_metrics_daily_ad_set_id_ad_sets_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD CONSTRAINT "ad_metrics_daily_ad_id_ad_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ad_ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_ads_account_external_uq" ON "ad_ads" USING btree ("ad_account_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_creatives_account_external_uq" ON "ad_creatives" USING btree ("ad_account_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_metrics_daily_entity_day_uq" ON "ad_metrics_daily" USING btree ("ad_account_id","level","entity_external_id","day");--> statement-breakpoint
CREATE INDEX "ad_metrics_daily_account_day_idx" ON "ad_metrics_daily" USING btree ("ad_account_id","day");