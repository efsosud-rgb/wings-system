-- Read-only views for checking where leads came from (the intake, the Meta
-- forms, the suspect check) without personal data, for `wings_ro` behind
-- `wings-staging-sql`. Like `leads_analysis` (0055): no name, e-mail, phone,
-- message, consent text, company or enrichment; the landing page and the
-- referrer lose their query string; form answers show their keys only. What
-- the suspect check reads of the contact shows as derived values: the phone's
-- DDD, whether the e-mail has the robot's shape and whether its digits are the
-- phone's. `meta_leadgen_events_analysis` leaves out the Graph payload and
-- `lead_events_analysis` the events' detail.
-- `lead_source_rules` holds page identifiers and brands, no person, so the
-- role reads the table itself. Guarded: the role does not exist on
-- production, locally or in the throwaway test databases.
CREATE OR REPLACE VIEW "lead_origin_analysis" AS
SELECT
  l.id,
  l.created_at,
  l.entered_at,
  l.entered_at_source,
  l.source,
  l.channel,
  l.pipeline,
  l.brand,
  l.client_id,
  l.client_mapped,
  l.status,
  l.stage,
  l.won,
  l.closed_at,
  l.rd_deal_id,
  l.rd_pipeline,
  l.import_batch_id,
  l.managed_by,
  regexp_replace(l.landing_page, '[?#].*$', '') AS landing_page,
  l.campaign_id,
  l.campaign_name,
  l.form_id,
  l.external_id,
  l.utm_source,
  l.utm_medium,
  l.utm_campaign,
  l.utm_content,
  l.utm_term,
  l.gclid IS NOT NULL AS has_gclid,
  l.fbclid IS NOT NULL AS has_fbclid,
  l.ad_platform,
  l.ad_campaign_external_id,
  l.ad_set_external_id,
  l.ad_external_id,
  regexp_replace(l.referrer, '[?#].*$', '') AS referrer,
  CASE
    WHEN jsonb_typeof(l.form_answers) = 'object'
      THEN ARRAY(SELECT jsonb_object_keys(l.form_answers))
  END AS form_answer_keys,
  l.name IS NOT NULL AS has_name,
  l.email IS NOT NULL AS has_email,
  l.phone IS NOT NULL AS has_phone,
  l.company_name IS NOT NULL AS has_company,
  l.city IS NOT NULL AS has_city,
  substring(l.phone FROM '^55(\d{2})\d{8,9}$') AS phone_ddd,
  l.email ~ '^[a-z]+\.[a-z]+[0-9]{10}@gmail\.com$' AS email_robot_shape,
  position(
    substring(l.email FROM '([0-9]{10})@') IN coalesce(l.phone, '')
  ) > 0 AS email_digits_in_phone
FROM "leads" l;
--> statement-breakpoint
CREATE OR REPLACE VIEW "meta_leadgen_events_analysis" AS
SELECT
  e.id,
  e.leadgen_id,
  e.form_id,
  e.page_id,
  e.ad_id,
  e.adgroup_id,
  e.created_time,
  e.received_at,
  e.status,
  e.attempts,
  e.last_error,
  e.processed_at,
  e.lead_id,
  e.lead_created,
  e.rd_deal_id,
  e.rd_outcome,
  e.payload ->> 'source' AS payload_source,
  e.payload ->> 'campaign_id' AS campaign_id
FROM "meta_leadgen_events" e;
--> statement-breakpoint
CREATE OR REPLACE VIEW "lead_events_analysis" AS
SELECT ev.id, ev.lead_id, ev.at, ev.kind, ev.actor_employee_id IS NOT NULL AS by_person
FROM "lead_events" ev;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "lead_origin_analysis" TO wings_ro;
    GRANT SELECT ON TABLE "meta_leadgen_events_analysis" TO wings_ro;
    GRANT SELECT ON TABLE "lead_events_analysis" TO wings_ro;
    GRANT SELECT ON TABLE "lead_source_rules" TO wings_ro;
  END IF;
END
$$;
