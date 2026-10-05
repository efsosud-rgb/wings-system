-- Rotation of Formatação (Eric, 05/10/2026): the funnel's rotation is the active people with the role
-- vendedor_formatacao (the new seller, Daniela). 0065 (already applied on staging) came out empty
-- there. Adds them ONLY when the funnel has no member at all; nobody already there is touched.
-- No one with that role -> a NOTICE in the log, never a failure.
DO $$
DECLARE
  added integer;
BEGIN
  IF EXISTS (SELECT 1 FROM "crm_distribution_members" WHERE "pipeline" = 'formatacao') THEN
    RAISE NOTICE '0069: rotation of formatacao already has members, nothing changed';
    RETURN;
  END IF;
  INSERT INTO "crm_distribution_members" ("pipeline", "employee_id", "active")
  SELECT 'formatacao', e.id, true
  FROM "employees" e JOIN "roles" r ON r.id = e.role_id
  WHERE e.status = 'active' AND r.key = 'vendedor_formatacao';
  GET DIAGNOSTICS added = ROW_COUNT;
  IF added = 0 THEN
    RAISE NOTICE '0069: no active vendedor_formatacao found, rotation of formatacao left empty';
  ELSE
    RAISE NOTICE '0069: % vendedor_formatacao added to the rotation of formatacao', added;
  END IF;
END $$;
