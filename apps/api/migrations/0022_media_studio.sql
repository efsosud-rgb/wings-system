CREATE TYPE "public"."media_generation_status" AS ENUM('estimated', 'running', 'saving', 'succeeded', 'failed', 'refused', 'unknown', 'timed_out');--> statement-breakpoint
ALTER TYPE "public"."agent_proposal_kind" ADD VALUE 'generation';--> statement-breakpoint
CREATE TABLE "media_credit_ledger" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"event" text NOT NULL,
	"operation" text NOT NULL,
	"model" text,
	"prompt" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credits_estimated" integer NOT NULL,
	"credits_charged" integer,
	"credits_delta" integer DEFAULT 0 NOT NULL,
	"external_generation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_generations" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by" uuid NOT NULL,
	"operation" text NOT NULL,
	"kind" "media_kind" NOT NULL,
	"model" text,
	"prompt" text,
	"request" jsonb NOT NULL,
	"price_args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credits_estimated" integer NOT NULL,
	"credits_charged" integer,
	"status" "media_generation_status" DEFAULT 'estimated' NOT NULL,
	"detail" text,
	"external_generation_id" text,
	"source_asset_id" uuid,
	"proposal_id" uuid,
	"estimate_expires_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_public_links" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"generation_id" uuid,
	"issued_by" uuid NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD COLUMN "scope" text DEFAULT 'traffic' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ADD CONSTRAINT "media_credit_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ADD CONSTRAINT "media_credit_ledger_generation_id_media_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."media_generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ADD CONSTRAINT "media_credit_ledger_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_public_links" ADD CONSTRAINT "media_public_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_public_links" ADD CONSTRAINT "media_public_links_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_public_links" ADD CONSTRAINT "media_public_links_generation_id_media_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."media_generations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_public_links" ADD CONSTRAINT "media_public_links_issued_by_employees_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_credit_ledger_employee_idx" ON "media_credit_ledger" USING btree ("employee_id","created_at");--> statement-breakpoint
CREATE INDEX "media_credit_ledger_created_idx" ON "media_credit_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "media_generations_requester_idx" ON "media_generations" USING btree ("requested_by","created_at");--> statement-breakpoint
CREATE INDEX "media_generations_status_idx" ON "media_generations" USING btree ("status");