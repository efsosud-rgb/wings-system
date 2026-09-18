CREATE TABLE "marketing_audience_profiles" (
	"tenant_id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"ideal_customer_profile" text NOT NULL,
	"reach" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketing_audience_profiles" ADD CONSTRAINT "marketing_audience_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_audience_profiles" ADD CONSTRAINT "marketing_audience_profiles_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;