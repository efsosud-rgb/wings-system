CREATE TYPE "public"."ad_breakdown_kind" AS ENUM('placement', 'age_gender', 'region', 'hour');--> statement-breakpoint
CREATE TABLE "ad_account_daily" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" bigserial PRIMARY KEY NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"spend_cap_cents" bigint,
	"amount_spent_cents" bigint,
	"platform_remaining_cents" bigint,
	"prepaid_balance_cents" bigint,
	"funding_kind" text,
	"active_daily_budget_cents" bigint DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_metrics_breakdown_daily" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" bigserial PRIMARY KEY NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"campaign_id" uuid,
	"campaign_external_id" text NOT NULL,
	"day" date NOT NULL,
	"kind" "ad_breakdown_kind" NOT NULL,
	"key" text NOT NULL,
	"sub_key" text DEFAULT '' NOT NULL,
	"spend_cents" bigint DEFAULT 0 NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"reach" bigint DEFAULT 0 NOT NULL,
	"conversions" bigint DEFAULT 0 NOT NULL,
	"actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "format" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD COLUMN "video_plays" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD COLUMN "video_thruplays" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD COLUMN "video_p25" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD COLUMN "video_p50" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD COLUMN "video_p75" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD COLUMN "video_p100" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_account_daily" ADD CONSTRAINT "ad_account_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_account_daily" ADD CONSTRAINT "ad_account_daily_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics_breakdown_daily" ADD CONSTRAINT "ad_metrics_breakdown_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics_breakdown_daily" ADD CONSTRAINT "ad_metrics_breakdown_daily_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_metrics_breakdown_daily" ADD CONSTRAINT "ad_metrics_breakdown_daily_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_account_daily_account_day_uq" ON "ad_account_daily" USING btree ("ad_account_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_metrics_breakdown_daily_uq" ON "ad_metrics_breakdown_daily" USING btree ("ad_account_id","campaign_external_id","day","kind","key","sub_key");--> statement-breakpoint
CREATE INDEX "ad_metrics_breakdown_daily_account_kind_day_idx" ON "ad_metrics_breakdown_daily" USING btree ("ad_account_id","kind","day");--> statement-breakpoint
CREATE INDEX "ad_metrics_daily_account_level_day_idx" ON "ad_metrics_daily" USING btree ("ad_account_id","level","day");