-- The read-only role behind `wings-staging-sql` (created by hand on staging on
-- 2026-09-18) sees a new table only once it is granted. Guarded: the role does
-- not exist on production, locally or in the throwaway test databases.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "ad_video_upload_sessions" TO wings_ro;
  END IF;
END
$$;
