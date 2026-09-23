CREATE TABLE "lead_enrichment_ledger" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"job_id" uuid,
	"step" text NOT NULL,
	"status" text NOT NULL,
	"usd_micro" integer DEFAULT 0 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"actor_employee_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_source_rules" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"pattern" text NOT NULL,
	"client_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_tracking_links" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"code" text NOT NULL,
	"phone" text NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid DEFAULT '00000000-0000-4000-8000-0000000000c1' NOT NULL,
	"client_mapped" boolean DEFAULT true NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"status" text DEFAULT 'new' NOT NULL,
	"owner_employee_id" uuid,
	"source" text NOT NULL,
	"channel" text,
	"landing_page" text,
	"campaign_id" text,
	"campaign_name" text,
	"form_id" text,
	"tracking_link_id" uuid,
	"external_id" text,
	"first_message" text,
	"whatsapp_profile_name" text,
	"whatsapp_photo_url" text,
	"legal_basis" text,
	"consented_at" timestamp with time zone,
	"consent_source" text,
	"consent_text" text,
	"enrichment_state" text DEFAULT 'none' NOT NULL,
	"enrichment_job_id" uuid,
	"enrichment_summary" text,
	"enrichment_score" integer,
	"enrichment_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enrichment_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enrichment_facts" jsonb,
	"enrichment_error" text,
	"enriched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "expansion_area" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_enrichment_ledger" ADD CONSTRAINT "lead_enrichment_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_enrichment_ledger" ADD CONSTRAINT "lead_enrichment_ledger_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_enrichment_ledger" ADD CONSTRAINT "lead_enrichment_ledger_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_actor_employee_id_employees_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD CONSTRAINT "lead_source_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD CONSTRAINT "lead_source_rules_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD CONSTRAINT "lead_source_rules_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tracking_links" ADD CONSTRAINT "lead_tracking_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tracking_links" ADD CONSTRAINT "lead_tracking_links_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tracking_links" ADD CONSTRAINT "lead_tracking_links_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_enrichment_job_id_jobs_id_fk" FOREIGN KEY ("enrichment_job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_enrichment_ledger_created_idx" ON "lead_enrichment_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "lead_enrichment_ledger_lead_idx" ON "lead_enrichment_ledger" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_events_lead_idx" ON "lead_events" USING btree ("lead_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_source_rules_kind_pattern_uq" ON "lead_source_rules" USING btree ("tenant_id","kind","pattern");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_tracking_links_code_uq" ON "lead_tracking_links" USING btree ("code");--> statement-breakpoint
CREATE INDEX "lead_tracking_links_client_idx" ON "lead_tracking_links" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_source_external_uq" ON "leads" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "leads_phone_idx" ON "leads" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "leads_email_idx" ON "leads" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "leads_client_created_idx" ON "leads" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_owner_idx" ON "leads" USING btree ("owner_employee_id");--> statement-breakpoint
CREATE INDEX "leads_created_idx" ON "leads" USING btree ("created_at");