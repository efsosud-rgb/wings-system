-- Closing the loop (docs/ads/fechar-ciclo.md): the outbox and the stage → event mapping hold ids,
-- codes and counts only, so `wings-staging-sql` may read them. `lead_ad_identifiers` is left out
-- on purpose (click ids and Meta's lead id are pseudonymous personal data). Guarded: the role does
-- not exist on production, locally or in the throwaway test databases.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "ad_conversion_sends" TO wings_ro;
    GRANT SELECT ON TABLE "ad_conversion_stage_events" TO wings_ro;
  END IF;
END
$$;
