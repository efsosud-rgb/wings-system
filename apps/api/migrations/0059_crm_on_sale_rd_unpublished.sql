-- IF NOT EXISTS: staging got these two columns by hand on 2026-10-02, before the merge (handoff-crm-marcas-2026-10-02).
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "franchise_on_sale" boolean;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN IF NOT EXISTS "rd_unpublished_on" date;
