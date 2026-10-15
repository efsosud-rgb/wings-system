ALTER TABLE "leads" ADD COLUMN "instagram_check_status" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "instagram_check_source" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "instagram_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "instagram_check_detail" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "instagram_verdict" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "instagram_manual" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "instagram_manual_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "instagram_manual_by" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "instagram_verdict_effective" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "form_ref" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "form_ref_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_instagram_manual_by_employees_id_fk" FOREIGN KEY ("instagram_manual_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_form_ref_uq" ON "leads" USING btree ("form_ref") WHERE "leads"."form_ref" is not null;--> statement-breakpoint
CREATE INDEX "leads_instagram_verdict_idx" ON "leads" USING btree ("instagram_verdict_effective") WHERE "leads"."instagram_verdict_effective" is not null;
--> statement-breakpoint
-- The Instagram check without the person (docs/leads/instagram.md): the status, the source, when
-- it ran and the verdict (suspeito | falso, with the seller's correction applied), never the
-- handle. Suspect and fake leads by page and by campaign read this view.
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
  l.suspect_cleared_at,
  l.instagram_check_status,
  l.instagram_check_source,
  l.instagram_checked_at,
  l.instagram_verdict,
  l.instagram_manual,
  l.instagram_verdict_effective
FROM "leads" l;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "lead_origin_analysis" TO wings_ro;
  END IF;
END
$$;
