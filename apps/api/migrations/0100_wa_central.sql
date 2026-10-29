DROP INDEX "wa_conversations_contact_lead_uq";--> statement-breakpoint
DROP INDEX "wa_conversations_contact_unmatched_uq";--> statement-breakpoint
ALTER TABLE "wa_numbers" ALTER COLUMN "phone_number_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_numbers" ALTER COLUMN "waba_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_numbers" ALTER COLUMN "token_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_numbers" ALTER COLUMN "status" SET DEFAULT 'registered';--> statement-breakpoint
ALTER TABLE "wa_numbers" ALTER COLUMN "connected_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "number_id" uuid;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "phone_contact_name" text;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "sector" text;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "eligibility" text DEFAULT 'a_confirmar' NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "eligibility_notes" text;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "checks" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_webhook_events" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_number_id_wa_numbers_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."wa_numbers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD CONSTRAINT "wa_numbers_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_conversations_number_contact_uq" ON "wa_conversations" USING btree ("number_id","contact_id") WHERE "wa_conversations"."number_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_numbers_phone_uq" ON "wa_numbers" USING btree ("tenant_id","phone") WHERE "wa_numbers"."phone" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_conversations_contact_lead_uq" ON "wa_conversations" USING btree ("contact_id","lead_id") WHERE "wa_conversations"."lead_id" is not null and "wa_conversations"."number_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_conversations_contact_unmatched_uq" ON "wa_conversations" USING btree ("contact_id") WHERE "wa_conversations"."lead_id" is null and "wa_conversations"."number_id" is null;