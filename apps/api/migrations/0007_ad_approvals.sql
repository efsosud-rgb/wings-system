CREATE TYPE "public"."ad_approval_status" AS ENUM('pending', 'escalated', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."ad_approval_trigger" AS ENUM('policy_always', 'above_single_threshold', 'cumulative_24h');--> statement-breakpoint
CREATE TABLE "ad_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_request_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"trigger" "ad_approval_trigger" NOT NULL,
	"status" "ad_approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"requested_by_agent" boolean DEFAULT false NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"escalated_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_reason" text,
	"payload_hash" text NOT NULL,
	"notified_at" timestamp with time zone,
	"notification_error" text,
	CONSTRAINT "ad_approval_requests_change_request_id_unique" UNIQUE("change_request_id")
);
--> statement-breakpoint
ALTER TABLE "ad_change_requests" ADD COLUMN "auto_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_approval_requests" ADD CONSTRAINT "ad_approval_requests_change_request_id_ad_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."ad_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_approval_requests" ADD CONSTRAINT "ad_approval_requests_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_approval_requests" ADD CONSTRAINT "ad_approval_requests_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_approval_requests" ADD CONSTRAINT "ad_approval_requests_decided_by_employees_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_approval_requests_status_idx" ON "ad_approval_requests" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "ad_approval_requests_account_idx" ON "ad_approval_requests" USING btree ("ad_account_id");