ALTER TABLE "leads" ADD COLUMN "instagram" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "company_cnpj" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "field_checks" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- The read-only role behind `wings-staging-sql` sees a table only once it is
-- granted. 0071 created "lead_files" (ids and dates only) without the grant, and
-- an applied migration is never edited, so it goes here. The new columns above
-- are personal data on "leads", which the role never reads (only the
-- "leads_analysis" view). Guarded: the role does not exist on production,
-- locally or in the throwaway test databases.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "lead_files" TO wings_ro;
  END IF;
END $$;
