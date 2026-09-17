CREATE TYPE "public"."ad_alert_kind" AS ENUM('ad_rejected', 'budget_pacing', 'creative_fatigue', 'quality_below_average', 'conversion_silence');--> statement-breakpoint
CREATE TYPE "public"."ad_alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TABLE "ad_alerts" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"kind" "ad_alert_kind" NOT NULL,
	"severity" "ad_alert_severity" NOT NULL,
	"entity_level" "ad_metrics_level",
	"entity_external_id" text,
	"title" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"notified_at" timestamp with time zone,
	"notification_error" text
);
--> statement-breakpoint
ALTER TABLE "ad_alerts" ADD CONSTRAINT "ad_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_alerts" ADD CONSTRAINT "ad_alerts_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_alerts" ADD CONSTRAINT "ad_alerts_acknowledged_by_employees_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_alerts_account_idx" ON "ad_alerts" USING btree ("ad_account_id","resolved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_alerts_open_uq" ON "ad_alerts" USING btree ("ad_account_id","kind","entity_external_id") WHERE resolved_at is null;