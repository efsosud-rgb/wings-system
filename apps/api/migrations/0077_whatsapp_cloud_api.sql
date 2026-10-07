CREATE TABLE "wa_contacts" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"wa_id" text,
	"profile_name" text,
	"last_inbound_at" timestamp with time zone,
	"opt_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_conversations" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"referral" jsonb,
	"origin_code" text,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_messages" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wamid" text,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"lead_id" uuid,
	"direction" text NOT NULL,
	"author" text NOT NULL,
	"employee_id" uuid,
	"kind" text NOT NULL,
	"text" text,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text,
	"error_code" integer,
	"error_title" text,
	"wa_timestamp" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_templates" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meta_id" text,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text,
	"status" text NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_webhook_events" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wa_contacts" ADD CONSTRAINT "wa_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_contact_id_wa_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."wa_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_contact_id_wa_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."wa_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_templates" ADD CONSTRAINT "wa_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_webhook_events" ADD CONSTRAINT "wa_webhook_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_contacts_phone_uq" ON "wa_contacts" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "wa_contacts_wa_id_idx" ON "wa_contacts" USING btree ("wa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_conversations_contact_lead_uq" ON "wa_conversations" USING btree ("contact_id","lead_id") WHERE "wa_conversations"."lead_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_conversations_contact_unmatched_uq" ON "wa_conversations" USING btree ("contact_id") WHERE "wa_conversations"."lead_id" is null;--> statement-breakpoint
CREATE INDEX "wa_conversations_lead_idx" ON "wa_conversations" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "wa_conversations_last_idx" ON "wa_conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_messages_wamid_uq" ON "wa_messages" USING btree ("wamid") WHERE "wa_messages"."wamid" is not null;--> statement-breakpoint
CREATE INDEX "wa_messages_conversation_idx" ON "wa_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "wa_messages_lead_idx" ON "wa_messages" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_templates_name_lang_uq" ON "wa_templates" USING btree ("tenant_id","name","language");--> statement-breakpoint
CREATE INDEX "wa_webhook_events_status_idx" ON "wa_webhook_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "wa_webhook_events_received_idx" ON "wa_webhook_events" USING btree ("received_at");