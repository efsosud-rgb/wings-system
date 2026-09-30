CREATE TABLE "rd_user_map" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"rd_user_id" text PRIMARY KEY NOT NULL,
	"rd_name" text NOT NULL,
	"rd_active" boolean DEFAULT true NOT NULL,
	"employee_id" uuid,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_source_rules" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "pipeline" text;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "brand" text;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "pipeline" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "brand" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "rd_deal_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "rd_contact_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "rd_owner_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "rd_pipeline" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "stage_order" integer;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "stage_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "won" boolean;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "lost_reason" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "first_contact_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "rd_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "utm_source" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "utm_medium" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "utm_content" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "utm_term" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "gclid" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "fbclid" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "gbraid" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "wbraid" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ad_platform" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ad_campaign_external_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ad_set_external_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ad_external_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "referrer" text;--> statement-breakpoint
ALTER TABLE "rd_user_map" ADD CONSTRAINT "rd_user_map_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rd_user_map" ADD CONSTRAINT "rd_user_map_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rd_user_map" ADD CONSTRAINT "rd_user_map_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_rd_deal_uq" ON "leads" USING btree ("rd_deal_id");--> statement-breakpoint
CREATE INDEX "leads_pipeline_stage_idx" ON "leads" USING btree ("pipeline","stage");--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD CONSTRAINT "lead_source_rules_client_or_brand" CHECK ("lead_source_rules"."client_id" is not null or "lead_source_rules"."brand" is not null);--> statement-breakpoint
-- CRM phase 1: the brands' landing pages join the source rules, so there is one list.
-- A brand already registered as a client (same name, any case) is linked; the others keep the name only.
INSERT INTO "lead_source_rules" ("tenant_id", "kind", "pattern", "client_id", "pipeline", "brand", "active", "created_at")
SELECT p."tenant_id", 'landing_page', lower(trim(p."identifier")),
       (SELECT c."id" FROM "clients" c WHERE lower(c."name") = lower(p."brand") ORDER BY c."created_at" LIMIT 1),
       'expansao', p."brand", p."active", p."created_at"
FROM "expansion_landing_pages" p
ON CONFLICT ("tenant_id", "kind", "pattern") DO UPDATE
  SET "pipeline" = coalesce("lead_source_rules"."pipeline", 'expansao'),
      "brand" = coalesce("lead_source_rules"."brand", EXCLUDED."brand");
--> statement-breakpoint
-- The three Formatação forms (the Formatação net's list) belong to Wings Company.
INSERT INTO "lead_source_rules" ("tenant_id", "kind", "pattern", "client_id", "pipeline")
SELECT '00000000-0000-0000-0000-000000000001', 'landing_page', f.pattern, '00000000-0000-4000-8000-0000000000c1', 'formatacao'
FROM (VALUES ('wings-company-form-site'), ('lp-formatacao-whatsapp'), ('formulário simplificado. -02')) AS f(pattern)
WHERE EXISTS (SELECT 1 FROM "clients" WHERE "id" = '00000000-0000-4000-8000-0000000000c1')
ON CONFLICT ("tenant_id", "kind", "pattern") DO UPDATE
  SET "pipeline" = coalesce("lead_source_rules"."pipeline", 'formatacao');
