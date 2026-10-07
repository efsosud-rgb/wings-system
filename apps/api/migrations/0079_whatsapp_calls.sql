CREATE TABLE "wa_calls" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" text,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"lead_id" uuid,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"employee_id" uuid,
	"remote_sdp" text,
	"error_code" integer,
	"error_title" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"activity_logged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wa_contacts" ADD COLUMN "call_permission" text;--> statement-breakpoint
ALTER TABLE "wa_contacts" ADD COLUMN "call_permission_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_contacts" ADD COLUMN "call_permission_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_calls" ADD CONSTRAINT "wa_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_calls" ADD CONSTRAINT "wa_calls_contact_id_wa_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."wa_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_calls" ADD CONSTRAINT "wa_calls_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_calls" ADD CONSTRAINT "wa_calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_calls" ADD CONSTRAINT "wa_calls_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_calls_call_id_uq" ON "wa_calls" USING btree ("call_id") WHERE "wa_calls"."call_id" is not null;--> statement-breakpoint
CREATE INDEX "wa_calls_status_idx" ON "wa_calls" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "wa_calls_lead_idx" ON "wa_calls" USING btree ("lead_id","started_at");