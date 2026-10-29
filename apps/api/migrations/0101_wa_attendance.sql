CREATE TABLE "wa_conversation_events" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_employee_id" uuid,
	"to_employee_id" uuid,
	"queue" text,
	"reason" text,
	"actor_employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "sofia_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "assignee_employee_id" uuid;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "queue" text;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "replying_employee_id" uuid;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD COLUMN "replying_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_settings" ADD COLUMN "assignment_mode" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_conversation_events" ADD CONSTRAINT "wa_conversation_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_conversation_events" ADD CONSTRAINT "wa_conversation_events_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_conversation_events" ADD CONSTRAINT "wa_conversation_events_from_employee_id_employees_id_fk" FOREIGN KEY ("from_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_conversation_events" ADD CONSTRAINT "wa_conversation_events_to_employee_id_employees_id_fk" FOREIGN KEY ("to_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_conversation_events" ADD CONSTRAINT "wa_conversation_events_actor_employee_id_employees_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_conversation_events_conversation_idx" ON "wa_conversation_events" USING btree ("conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_assignee_employee_id_employees_id_fk" FOREIGN KEY ("assignee_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_replying_employee_id_employees_id_fk" FOREIGN KEY ("replying_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wa_conversations_assignee_idx" ON "wa_conversations" USING btree ("assignee_employee_id");