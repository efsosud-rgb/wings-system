ALTER TABLE "crm_email_outbox" ADD COLUMN "to_email" text;--> statement-breakpoint
ALTER TABLE "crm_email_outbox" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;