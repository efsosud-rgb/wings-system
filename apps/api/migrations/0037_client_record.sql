CREATE TABLE "client_business" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"segment" text,
	"description" text,
	"operating_years" integer,
	"own_units" integer,
	"revenue_band" text,
	"average_ticket_cents" bigint,
	"employees_count" integer,
	"inpi_process" text,
	"inpi_class" text,
	"inpi_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_contacts" (
	"client_id" uuid NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"job_title" text,
	"email" text,
	"whatsapp" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_contacts_client_id_role_pk" PRIMARY KEY("client_id","role")
);
--> statement-breakpoint
CREATE TABLE "client_contract_consultants" (
	"contract_id" uuid NOT NULL,
	"area" text NOT NULL,
	"employee_id" uuid NOT NULL,
	CONSTRAINT "client_contract_consultants_contract_id_area_pk" PRIMARY KEY("contract_id","area")
);
--> statement-breakpoint
CREATE TABLE "client_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"service" text NOT NULL,
	"number" text,
	"signed_on" date,
	"value_cents" bigint,
	"payment_method" text,
	"installments" integer,
	"starts_on" date,
	"term_months" integer,
	"lead_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "client_franchise_plans" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"franchise_fee_cents" bigint,
	"royalties_percent" numeric(5, 2),
	"ad_fund_percent" numeric(5, 2),
	"initial_investment_cents" bigint,
	"franchisee_profile" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"cpf_encrypted" text,
	"cpf_index" text,
	"rg" text,
	"rg_issuer" text,
	"nationality" text,
	"profession" text,
	"marital_status" text,
	"property_regime" text,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"email" text,
	"mobile" text,
	"share_percent" numeric(5, 2),
	"signs_for_company" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "client_signatures" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"signer_partner_id" uuid,
	"signing_email" text,
	"signing_mobile" text,
	"signature_type" text,
	"forum" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_unit_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"initial_investment_cents" bigint,
	"franchise_fee_cents" bigint,
	"area_m2" integer
);
--> statement-breakpoint
CREATE TABLE "client_witnesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"cpf_encrypted" text,
	"cpf_index" text,
	"email" text
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "trade_name" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "cnpj" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "state_registration" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "municipal_registration" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "opened_on" date;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "legal_nature" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "tax_regime" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "cnae_main" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "cnae_secondary" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "share_capital_cents" bigint;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "social" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_business" ADD CONSTRAINT "client_business_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contacts" ADD CONSTRAINT "client_contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contract_consultants" ADD CONSTRAINT "client_contract_consultants_contract_id_client_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."client_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contract_consultants" ADD CONSTRAINT "client_contract_consultants_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_contracts" ADD CONSTRAINT "client_contracts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_franchise_plans" ADD CONSTRAINT "client_franchise_plans_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_partners" ADD CONSTRAINT "client_partners_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_signatures" ADD CONSTRAINT "client_signatures_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_signatures" ADD CONSTRAINT "client_signatures_signer_partner_id_client_partners_id_fk" FOREIGN KEY ("signer_partner_id") REFERENCES "public"."client_partners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_unit_models" ADD CONSTRAINT "client_unit_models_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_witnesses" ADD CONSTRAINT "client_witnesses_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_contracts_client_idx" ON "client_contracts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_partners_client_idx" ON "client_partners" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_partners_client_cpf_idx" ON "client_partners" USING btree ("client_id","cpf_index") WHERE "client_partners"."cpf_index" is not null;--> statement-breakpoint
CREATE INDEX "client_unit_models_client_idx" ON "client_unit_models" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_witnesses_client_idx" ON "client_witnesses" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_cnpj_idx" ON "clients" USING btree ("tenant_id","cnpj") WHERE "clients"."cnpj" is not null;--> statement-breakpoint
-- Staging reads through wings_ro (wings-staging-sql); grant it the new tables
-- here, so no one has to remember a manual GRANT. Local, test and any database
-- without the role skip this. "clients" is granted again (harmless if it was):
-- its new columns are the record's first block.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON "clients", "client_partners", "client_contacts", "client_business", "client_contracts",
      "client_contract_consultants", "client_franchise_plans", "client_unit_models",
      "client_signatures", "client_witnesses" TO wings_ro;
  END IF;
END
$$;
