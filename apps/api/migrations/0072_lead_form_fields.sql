ALTER TABLE "leads" ADD COLUMN "instagram" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "company_cnpj" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "field_checks" jsonb DEFAULT '{}'::jsonb NOT NULL;