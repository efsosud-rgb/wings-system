CREATE TYPE "public"."ad_campaign_status" AS ENUM('ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."ad_platform" AS ENUM('meta', 'google', 'tiktok');--> statement-breakpoint
CREATE TYPE "public"."ad_change_kind" AS ENUM('set_daily_budget', 'pause_campaign', 'resume_campaign');--> statement-breakpoint
CREATE TYPE "public"."ad_change_status" AS ENUM('pending_approval', 'approved', 'rejected', 'executing', 'executed', 'failed', 'unknown', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."ad_guardrail_event_kind" AS ENUM('cap_would_be_exceeded', 'usable_would_be_exceeded', 'kill_switch_engaged', 'kill_switch_released', 'reconciliation_stale', 'implausible_amount', 'unknown_execution_outcome', 'cap_change');--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"kill_switch_engaged" boolean DEFAULT false NOT NULL,
	"kill_switch_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "ad_campaign_status" DEFAULT 'PAUSED' NOT NULL,
	"daily_budget_cents" bigint DEFAULT 0 NOT NULL,
	"lifetime_budget_cents" bigint,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"budget_period_id" uuid NOT NULL,
	"kind" "ad_change_kind" NOT NULL,
	"from_value_cents" bigint,
	"to_value_cents" bigint,
	"exposure_delta_cents" bigint NOT NULL,
	"payload_hash" text NOT NULL,
	"status" "ad_change_status" DEFAULT 'pending_approval' NOT NULL,
	"requested_by" uuid,
	"requested_by_agent" boolean DEFAULT false NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"escalated_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"reservation_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_request_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"outcome" text,
	"platform_response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ad_executions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "ad_guardrail_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ad_account_id" uuid,
	"kind" "ad_guardrail_event_kind" NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_spend_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"campaign_id" uuid,
	"spend_date" date NOT NULL,
	"spend_cents" bigint NOT NULL,
	"as_of" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'platform' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_budget_cap_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"previous_cap_cents" bigint,
	"new_cap_cents" bigint NOT NULL,
	"usable_percent" bigint NOT NULL,
	"changed_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_budget_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"period_month" date NOT NULL,
	"cap_cents" bigint NOT NULL,
	"usable_cents" bigint NOT NULL,
	"committed_cents" bigint DEFAULT 0 NOT NULL,
	"spent_cents" bigint DEFAULT 0 NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_change_requests" ADD CONSTRAINT "ad_change_requests_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_change_requests" ADD CONSTRAINT "ad_change_requests_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_change_requests" ADD CONSTRAINT "ad_change_requests_budget_period_id_ad_budget_periods_id_fk" FOREIGN KEY ("budget_period_id") REFERENCES "public"."ad_budget_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_change_requests" ADD CONSTRAINT "ad_change_requests_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_change_requests" ADD CONSTRAINT "ad_change_requests_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_executions" ADD CONSTRAINT "ad_executions_change_request_id_ad_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."ad_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_guardrail_events" ADD CONSTRAINT "ad_guardrail_events_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend_snapshots" ADD CONSTRAINT "ad_spend_snapshots_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_spend_snapshots" ADD CONSTRAINT "ad_spend_snapshots_campaign_id_ad_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ad_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_budget_cap_history" ADD CONSTRAINT "ad_budget_cap_history_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_budget_cap_history" ADD CONSTRAINT "ad_budget_cap_history_changed_by_employees_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD CONSTRAINT "ad_budget_periods_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_platform_external_uq" ON "ad_accounts" USING btree ("platform","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaigns_account_external_uq" ON "ad_campaigns" USING btree ("ad_account_id","external_id");--> statement-breakpoint
CREATE INDEX "ad_change_requests_account_status_idx" ON "ad_change_requests" USING btree ("ad_account_id","status");--> statement-breakpoint
CREATE INDEX "ad_change_requests_campaign_idx" ON "ad_change_requests" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "ad_guardrail_events_account_idx" ON "ad_guardrail_events" USING btree ("ad_account_id","created_at");--> statement-breakpoint
CREATE INDEX "ad_spend_snapshots_account_date_idx" ON "ad_spend_snapshots" USING btree ("ad_account_id","spend_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_budget_periods_account_month_uq" ON "ad_budget_periods" USING btree ("ad_account_id","period_month");