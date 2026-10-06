CREATE TABLE "ad_lead_forms" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"page_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"spec" jsonb NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"execution_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "site_form_spec" jsonb;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "site_form_spec_pending" jsonb;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "site_form_pending_by" uuid;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "site_form_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "site_form_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "site_form_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ad_lead_forms" ADD CONSTRAINT "ad_lead_forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_lead_forms" ADD CONSTRAINT "ad_lead_forms_execution_id_ad_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."ad_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_lead_forms" ADD CONSTRAINT "ad_lead_forms_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_lead_forms_page_fingerprint_idx" ON "ad_lead_forms" USING btree ("page_id","fingerprint");--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD CONSTRAINT "lead_source_rules_site_form_pending_by_employees_id_fk" FOREIGN KEY ("site_form_pending_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD CONSTRAINT "lead_source_rules_site_form_approved_by_employees_id_fk" FOREIGN KEY ("site_form_approved_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;