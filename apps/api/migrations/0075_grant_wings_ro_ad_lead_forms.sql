-- The read-only role behind `wings-staging-sql` sees a new table only once it
-- is granted. Guarded: the role does not exist on production, locally or in
-- the throwaway test databases.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "ad_lead_forms" TO wings_ro;
  END IF;
END
$$;
