CREATE TABLE "wa_message_files" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"mime_type" text,
	"byte_size" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stored_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wa_message_files" ADD CONSTRAINT "wa_message_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_message_files" ADD CONSTRAINT "wa_message_files_message_id_wa_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."wa_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_message_files_message_uq" ON "wa_message_files" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "wa_message_files_due_idx" ON "wa_message_files" USING btree ("next_attempt_at") WHERE "wa_message_files"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "wa_message_files_orphan_idx" ON "wa_message_files" USING btree ("id") WHERE "wa_message_files"."message_id" is null;--> statement-breakpoint
CREATE INDEX "wa_messages_media_idx" ON "wa_messages" USING btree ("created_at") WHERE ("wa_messages"."content" -> 'media' ->> 'id') is not null;--> statement-breakpoint
-- What `wings-staging-sql` may see of the file queue: ids, states, types and sizes, never the storage key (guarded, as in 0075).
CREATE OR REPLACE VIEW "wa_message_files_analysis" AS
SELECT f.id, f.message_id, f.status, f.mime_type, f.byte_size, f.attempts, f.last_error, f.next_attempt_at,
       f.created_at, f.stored_at
FROM wa_message_files f;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "wa_message_files_analysis" TO wings_ro;
  END IF;
END
$$;
