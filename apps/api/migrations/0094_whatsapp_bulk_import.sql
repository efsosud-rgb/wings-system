CREATE TABLE "wa_bulk_import_items" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bulk_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"file_name" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"chat_text" text,
	"platform" text,
	"contact_name" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lead_id" uuid,
	"match" text,
	"candidates" integer DEFAULT 0 NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone,
	"last_at" timestamp with time zone,
	"state" text DEFAULT 'pendente' NOT NULL,
	"error" text,
	"batch_id" uuid,
	"drive_file_id" uuid
);
--> statement-breakpoint
CREATE TABLE "wa_bulk_imports" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'previa' NOT NULL,
	"our_name" text,
	"name_map" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"undone_by" uuid
);
--> statement-breakpoint
ALTER TABLE "wa_bulk_import_items" ADD CONSTRAINT "wa_bulk_import_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_bulk_import_items" ADD CONSTRAINT "wa_bulk_import_items_bulk_id_wa_bulk_imports_id_fk" FOREIGN KEY ("bulk_id") REFERENCES "public"."wa_bulk_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_bulk_import_items" ADD CONSTRAINT "wa_bulk_import_items_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_bulk_import_items" ADD CONSTRAINT "wa_bulk_import_items_batch_id_wa_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."wa_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_bulk_import_items" ADD CONSTRAINT "wa_bulk_import_items_drive_file_id_drive_files_id_fk" FOREIGN KEY ("drive_file_id") REFERENCES "public"."drive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_bulk_imports" ADD CONSTRAINT "wa_bulk_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_bulk_imports" ADD CONSTRAINT "wa_bulk_imports_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_bulk_imports" ADD CONSTRAINT "wa_bulk_imports_undone_by_employees_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_bulk_import_items_position_uq" ON "wa_bulk_import_items" USING btree ("bulk_id","position");