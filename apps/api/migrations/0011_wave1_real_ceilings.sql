ALTER TABLE "ad_accounts" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "archived_reason" text;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD COLUMN "daily_budget_cents" bigint;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD COLUMN "platform_remaining_cents" bigint;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD COLUMN "platform_limit_source" text;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD COLUMN "platform_limit_synced_at" timestamp with time zone;