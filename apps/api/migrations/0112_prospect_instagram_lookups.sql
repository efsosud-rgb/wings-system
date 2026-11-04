CREATE TABLE "prospect_instagram_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"place_id" text NOT NULL,
	"outcome" text NOT NULL,
	"username" text,
	"source" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "prospect_instagram_lookups_outcome_check" CHECK ("prospect_instagram_lookups"."outcome" in ('found', 'none') and ("prospect_instagram_lookups"."outcome" = 'none' or "prospect_instagram_lookups"."username" is not null))
);
--> statement-breakpoint
ALTER TABLE "prospect_instagram_lookups" ADD CONSTRAINT "prospect_instagram_lookups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_instagram_lookups_place_uq" ON "prospect_instagram_lookups" USING btree ("tenant_id","place_id");--> statement-breakpoint
CREATE INDEX "prospect_instagram_lookups_expires_idx" ON "prospect_instagram_lookups" USING btree ("expires_at");