-- Custom SQL migration file, put your code below! --

-- wings_ro is granted SELECT by hand today (docker exec, run 2026-09-24) on the
-- roadmap tables added in 0034_roadmap.sql. This makes the grant idempotent and
-- reproducible from the migration history instead of living only in shell history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON
      roadmap_modules,
      roadmap_deliverables,
      roadmap_deliverable_changes,
      roadmap_report_runs,
      roadmap_report_recipients
    TO wings_ro;
  END IF;
END
$$;