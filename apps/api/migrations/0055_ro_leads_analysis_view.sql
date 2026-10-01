-- A read-only view for analysing the Funil without personal data. `wings_ro`
-- (behind `wings-staging-sql`) is granted this view and nothing else of the
-- leads tables: no name, e-mail, phone, first message, consent text, enrichment
-- or tracking ids. The view runs with its owner's rights, so the role needs no
-- access to `leads` itself. Guarded: the role does not exist on production,
-- locally or in the throwaway test databases.
CREATE OR REPLACE VIEW "leads_analysis" AS
SELECT
  l.id,
  l.rd_deal_id,
  l.pipeline,
  l.brand,
  l.rd_pipeline,
  l.stage,
  l.stage_order,
  l.stage_changed_at,
  l.won,
  l.closed_at,
  l.first_contact_at,
  l.rd_synced_at,
  l.source,
  l.import_batch_id,
  l.owner_employee_id IS NOT NULL AS has_employee_owner,
  l.rd_owner_id,
  m.rd_active AS rd_owner_active,
  l.created_at,
  l.updated_at
FROM "leads" l
LEFT JOIN "rd_user_map" m ON m.rd_user_id = l.rd_owner_id;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "leads_analysis" TO wings_ro;
  END IF;
END
$$;
