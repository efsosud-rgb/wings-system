CREATE TABLE "crm_email_inbound" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"mailbox_employee_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text NOT NULL,
	"message_id" text,
	"outbox_id" uuid,
	"matched_by" text NOT NULL,
	"from_email" text NOT NULL,
	"from_name" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_workspace_connections" ADD COLUMN "gmail_history_id" text;--> statement-breakpoint
ALTER TABLE "google_workspace_connections" ADD COLUMN "gmail_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "google_workspace_connections" ADD COLUMN "gmail_read_error" text;--> statement-breakpoint
ALTER TABLE "crm_email_inbound" ADD CONSTRAINT "crm_email_inbound_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_email_inbound" ADD CONSTRAINT "crm_email_inbound_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_email_inbound" ADD CONSTRAINT "crm_email_inbound_mailbox_employee_id_employees_id_fk" FOREIGN KEY ("mailbox_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_email_inbound" ADD CONSTRAINT "crm_email_inbound_outbox_id_crm_email_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."crm_email_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_email_inbound_gmail_uq" ON "crm_email_inbound" USING btree ("mailbox_employee_id","gmail_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_email_inbound_message_uq" ON "crm_email_inbound" USING btree ("lead_id","message_id") WHERE message_id is not null;--> statement-breakpoint
CREATE INDEX "crm_email_inbound_lead_idx" ON "crm_email_inbound" USING btree ("lead_id","received_at");