CREATE TABLE "ad_campaign_saved_drafts" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_campaign_saved_drafts" ADD CONSTRAINT "ad_campaign_saved_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_saved_drafts" ADD CONSTRAINT "ad_campaign_saved_drafts_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_campaign_saved_drafts_updated_idx" ON "ad_campaign_saved_drafts" USING btree ("updated_at");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON ad_campaign_saved_drafts TO wings_ro;
  END IF;
END
$$;
