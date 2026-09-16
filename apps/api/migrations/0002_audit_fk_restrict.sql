-- Employees referenced by the audit trail can never be hard-deleted.
--
-- The original foreign keys used ON DELETE SET NULL, which the append-only
-- trigger on audit_log rejects — deleting an employee failed with a confusing
-- "table audit_log is append-only: UPDATE is not allowed".
--
-- RESTRICT states the real rule: the accountability trail keeps pointing at the
-- employee, and LGPD erasure is done by anonymising the employee record (see
-- docs/lgpd.md), never by deleting rows.

ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_actor_employee_id_employees_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT IF EXISTS "audit_log_target_employee_id_employees_id_fk";
--> statement-breakpoint

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_actor_employee_id_employees_id_fk"
  FOREIGN KEY ("actor_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_target_employee_id_employees_id_fk"
  FOREIGN KEY ("target_employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT;
