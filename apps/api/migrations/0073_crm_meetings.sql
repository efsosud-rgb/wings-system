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
	"send_approved_by" uuid,
	"send_approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"send_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD CONSTRAINT "crm_meetings_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD CONSTRAINT "crm_meetings_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD CONSTRAINT "crm_meetings_send_approved_by_employees_id_fk" FOREIGN KEY ("send_approved_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD CONSTRAINT "crm_meetings_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_meetings_lead_idx" ON "crm_meetings" USING btree ("lead_id","starts_at");--> statement-breakpoint
CREATE INDEX "crm_meetings_analysis_idx" ON "crm_meetings" USING btree ("analysis_state");
-- Meeting attendees, transcripts and analyses are personal data: no grant to wings_ro.
