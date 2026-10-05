CREATE TABLE "crm_companies" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"cnpj" text,
	"phone" text,
	"email" text,
	"website" text,
	"city" text,
	"state" text,
	"segment" text,
	"client_id" uuid,
	"merged_into_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contacts" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"job_title" text,
	"company_id" uuid,
	"merged_into_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_saved_views" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"pipeline" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_activities" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"outcome" text,
	"duration_seconds" integer,
	"participants" text,
	"meet_url" text,
	"note" text,
	"actor_employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_contacts" (
	"lead_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_contacts_lead_id_contact_id_pk" PRIMARY KEY("lead_id","contact_id")
);
--> statement-breakpoint
ALTER TABLE "crm_stages" ADD COLUMN "probability" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "value_cents" bigint;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_merged_into_id_crm_companies_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."crm_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_company_id_crm_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."crm_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_merged_into_id_crm_contacts_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."crm_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_saved_views" ADD CONSTRAINT "crm_saved_views_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_saved_views" ADD CONSTRAINT "crm_saved_views_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_actor_employee_id_employees_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_contacts" ADD CONSTRAINT "lead_contacts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_contacts" ADD CONSTRAINT "lead_contacts_contact_id_crm_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."crm_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_companies_cnpj_uq" ON "crm_companies" USING btree ("tenant_id","cnpj") WHERE "crm_companies"."cnpj" is not null and "crm_companies"."merged_into_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_companies_name_key_uq" ON "crm_companies" USING btree ("tenant_id","name_key") WHERE "crm_companies"."merged_into_id" is null;--> statement-breakpoint
CREATE INDEX "crm_companies_client_idx" ON "crm_companies" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contacts_email_uq" ON "crm_contacts" USING btree ("tenant_id","email") WHERE "crm_contacts"."email" is not null and "crm_contacts"."merged_into_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contacts_phone_uq" ON "crm_contacts" USING btree ("tenant_id","phone") WHERE "crm_contacts"."phone" is not null and "crm_contacts"."merged_into_id" is null;--> statement-breakpoint
CREATE INDEX "crm_contacts_company_idx" ON "crm_contacts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "crm_saved_views_employee_idx" ON "crm_saved_views" USING btree ("employee_id","pipeline");--> statement-breakpoint
CREATE INDEX "lead_activities_lead_idx" ON "lead_activities" USING btree ("lead_id","at");--> statement-breakpoint
CREATE INDEX "lead_contacts_contact_idx" ON "lead_contacts" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "leads_company_idx" ON "leads" USING btree ("company_id");--> statement-breakpoint
-- Backfill (CRM núcleo, 05/10/2026): one contact per person the Funil already
-- knows, by phone first (the WhatsApp is the identity), then by e-mail for the
-- leads that have no phone; every lead tied to its contact as the main one.
INSERT INTO "crm_contacts" ("name", "email", "phone", "created_at")
SELECT DISTINCT ON (l.phone) l.name, NULL, l.phone, l.created_at
FROM "leads" l
WHERE l.phone IS NOT NULL
ORDER BY l.phone, l.created_at ASC;--> statement-breakpoint
UPDATE "crm_contacts" c
SET "email" = s.email
FROM (
  SELECT DISTINCT ON (l.phone) l.phone, l.email
  FROM "leads" l
  WHERE l.phone IS NOT NULL AND l.email IS NOT NULL
  ORDER BY l.phone, l.created_at ASC
) s
WHERE c.phone = s.phone AND c.email IS NULL
  AND NOT EXISTS (SELECT 1 FROM "crm_contacts" o WHERE o.email = s.email AND o.merged_into_id IS NULL);--> statement-breakpoint
INSERT INTO "crm_contacts" ("name", "email", "phone", "created_at")
SELECT DISTINCT ON (l.email) l.name, l.email, NULL, l.created_at
FROM "leads" l
WHERE l.phone IS NULL AND l.email IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "crm_contacts" c WHERE c.email = l.email AND c.merged_into_id IS NULL)
ORDER BY l.email, l.created_at ASC;--> statement-breakpoint
INSERT INTO "lead_contacts" ("lead_id", "contact_id", "primary")
SELECT l.id, c.id, true
FROM "leads" l
JOIN "crm_contacts" c ON c.merged_into_id IS NULL AND c.phone = l.phone
WHERE l.phone IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "lead_contacts" ("lead_id", "contact_id", "primary")
SELECT l.id, c.id, true
FROM "leads" l
JOIN "crm_contacts" c ON c.merged_into_id IS NULL AND c.email = l.email
WHERE l.phone IS NULL AND l.email IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "lead_contacts" lc WHERE lc.lead_id = l.id)
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The Expansão clients already registered are the brands of interest.
UPDATE "clients" SET "franchise_on_sale" = true
WHERE "franchise_on_sale" IS NULL AND "relationship" IN ('expansao', 'ambos') AND "active" = true;--> statement-breakpoint
-- Stage probabilities: a rising default by position (10 % … 90 %), configurable in CRM Vendas → Configurações.
UPDATE "crm_stages" s SET "probability" = LEAST(90, GREATEST(10, p.rank * 90 / GREATEST(p.n, 1)))
FROM (
  SELECT id, row_number() OVER (PARTITION BY pipeline ORDER BY position, name) AS rank,
         count(*) OVER (PARTITION BY pipeline) AS n
  FROM "crm_stages" WHERE active
) p
WHERE s.id = p.id;--> statement-breakpoint
-- Consultoria funnel: its entry stage, so the board has a column from day one.
INSERT INTO "crm_stages" ("pipeline", "name", "position", "probability")
SELECT 'consultoria', 'Novo contato', 1, 10
WHERE NOT EXISTS (SELECT 1 FROM "crm_stages" WHERE pipeline = 'consultoria');--> statement-breakpoint
-- Rotation (Eric, 05/10/2026): Expansão → Fernando only; Formatação and Consultoria → Thais only;
-- Eric owns and redistributes but is not in the rotation; the other RD users leave it.
-- Matched by first name among active sales staff; a name not found leaves that funnel's rotation empty.
DELETE FROM "crm_distribution_members";--> statement-breakpoint
INSERT INTO "crm_distribution_members" ("pipeline", "employee_id", "active")
SELECT 'expansao', e.id, true
FROM "employees" e JOIN "roles" r ON r.id = e.role_id
WHERE e.status = 'active' AND r.key IN ('vendedor_expansao', 'vendedor_formatacao', 'gerente_comercial')
  AND lower(split_part(e.full_name, ' ', 1)) = 'fernando'
ORDER BY e.created_at LIMIT 1;--> statement-breakpoint
INSERT INTO "crm_distribution_members" ("pipeline", "employee_id", "active")
SELECT p.pipeline, e.id, true
FROM (VALUES ('formatacao'), ('consultoria')) AS p(pipeline)
CROSS JOIN (
  SELECT e.id FROM "employees" e JOIN "roles" r ON r.id = e.role_id
  WHERE e.status = 'active' AND r.key IN ('vendedor_expansao', 'vendedor_formatacao', 'gerente_comercial')
    AND lower(split_part(e.full_name, ' ', 1)) IN ('thais', 'thaís')
  ORDER BY e.created_at LIMIT 1
) e;--> statement-breakpoint
CREATE OR REPLACE VIEW "crm_activities_analysis" AS
SELECT a.id, a.lead_id, a.kind, a.at, a.outcome, a.duration_seconds, (a.meet_url IS NOT NULL) AS has_meet_url, a.actor_employee_id, a.created_at
FROM "lead_activities" a;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "crm_activities_analysis" TO wings_ro;
    GRANT SELECT ON TABLE "lead_contacts" TO wings_ro;
    GRANT SELECT ON TABLE "crm_saved_views" TO wings_ro;
  END IF;
END $$;
