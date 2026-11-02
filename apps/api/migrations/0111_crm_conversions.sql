CREATE TABLE "ad_conversion_sends" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"history_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"event_name" text NOT NULL,
	"destination" text,
	"event_time" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"identifier_kind" text,
	"fields_sent" text[],
	"last_error" text,
	"skip_reason" text,
	"platform_request_id" text,
	"response_shape" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ad_conversion_stage_events" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"event_name" text NOT NULL,
	"google_conversion_action_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_conversion_stage_events_google_action" CHECK ("ad_conversion_stage_events"."platform" <> 'google' or "ad_conversion_stage_events"."google_conversion_action_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "lead_ad_identifiers" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"source" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_conversion_sends" ADD CONSTRAINT "ad_conversion_sends_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_sends" ADD CONSTRAINT "ad_conversion_sends_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_sends" ADD CONSTRAINT "ad_conversion_sends_stage_id_crm_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_sends" ADD CONSTRAINT "ad_conversion_sends_history_id_lead_stage_history_id_fk" FOREIGN KEY ("history_id") REFERENCES "public"."lead_stage_history"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_stage_events" ADD CONSTRAINT "ad_conversion_stage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_stage_events" ADD CONSTRAINT "ad_conversion_stage_events_stage_id_crm_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_stage_events" ADD CONSTRAINT "ad_conversion_stage_events_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_ad_identifiers" ADD CONSTRAINT "lead_ad_identifiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_ad_identifiers" ADD CONSTRAINT "lead_ad_identifiers_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_conversion_sends_uq" ON "ad_conversion_sends" USING btree ("lead_id","stage_id","platform");--> statement-breakpoint
CREATE INDEX "ad_conversion_sends_due_idx" ON "ad_conversion_sends" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ad_conversion_sends_created_idx" ON "ad_conversion_sends" USING btree ("platform","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_conversion_stage_events_uq" ON "ad_conversion_stage_events" USING btree ("stage_id","platform");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_ad_identifiers_uq" ON "lead_ad_identifiers" USING btree ("lead_id","kind","value");