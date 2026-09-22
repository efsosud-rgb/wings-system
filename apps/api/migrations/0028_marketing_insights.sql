CREATE TYPE "public"."insight_run_kind" AS ENUM('insights', 'campaign_suggestions');--> statement-breakpoint
CREATE TYPE "public"."insight_run_status" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."insight_run_trigger" AS ENUM('schedule', 'manual');--> statement-breakpoint
CREATE TYPE "public"."marketing_insight_status" AS ENUM('open', 'seen', 'requested', 'refused');--> statement-breakpoint
CREATE TYPE "public"."marketing_suggestion_status" AS ENUM('open', 'applied', 'dismissed');--> statement-breakpoint
ALTER TYPE "public"."ad_breakdown_kind" ADD VALUE 'device';--> statement-breakpoint
CREATE TABLE "marketing_campaign_suggestions" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "marketing_suggestion_status" DEFAULT 'open' NOT NULL,
	"acted_by" uuid,
	"acted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_cpl_targets" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"objective_kind" text NOT NULL,
	"target_cents" bigint,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_cpl_targets_tenant_id_objective_kind_pk" PRIMARY KEY("tenant_id","objective_kind")
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"since" date,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"site" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "marketing_insight_runs" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "insight_run_kind" NOT NULL,
	"trigger" "insight_run_trigger" NOT NULL,
	"week_key" text,
	"status" "insight_run_status" DEFAULT 'running' NOT NULL,
	"requested_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"cost_source" text,
	"consulted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diagnostics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"produced" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "marketing_insights" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"campaign_id" uuid,
	"campaign_external_id" text,
	"status" "marketing_insight_status" DEFAULT 'open' NOT NULL,
	"acted_by" uuid,
	"acted_at" timestamp with time zone,
	"change_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_blog_posts" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"wordpress_post_id" bigint NOT NULL,
	"title" text NOT NULL,
	"slug" text DEFAULT '' NOT NULL,
	"link" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"modified_at" timestamp with time zone,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_blog_posts_tenant_id_wordpress_post_id_pk" PRIMARY KEY("tenant_id","wordpress_post_id")
);
--> statement-breakpoint
ALTER TABLE "ad_account_daily" ADD COLUMN "conversion_sources" jsonb;--> statement-breakpoint
ALTER TABLE "marketing_campaign_suggestions" ADD CONSTRAINT "marketing_campaign_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_campaign_suggestions" ADD CONSTRAINT "marketing_campaign_suggestions_run_id_marketing_insight_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."marketing_insight_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_campaign_suggestions" ADD CONSTRAINT "marketing_campaign_suggestions_acted_by_employees_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_cpl_targets" ADD CONSTRAINT "marketing_cpl_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_cpl_targets" ADD CONSTRAINT "marketing_cpl_targets_confirmed_by_employees_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_insight_runs" ADD CONSTRAINT "marketing_insight_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_insight_runs" ADD CONSTRAINT "marketing_insight_runs_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_insights" ADD CONSTRAINT "marketing_insights_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_insights" ADD CONSTRAINT "marketing_insights_run_id_marketing_insight_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."marketing_insight_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_insights" ADD CONSTRAINT "marketing_insights_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_insights" ADD CONSTRAINT "marketing_insights_acted_by_employees_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_insights" ADD CONSTRAINT "marketing_insights_change_request_id_ad_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."ad_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_blog_posts" ADD CONSTRAINT "site_blog_posts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketing_campaign_suggestions_status_idx" ON "marketing_campaign_suggestions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ingest_runs_started_idx" ON "ingest_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "marketing_insight_runs_kind_started_idx" ON "marketing_insight_runs" USING btree ("kind","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_insight_runs_schedule_week_uq" ON "marketing_insight_runs" USING btree ("kind","week_key") WHERE trigger = 'schedule';--> statement-breakpoint
CREATE INDEX "marketing_insights_status_created_idx" ON "marketing_insights" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "marketing_insights_run_idx" ON "marketing_insights" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "site_blog_posts_published_idx" ON "site_blog_posts" USING btree ("published_at");