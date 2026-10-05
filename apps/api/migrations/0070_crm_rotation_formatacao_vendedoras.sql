-- Rotation of Formatação (Eric, 05/10/2026): only the active people with the role vendedor_formatacao
-- (the new seller, Daniela). 0069 had already run on staging with Thais (Diretoria); this one
-- leaves in the funnel's rotation ONLY active vendedor_formatacao people: removes the others (their
-- leads stay with them), adds who has the role and is not there yet (a paused member keeps their
-- pause). Idempotent. Nobody with the role -> the rotation ends up empty and the arrival safety
-- net warns Diretoria; never a failure. Expansão and Consultoria are not touched.
DO $$
DECLARE
  removed integer;
  added integer;
  remaining integer;
BEGIN
  DELETE FROM "crm_distribution_members" m
  WHERE m."pipeline" = 'formatacao'
    AND NOT EXISTS (
      SELECT 1 FROM "employees" e JOIN "roles" r ON r.id = e.role_id
      WHERE e.id = m."employee_id" AND e.status = 'active' AND r.key = 'vendedor_formatacao'
    );
  GET DIAGNOSTICS removed = ROW_COUNT;

  INSERT INTO "crm_distribution_members" ("pipeline", "employee_id", "active")
  SELECT 'formatacao', e.id, true
  FROM "employees" e JOIN "roles" r ON r.id = e.role_id
  WHERE e.status = 'active' AND r.key = 'vendedor_formatacao'
    AND NOT EXISTS (
      SELECT 1 FROM "crm_distribution_members" m
      WHERE m."pipeline" = 'formatacao' AND m."employee_id" = e.id
    );
  GET DIAGNOSTICS added = ROW_COUNT;

  SELECT count(*) INTO remaining FROM "crm_distribution_members" WHERE "pipeline" = 'formatacao';
  RAISE NOTICE '0070: formatacao rotation: % removed, % added, % in the rotation', removed, added, remaining;
  IF remaining = 0 THEN
    RAISE NOTICE '0070: no active vendedor_formatacao found, rotation of formatacao is empty (arrival safety net will warn Diretoria)';
  END IF;
END $$;
