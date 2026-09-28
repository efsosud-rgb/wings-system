CREATE TABLE "marketing_account_cpl_targets" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"objective_kind" text NOT NULL,
	"target_cents" bigint,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_account_cpl_targets_ad_account_id_objective_kind_pk" PRIMARY KEY("ad_account_id","objective_kind")
);
--> statement-breakpoint
ALTER TABLE "marketing_account_cpl_targets" ADD CONSTRAINT "marketing_account_cpl_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_account_cpl_targets" ADD CONSTRAINT "marketing_account_cpl_targets_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_account_cpl_targets" ADD CONSTRAINT "marketing_account_cpl_targets_confirmed_by_employees_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON marketing_account_cpl_targets TO wings_ro;
  END IF;
END
$$;
