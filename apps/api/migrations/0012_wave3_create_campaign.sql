ALTER TYPE "public"."ad_change_kind" ADD VALUE 'create_campaign';--> statement-breakpoint
CREATE TABLE "ad_campaign_drafts" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"objective" text NOT NULL,
	"daily_budget_cents" bigint NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"start_paused" boolean DEFAULT true NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"campaign_id" uuid
);
--> statement-breakpoint
ALTER TABLE "ad_change_requests" ALTER COLUMN "campaign_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_change_requests" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "ad_campaign_drafts" ADD CONSTRAINT "ad_campaign_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_drafts" ADD CONSTRAINT "ad_campaign_drafts_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_drafts" ADD CONSTRAINT "ad_campaign_drafts_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaign_drafts" ADD CONSTRAINT "ad_campaign_drafts_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_campaign_drafts_account_idx" ON "ad_campaign_drafts" USING btree ("ad_account_id","created_at");--> statement-breakpoint
ALTER TABLE "ad_change_requests" ADD CONSTRAINT "ad_change_requests_draft_id_ad_campaign_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."ad_campaign_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A change always says what it is about: an existing campaign, or the draft of
-- one to be created. Written without naming the new enum value, which Postgres
-- refuses to use in the transaction that added it.
ALTER TABLE "ad_change_requests" ADD CONSTRAINT "ad_change_requests_target_ck"
  CHECK (campaign_id IS NOT NULL OR draft_id IS NOT NULL);
