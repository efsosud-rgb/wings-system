-- Append-only enforcement at the database level.
--
-- time_entries and audit_log must never be rewritten: corrections are new rows.
-- This protects the RH/DP trail even against a bug or a direct psql session,
-- which is what Portaria MTP 671/2021 expects of an electronic time record.
-- (Legal sign-off from Jurídico is still pending — see docs/timeclock.md.)

CREATE OR REPLACE FUNCTION wings_forbid_update_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER time_entries_append_only
  BEFORE UPDATE OR DELETE ON "time_entries"
  FOR EACH ROW EXECUTE FUNCTION wings_forbid_update_delete();
--> statement-breakpoint

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION wings_forbid_update_delete();
--> statement-breakpoint

-- A deactivated employee must carry the moment it happened (LGPD retention).
ALTER TABLE "employees"
  ADD CONSTRAINT employees_status_deactivated_ck
  CHECK ((status <> 'inactive') OR (deactivated_at IS NOT NULL));
--> statement-breakpoint

-- Audit metadata must be a JSON object, never a bare value: keeps queries
-- predictable and discourages dumping raw payloads that could carry PII.
ALTER TABLE "audit_log"
  ADD CONSTRAINT audit_log_metadata_object_ck
  CHECK (jsonb_typeof(metadata) = 'object');
