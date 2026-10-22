CREATE TABLE "wa_numbers" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number_id" text NOT NULL,
	"waba_id" text NOT NULL,
	"business_id" text,
	"display_phone" text,
	"verified_name" text,
	"owner_employee_id" uuid NOT NULL,
	"token_enc" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"connected_by" uuid,
	"connected_at" timestamp with time zone NOT NULL,
	"disconnect_reason" text,
	"disconnected_at" timestamp with time zone,
	"webhooks_subscribed" boolean DEFAULT false NOT NULL,
	"contacts_sync" text,
	"contacts_sync_request" text,
	"history_sync" text,
	"history_sync_request" text,
	"history_progress" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD CONSTRAINT "wa_numbers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD CONSTRAINT "wa_numbers_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_numbers" ADD CONSTRAINT "wa_numbers_connected_by_employees_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_numbers_phone_number_uq" ON "wa_numbers" USING btree ("tenant_id","phone_number_id");--> statement-breakpoint
CREATE INDEX "wa_numbers_waba_idx" ON "wa_numbers" USING btree ("waba_id");