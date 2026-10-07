CREATE TABLE "google_workspace_connections" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"google_email" text,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"access_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"pending" jsonb,
	"last_error" text,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_email_outbox" ADD COLUMN "from_email" text;--> statement-breakpoint
ALTER TABLE "crm_email_outbox" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "crm_email_outbox" ADD COLUMN "gmail_message_id" text;--> statement-breakpoint
ALTER TABLE "crm_email_outbox" ADD COLUMN "gmail_thread_id" text;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD COLUMN "google_calendar_id" text;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD COLUMN "google_html_link" text;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD COLUMN "google_sync" text;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD COLUMN "google_sync_error" text;--> statement-breakpoint
ALTER TABLE "crm_meetings" ADD COLUMN "google_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "google_workspace_connections" ADD CONSTRAINT "google_workspace_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_workspace_connections" ADD CONSTRAINT "google_workspace_connections_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_workspace_connections_employee_uq" ON "google_workspace_connections" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "google_workspace_connections_state_idx" ON "google_workspace_connections" USING btree ("state");
-- Tokens and addresses: the read-only role gets nothing from the connections table (not
-- granted) and the e-mail outbox was already outside its reach (0066).
