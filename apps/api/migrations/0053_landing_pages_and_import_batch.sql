ALTER TABLE "lead_source_rules" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "import_batch_id" text;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD CONSTRAINT "lead_source_rules_archived_by_employees_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_import_batch_idx" ON "leads" USING btree ("import_batch_id");