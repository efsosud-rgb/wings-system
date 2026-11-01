CREATE TABLE "contact_opt_outs" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"key_kind" text NOT NULL,
	"key_value" text NOT NULL,
	"reason" text,
	"origin" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_reason" text,
	CONSTRAINT "contact_opt_outs_channel_check" CHECK ("contact_opt_outs"."channel" in ('all', 'whatsapp', 'phone', 'email', 'instagram')),
	CONSTRAINT "contact_opt_outs_key_kind_check" CHECK ("contact_opt_outs"."key_kind" in ('lead', 'phone', 'email', 'instagram_user', 'place_id', 'cnpj')),
	CONSTRAINT "contact_opt_outs_origin_check" CHECK ("contact_opt_outs"."origin" in ('crm', 'whatsapp_palavra', 'prospeccao', 'instagram', 'importacao'))
);
--> statement-breakpoint
ALTER TABLE "contact_opt_outs" ADD CONSTRAINT "contact_opt_outs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_opt_outs" ADD CONSTRAINT "contact_opt_outs_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_opt_outs" ADD CONSTRAINT "contact_opt_outs_revoked_by_employees_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_opt_outs_active_uq" ON "contact_opt_outs" USING btree ("tenant_id","channel","key_kind","key_value") WHERE "contact_opt_outs"."revoked_at" is null;