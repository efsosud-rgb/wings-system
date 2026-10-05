-- Numbered 0063: 0061 and 0062 are taken by feat/crm-trabalho, not merged yet.
-- Idempotent, so applying it again (or after columns made by hand) is harmless.
ALTER TYPE "public"."ad_alert_kind" ADD VALUE IF NOT EXISTS 'meta_ad_without_utms';--> statement-breakpoint
ALTER TYPE "public"."ad_alert_kind" ADD VALUE IF NOT EXISTS 'google_campaign_own_suffix';--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "final_url_suffix" text;--> statement-breakpoint
ALTER TABLE "ad_ads" ADD COLUMN IF NOT EXISTS "url_tags" text;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD COLUMN IF NOT EXISTS "final_url_suffix" text;
