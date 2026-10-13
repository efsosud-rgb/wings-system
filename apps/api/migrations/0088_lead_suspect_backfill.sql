-- The suspect rule of `modules/leads/suspect.ts`, applied once to the leads
-- already in the database (the arrivals from now on are checked by the code):
-- the robot's e-mail (nome.sobrenome + 10 digits @gmail.com, the digits not
-- the phone's) and a capital's DDD, plus a burst (4 arrivals in 3 minutes on
-- the same page, or the same source when the page is unknown) or direct
-- traffic (no UTM, ad click, referring page or ad). Nothing is closed, lost or
-- deleted: each marked lead gets the reasons and a `lead.suspect_marked` event.
WITH base AS (
  SELECT
    l.id,
    l.entered_at,
    coalesce(l.landing_page, '~' || l.source) AS page,
    l.email ~ '^[a-z]+\.[a-z]+[0-9]{10}@gmail\.com$'
      AND position(substring(l.email FROM '([0-9]{10})@') IN coalesce(l.phone, '')) = 0
      AS robot_email,
    substring(l.phone FROM '^55(\d{2})\d{8,9}$')
      IN ('11', '21', '31', '41', '51', '61', '81', '85', '91') AS capital_ddd,
    coalesce(l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, l.gclid,
      l.fbclid, l.gbraid, l.wbraid, l.referrer, l.ad_platform, l.ad_campaign_external_id,
      l.ad_external_id, l.campaign_id) IS NULL AS direct_traffic
  FROM "leads" l
),
judged AS (
  SELECT
    b.id,
    b.direct_traffic,
    EXISTS (
      SELECT 1
      FROM base s
      WHERE s.page = b.page
        AND s.entered_at BETWEEN b.entered_at - interval '3 minutes' AND b.entered_at
        AND (
          SELECT count(*)
          FROM base c
          WHERE c.page = b.page
            AND c.entered_at BETWEEN s.entered_at AND s.entered_at + interval '3 minutes'
        ) >= 4
    ) AS burst
  FROM base b
  WHERE b.robot_email AND b.capital_ddd
),
marked AS (
  UPDATE "leads" l
  SET
    suspect_reasons = ARRAY['robot_email', 'capital_ddd']
      || CASE WHEN j.burst THEN ARRAY['burst'] ELSE ARRAY[]::text[] END
      || CASE WHEN j.direct_traffic THEN ARRAY['direct_traffic'] ELSE ARRAY[]::text[] END,
    suspect_at = now()
  FROM judged j
  WHERE l.id = j.id
    AND (j.burst OR j.direct_traffic)
    AND l.suspect_at IS NULL
    AND l.suspect_cleared_at IS NULL
  RETURNING l.id, l.suspect_reasons
)
INSERT INTO "lead_events" (lead_id, kind, detail)
SELECT m.id, 'lead.suspect_marked', jsonb_build_object('reasons', to_jsonb(m.suspect_reasons), 'via', 'migration 0088')
FROM marked m;
--> statement-breakpoint
-- Raptor's page is live again (the orchestrator's list of 13/10): it was dated
-- as switched off in RD on 02/10, which the landing-page list still showed.
UPDATE "lead_source_rules"
SET rd_unpublished_on = NULL
WHERE kind = 'landing_page' AND pattern = 'raptor' AND rd_unpublished_on IS NOT NULL;
--> statement-breakpoint
-- The suspect mark joins the read-only view (columns appended, so the view is replaced in place).
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
  ) > 0 AS email_digits_in_phone,
  l.suspect_reasons,
  l.suspect_at,
  l.suspect_cleared_at
FROM "leads" l;
--> statement-breakpoint
-- Leads das Campanhas without the person (no name, company, contact or owner name).
CREATE OR REPLACE VIEW "campaign_leads_analysis" AS
SELECT
  c.id,
  c.rd_deal_id,
  c.lead_id,
  c.entered_at,
  c.pipeline,
  c.stage,
  c.stage_order,
  c.win,
  c.closed_at,
  c.is_test,
  c.rd_source_label,
  c.rd_campaign_label,
  c.utm_source,
  c.utm_medium,
  c.utm_campaign,
  c.utm_content,
  c.utm_checked_at,
  c.platform,
  c.campaign_id,
  c.ad_id,
  c.attribution,
  c.unattributed_reason,
  c.first_seen_at,
  c.fetched_at
FROM "campaign_leads" c;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "lead_origin_analysis" TO wings_ro;
    GRANT SELECT ON TABLE "campaign_leads_analysis" TO wings_ro;
  END IF;
END
$$;
