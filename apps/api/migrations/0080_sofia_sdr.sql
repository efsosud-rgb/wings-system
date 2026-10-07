CREATE TABLE "wa_conversation_reads" (
	"conversation_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wa_conversation_reads_conversation_id_employee_id_pk" PRIMARY KEY("conversation_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "sofia_ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"reserved_micro_usd" bigint NOT NULL,
	"cost_micro_usd" bigint,
	"outcome" text,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sofia_settings" (
	"tenant_id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "attendance" text DEFAULT 'with_person' NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "state_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "segment" text;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "brand_client_id" uuid;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "sofia_facts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "sofia_misses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "sofia_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "sofia_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "sofia_read_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wa_conversation_reads" ADD CONSTRAINT "wa_conversation_reads_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_conversation_reads" ADD CONSTRAINT "wa_conversation_reads_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sofia_ai_runs" ADD CONSTRAINT "sofia_ai_runs_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sofia_settings" ADD CONSTRAINT "sofia_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sofia_settings" ADD CONSTRAINT "sofia_settings_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sofia_ai_runs_started_idx" ON "sofia_ai_runs" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_brand_client_id_clients_id_fk" FOREIGN KEY ("brand_client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_conversations_attendance_idx" ON "wa_conversations" USING btree ("attendance","last_message_at");--> statement-breakpoint
CREATE INDEX "wa_conversations_sofia_due_idx" ON "wa_conversations" USING btree ("sofia_due_at") WHERE "wa_conversations"."sofia_due_at" is not null;--> statement-breakpoint
-- Conversations from before Sofia: one with a deal stays with its seller; one without waits for a person.
UPDATE "wa_conversations" SET "attendance" = 'waiting_human', "reason" = 'sofia_desligada' WHERE "lead_id" IS NULL;--> statement-breakpoint
UPDATE "wa_conversations" SET "state_changed_at" = coalesce("last_message_at", "created_at");
