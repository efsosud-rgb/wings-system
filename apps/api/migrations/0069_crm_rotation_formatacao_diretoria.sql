-- Rotation of Formatação (Eric, 05/10/2026): Thais works Formatação although she is Diretoria, and
-- 0065 (already applied on staging) only looked at the seller roles, so her rotation came out empty.
-- Adds her ONLY when the funnel has no member at all; nobody already there is touched. Matched by
-- first name among active staff of those roles; not found -> a NOTICE in the log, never a failure.
DO $$
DECLARE
  person uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "crm_distribution_members" WHERE "pipeline" = 'formatacao') THEN
    RAISE NOTICE '0069: rotation of formatacao already has members, nothing changed';
    RETURN;
  END IF;
  SELECT e.id INTO person
  FROM "employees" e JOIN "roles" r ON r.id = e.role_id
  WHERE e.status = 'active'
    AND r.key IN ('diretoria', 'vendedor_expansao', 'vendedor_formatacao', 'gerente_comercial')
    AND lower(split_part(e.full_name, ' ', 1)) IN ('thais', 'thaís')
  ORDER BY e.created_at
  LIMIT 1;
  IF person IS NULL THEN
    RAISE NOTICE '0069: no active employee named Thais found, rotation of formatacao left empty';
    RETURN;
  END IF;
  INSERT INTO "crm_distribution_members" ("pipeline", "employee_id", "active")
  VALUES ('formatacao', person, true);
  RAISE NOTICE '0069: Thais added to the rotation of formatacao';
END $$;
