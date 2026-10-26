CREATE TABLE "ad_audit_findings" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ad_account_id" uuid,
	"check" text NOT NULL,
	"platform" text,
	"status" text NOT NULL,
	"impact" text NOT NULL,
	"confidence" text NOT NULL,
	"effort" text NOT NULL,
	"priority" real NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"recommendation" text DEFAULT '' NOT NULL,
	"entity_level" text,
	"entity_external_id" text,
	"entity_name" text,
	"action" jsonb,
	"state" text DEFAULT 'open' NOT NULL,
	"change_request_id" uuid,
	"acted_by" uuid,
	"acted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_audit_runs" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"days" integer NOT NULL,
	"since" text NOT NULL,
	"until" text NOT NULL,
	"status" text NOT NULL,
	"counts" jsonb NOT NULL,
	"comparison" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_copy_drafts" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"package" jsonb,
	"refused" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"cost_source" text DEFAULT 'provider' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_audit_findings" ADD CONSTRAINT "ad_audit_findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audit_findings" ADD CONSTRAINT "ad_audit_findings_run_id_ad_audit_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ad_audit_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audit_findings" ADD CONSTRAINT "ad_audit_findings_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audit_findings" ADD CONSTRAINT "ad_audit_findings_change_request_id_ad_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."ad_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audit_findings" ADD CONSTRAINT "ad_audit_findings_acted_by_employees_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audit_runs" ADD CONSTRAINT "ad_audit_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_audit_runs" ADD CONSTRAINT "ad_audit_runs_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_copy_drafts" ADD CONSTRAINT "ad_copy_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_copy_drafts" ADD CONSTRAINT "ad_copy_drafts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_audit_findings_run_idx" ON "ad_audit_findings" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_audit_findings_change_request_uq" ON "ad_audit_findings" USING btree ("change_request_id") WHERE change_request_id is not null;--> statement-breakpoint
CREATE INDEX "ad_copy_drafts_employee_created_idx" ON "ad_copy_drafts" USING btree ("employee_id","created_at");--> statement-breakpoint
-- The read-only role behind `wings-staging-sql`; guarded, as in 0075.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "ad_audit_runs", "ad_audit_findings", "ad_copy_drafts" TO wings_ro;
  END IF;
END
$$;
