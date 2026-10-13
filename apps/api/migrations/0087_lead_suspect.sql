ALTER TABLE "leads" ADD COLUMN "suspect_reasons" text[];--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "suspect_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "suspect_cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "suspect_cleared_by" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_suspect_cleared_by_employees_id_fk" FOREIGN KEY ("suspect_cleared_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;