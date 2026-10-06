CREATE TABLE "crm_meeting_analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reserved_micro_usd" bigint NOT NULL,
	"cost_micro_usd" bigint,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "crm_meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"owner_employee_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"calendar" text DEFAULT 'vendedor' NOT NULL,
	"status" text DEFAULT 'agendada' NOT NULL,
	"meet_url" text,
	"google_event_id" text,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recording_state" text DEFAULT 'nenhuma' NOT NULL,
	"recording_key" text,
	"recording_file_id" uuid,
	"recording_content_type" text,
	"recording_size_bytes" bigint,
	"recording_duration_seconds" integer,
	"transcript_state" text DEFAULT 'nenhuma' NOT NULL,
	"transcript" jsonb,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"speakers_reason" text,
	"transcript_error" text,
	"transcript_job_id" uuid,
	"analysis_state" text DEFAULT 'nenhuma' NOT NULL,
	"analysis" jsonb,
	"analysis_cost_micro_usd" bigint,
	"analysis_reason" text,
	"analyzed_at" timestamp with time zone,
	"send_state" text DEFAULT 'nenhum' NOT NULL,
	"send_channel" text,
	"send_contact_role" text,
	"send_text" text,
	"send_destination_hash" text,
	"send_approved_by" uuid,
	"send_approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"send_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_meeting_analysis_runs" ADD CONSTRAINT "crm_meeting_analysis_runs_meeting_id_crm_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."crm_meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD CONSTRAINT "crm_meetings_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD CONSTRAINT "crm_meetings_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD CONSTRAINT "crm_meetings_send_approved_by_employees_id_fk" FOREIGN KEY ("send_approved_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD CONSTRAINT "crm_meetings_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_meeting_analysis_runs_started_idx" ON "crm_meeting_analysis_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "crm_meetings_lead_idx" ON "crm_meetings" USING btree ("lead_id","starts_at");--> statement-breakpoint
CREATE INDEX "crm_meetings_analysis_idx" ON "crm_meetings" USING btree ("analysis_state");
--> statement-breakpoint
-- The read-only role behind `wings-staging-sql` reads meetings through this
-- view only, like "leads_analysis" (0055) and "crm_activities_analysis" (0065):
-- states, times, sizes, costs and ids, never the title, the Meet link, the
-- attendees, the storage key, the transcript, the speakers, the analysis, the
-- text sent or the destination (personal data), and errors only as "there was
-- one". The view runs with its owner's rights, so the role needs no access to
-- "crm_meetings". The analysis runs hold ids, times and amounts only.
CREATE OR REPLACE VIEW "crm_meetings_analysis" AS
SELECT m.id, m.lead_id, m.owner_employee_id, m.starts_at, m.ends_at, m.calendar, m.status,
  (m.meet_url IS NOT NULL) AS has_meet_url,
  (m.google_event_id IS NOT NULL) AS has_google_event,
  CASE WHEN jsonb_typeof(m.attendees) = 'array' THEN jsonb_array_length(m.attendees) END AS attendees_count,
  m.recording_state, m.recording_content_type, m.recording_size_bytes, m.recording_duration_seconds,
  m.transcript_state, m.transcript_job_id,
  (m.transcript_error IS NOT NULL) AS has_transcript_error,
  CASE WHEN jsonb_typeof(m.speakers) = 'array' THEN jsonb_array_length(m.speakers) END AS speakers_count,
  m.analysis_state, m.analysis_cost_micro_usd, m.analyzed_at,
  m.send_state, m.send_channel, m.send_contact_role, m.send_approved_by, m.send_approved_at, m.sent_at,
  (m.send_error IS NOT NULL) AS has_send_error,
  m.created_by, m.created_at, m.updated_at
FROM "crm_meetings" m;--> statement-breakpoint
-- Guarded: the role does not exist on production, locally or in the throwaway test databases.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "crm_meetings_analysis" TO wings_ro;
    GRANT SELECT ON TABLE "crm_meeting_analysis_runs" TO wings_ro;
  END IF;
END $$;
