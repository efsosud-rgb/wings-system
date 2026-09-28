CREATE TABLE "ga4_traffic_daily" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"property_id" text NOT NULL,
	"day" date NOT NULL,
	"source" text NOT NULL,
	"medium" text NOT NULL,
	"campaign" text NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"engaged_sessions" integer DEFAULT 0 NOT NULL,
	"engagement_seconds" bigint DEFAULT 0 NOT NULL,
	"page_views" integer DEFAULT 0 NOT NULL,
	"key_events" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ga4_traffic_daily_property_id_day_source_medium_campaign_pk" PRIMARY KEY("property_id","day","source","medium","campaign")
);
--> statement-breakpoint
CREATE TABLE "rd_crm_deals" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"rd_id" text PRIMARY KEY NOT NULL,
	"pipeline" text NOT NULL,
	"stage" text NOT NULL,
	"stage_order" integer NOT NULL,
	"reached_meeting" boolean DEFAULT false NOT NULL,
	"win" boolean,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"source_label" text,
	"campaign_label" text,
	"platform" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ga4_traffic_daily" ADD CONSTRAINT "ga4_traffic_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rd_crm_deals" ADD CONSTRAINT "rd_crm_deals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rd_crm_deals_created_idx" ON "rd_crm_deals" USING btree ("created_at");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON ga4_traffic_daily, rd_crm_deals TO wings_ro;
  END IF;
END
$$;
