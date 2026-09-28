ALTER TABLE "ad_metrics_daily" ADD COLUMN "video_starts" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_metrics_daily" ADD COLUMN "video_watch_ms" bigint DEFAULT 0 NOT NULL;