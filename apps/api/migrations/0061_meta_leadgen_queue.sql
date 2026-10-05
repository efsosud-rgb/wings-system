CREATE TABLE "meta_leadgen_events" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leadgen_id" text NOT NULL,
	"form_id" text,
	"page_id" text,
	"ad_id" text,
	"adgroup_id" text,
	"created_time" timestamp with time zone,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"lead_id" uuid,
	"lead_created" boolean,
	"rd_deal_id" text,
	"rd_outcome" text
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "form_answers" jsonb;--> statement-breakpoint
ALTER TABLE "meta_leadgen_events" ADD CONSTRAINT "meta_leadgen_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_leadgen_events" ADD CONSTRAINT "meta_leadgen_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meta_leadgen_events_leadgen_uq" ON "meta_leadgen_events" USING btree ("leadgen_id");--> statement-breakpoint
CREATE INDEX "meta_leadgen_events_status_idx" ON "meta_leadgen_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "meta_leadgen_events_received_idx" ON "meta_leadgen_events" USING btree ("received_at");