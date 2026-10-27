CREATE TABLE "prospect_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"employee_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"query_text" text,
	"locations" text[] DEFAULT '{}' NOT NULL,
	"count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospecting_settings" (
	"tenant_id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"place_id" text NOT NULL,
	"status" text NOT NULL,
	"owner_employee_id" uuid,
	"reason" text,
	"notes" text,
	"enrichment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lead_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prospects_status_check" CHECK ("prospects"."status" in ('reservado', 'descartado', 'contatado', 'sem_interesse', 'nao_contatar', 'virou_lead', 'nao_encontrado'))
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "google_place_id" text;--> statement-breakpoint
ALTER TABLE "prospect_calls" ADD CONSTRAINT "prospect_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_calls" ADD CONSTRAINT "prospect_calls_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospecting_settings" ADD CONSTRAINT "prospecting_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospecting_settings" ADD CONSTRAINT "prospecting_settings_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prospect_calls_tenant_created_idx" ON "prospect_calls" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "prospect_calls_employee_created_idx" ON "prospect_calls" USING btree ("employee_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_place_uq" ON "prospects" USING btree ("tenant_id","place_id");--> statement-breakpoint
CREATE INDEX "prospects_owner_idx" ON "prospects" USING btree ("tenant_id","owner_employee_id");--> statement-breakpoint
CREATE INDEX "leads_google_place_idx" ON "leads" USING btree ("tenant_id","google_place_id");