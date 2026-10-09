CREATE TABLE "youtube_video_daily" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" bigserial PRIMARY KEY NOT NULL,
	"video_id" uuid NOT NULL,
	"day" date NOT NULL,
	"views" bigint NOT NULL,
	"likes" bigint,
	"comments" bigint,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_videos" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"video_id" text NOT NULL,
	"title" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"duration_seconds" integer,
	"thumbnail_url" text,
	"is_short" boolean,
	"short_checked_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD COLUMN "youtube" jsonb;--> statement-breakpoint
ALTER TABLE "youtube_video_daily" ADD CONSTRAINT "youtube_video_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_video_daily" ADD CONSTRAINT "youtube_video_daily_video_id_youtube_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."youtube_videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_videos" ADD CONSTRAINT "youtube_videos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_video_daily_video_day_uq" ON "youtube_video_daily" USING btree ("video_id","day");--> statement-breakpoint
CREATE INDEX "youtube_video_daily_day_idx" ON "youtube_video_daily" USING btree ("day");--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_videos_video_uq" ON "youtube_videos" USING btree ("tenant_id","video_id");--> statement-breakpoint
CREATE INDEX "youtube_videos_channel_seen_idx" ON "youtube_videos" USING btree ("channel_id","last_seen_at");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "youtube_videos" TO wings_ro;
    GRANT SELECT ON TABLE "youtube_video_daily" TO wings_ro;
  END IF;
END $$;
