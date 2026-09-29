ALTER TYPE "public"."ad_change_kind" ADD VALUE 'add_ads';--> statement-breakpoint
ALTER TABLE "ad_change_requests" ADD COLUMN "payload" jsonb;