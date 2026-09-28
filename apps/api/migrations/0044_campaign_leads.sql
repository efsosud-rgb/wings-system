CREATE TABLE "campaign_leads" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rd_deal_id" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"pipeline" text NOT NULL,
	"stage" text NOT NULL,
	"stage_order" integer NOT NULL,
	"win" boolean,
	"closed_at" timestamp with time zone,
	"lost_reason" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"amount_cents" bigint DEFAULT 0 NOT NULL,
	"name" text,
	"company" text,
	"segment" text,
	"city" text,
	"email_encrypted" text,
	"phone_encrypted" text,
	"email_masked" text,
	"phone_masked" text,
	"owner_rd_id" text,
	"owner_name" text,
	"owner_employee_id" uuid,
	"rating" integer,
	"last_activity_at" timestamp with time zone,
	"rd_source_label" text,
	"rd_campaign_label" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_checked_at" timestamp with time zone,
	"platform" text,
	"campaign_id" uuid,
	"ad_id" uuid,
	"attribution" text,
	"unattributed_reason" text,
	"first_contact_at" timestamp with time zone,
	"first_contact_source" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_leads_rd_deal_id_unique" UNIQUE("rd_deal_id")
);
--> statement-breakpoint
ALTER TABLE "rd_crm_deals" ADD COLUMN "lost_reason" text;--> statement-breakpoint
ALTER TABLE "rd_crm_deals" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_ad_id_ad_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ad_ads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_leads_entered_idx" ON "campaign_leads" USING btree ("entered_at");--> statement-breakpoint
CREATE INDEX "campaign_leads_owner_idx" ON "campaign_leads" USING btree ("owner_employee_id");