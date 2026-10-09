ALTER TABLE "crm_notifications" ADD COLUMN "email_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_notifications" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm_notifications" ADD COLUMN "email_error" text;--> statement-breakpoint
CREATE INDEX "crm_notifications_email_pending_idx" ON "crm_notifications" USING btree ("created_at") WHERE email_state = 'pending';