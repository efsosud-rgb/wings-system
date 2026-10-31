CREATE TABLE "wa_voice_sends" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"employee_id" uuid NOT NULL,
	"key" uuid NOT NULL,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_voice_sends_employee_id_key_pk" PRIMARY KEY("employee_id","key")
);
--> statement-breakpoint
ALTER TABLE "wa_voice_sends" ADD CONSTRAINT "wa_voice_sends_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_voice_sends" ADD CONSTRAINT "wa_voice_sends_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_voice_sends" ADD CONSTRAINT "wa_voice_sends_message_id_wa_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."wa_messages"("id") ON DELETE cascade ON UPDATE no action;