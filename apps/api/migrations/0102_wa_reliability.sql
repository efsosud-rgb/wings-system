CREATE TABLE "wa_number_templates" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number_id" uuid NOT NULL,
	"meta_id" text,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text,
	"status" text NOT NULL,
	"rejected_reason" text,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "connecting_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "token_renew_tried_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "token_renew_error" text;--> statement-breakpoint
ALTER TABLE "wa_number_templates" ADD CONSTRAINT "wa_number_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_number_templates" ADD CONSTRAINT "wa_number_templates_number_id_wa_numbers_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."wa_numbers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_number_templates_name_lang_uq" ON "wa_number_templates" USING btree ("number_id","name","language");