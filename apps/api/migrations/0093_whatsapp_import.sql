CREATE TABLE "wa_import_batches" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"drive_file_id" uuid,
	"platform" text NOT NULL,
	"message_count" integer NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"imported_by" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid
);
--> statement-breakpoint
ALTER TABLE "wa_messages" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD COLUMN "import_hash" text;--> statement-breakpoint
ALTER TABLE "wa_import_batches" ADD CONSTRAINT "wa_import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_import_batches" ADD CONSTRAINT "wa_import_batches_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_import_batches" ADD CONSTRAINT "wa_import_batches_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_import_batches" ADD CONSTRAINT "wa_import_batches_drive_file_id_drive_files_id_fk" FOREIGN KEY ("drive_file_id") REFERENCES "public"."drive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_import_batches" ADD CONSTRAINT "wa_import_batches_imported_by_employees_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_import_batches" ADD CONSTRAINT "wa_import_batches_undone_by_employees_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_import_batches_lead_idx" ON "wa_import_batches" USING btree ("lead_id","imported_at");--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_import_batch_id_wa_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."wa_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_messages_import_hash_uq" ON "wa_messages" USING btree ("lead_id","import_hash") WHERE "wa_messages"."import_hash" is not null;--> statement-breakpoint
CREATE INDEX "wa_messages_import_batch_idx" ON "wa_messages" USING btree ("import_batch_id") WHERE "wa_messages"."import_batch_id" is not null;--> statement-breakpoint
-- What `wings-staging-sql` may see of the imports: ids, counts and times, never a name or a text (guarded, as in 0075).
CREATE OR REPLACE VIEW "wa_imports_analysis" AS
SELECT b.id, b.lead_id, b.conversation_id, b.drive_file_id, b.platform, b.message_count, b.first_at, b.last_at,
       b.imported_by, b.imported_at, b.undone_at, b.undone_by,
       (SELECT count(*)::int FROM wa_messages m WHERE m.import_batch_id = b.id AND m.direction = 'in') AS messages_in,
       (SELECT count(*)::int FROM wa_messages m WHERE m.import_batch_id = b.id AND m.direction = 'out') AS messages_out
FROM wa_import_batches b;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "wa_imports_analysis" TO wings_ro;
  END IF;
END
$$;
