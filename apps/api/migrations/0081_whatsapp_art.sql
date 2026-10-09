CREATE TABLE "wa_media_uploads" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drive_file_id" uuid NOT NULL,
	"file_version" integer NOT NULL,
	"phone_number_id" text NOT NULL,
	"media_id" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"invalid_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "article" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "whatsapp_art_file_id" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "whatsapp_art_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_media_uploads" ADD CONSTRAINT "wa_media_uploads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_media_uploads" ADD CONSTRAINT "wa_media_uploads_drive_file_id_drive_files_id_fk" FOREIGN KEY ("drive_file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_media_uploads_file_number_uq" ON "wa_media_uploads" USING btree ("tenant_id","drive_file_id","phone_number_id");--> statement-breakpoint
CREATE INDEX "wa_media_uploads_media_idx" ON "wa_media_uploads" USING btree ("media_id");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_whatsapp_art_file_id_drive_files_id_fk" FOREIGN KEY ("whatsapp_art_file_id") REFERENCES "public"."drive_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_article_check" CHECK ("article" IS NULL OR "article" IN ('o', 'a'));--> statement-breakpoint
-- Only ids and dates (no person, no text): readable by the read-only role, to check on staging.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "wa_media_uploads" TO wings_ro;
  END IF;
END $$;
