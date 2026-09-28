CREATE TABLE "expansion_intake_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversion_key" text NOT NULL,
	"target" text NOT NULL,
	"outcome" text NOT NULL,
	"rd_deal_id" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expansion_intake_ledger_conversion_key_unique" UNIQUE("conversion_key")
);
--> statement-breakpoint
CREATE TABLE "expansion_landing_pages" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"identifier" text PRIMARY KEY NOT NULL,
	"brand" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expansion_landing_pages" ADD CONSTRAINT "expansion_landing_pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;