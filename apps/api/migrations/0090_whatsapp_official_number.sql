CREATE TABLE "whatsapp_settings" (
	"tenant_id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"official_number_live" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_settings" ADD CONSTRAINT "whatsapp_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_settings" ADD CONSTRAINT "whatsapp_settings_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A flag only, no personal data: readable through `wings-staging-sql` (guarded, as in 0075).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "whatsapp_settings" TO wings_ro;
  END IF;
END
$$;
