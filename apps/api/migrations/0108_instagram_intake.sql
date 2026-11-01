CREATE TABLE "ig_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"igsid" text NOT NULL,
	"username" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_auto_reply_at" timestamp with time zone,
	"lead_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ig_private_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"comment_id" text NOT NULL,
	"opportunity_id" uuid,
	"ig_person_id" uuid,
	"trigger" text NOT NULL,
	"requested_by" uuid,
	"message_sha256" text,
	"status" text NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"graph_message_id" text,
	"last_error" text,
	"comment_created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ig_private_replies_status_check" CHECK ("ig_private_replies"."status" in ('sending', 'sent', 'failed', 'rate_limited', 'unknown')),
	CONSTRAINT "ig_private_replies_trigger_check" CHECK ("ig_private_replies"."trigger" in ('clique', 'automatico'))
);
--> statement-breakpoint
CREATE TABLE "ig_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"ig_account_id" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"opportunity_id" uuid,
	CONSTRAINT "ig_webhook_events_kind_check" CHECK ("ig_webhook_events"."kind" in ('comment', 'mention', 'message', 'echo', 'referral', 'other')),
	CONSTRAINT "ig_webhook_events_status_check" CHECK ("ig_webhook_events"."status" in ('pending', 'done', 'ignored', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "contact_opt_outs" DROP CONSTRAINT "contact_opt_outs_key_kind_check";--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD COLUMN "ig_person_id" uuid;--> statement-breakpoint
ALTER TABLE "ig_people" ADD CONSTRAINT "ig_people_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_people" ADD CONSTRAINT "ig_people_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_private_replies" ADD CONSTRAINT "ig_private_replies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_private_replies" ADD CONSTRAINT "ig_private_replies_opportunity_id_prospect_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."prospect_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_private_replies" ADD CONSTRAINT "ig_private_replies_ig_person_id_ig_people_id_fk" FOREIGN KEY ("ig_person_id") REFERENCES "public"."ig_people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_private_replies" ADD CONSTRAINT "ig_private_replies_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_webhook_events" ADD CONSTRAINT "ig_webhook_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_webhook_events" ADD CONSTRAINT "ig_webhook_events_opportunity_id_prospect_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."prospect_opportunities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ig_people_igsid_uq" ON "ig_people" USING btree ("tenant_id","igsid");--> statement-breakpoint
CREATE INDEX "ig_people_username_idx" ON "ig_people" USING btree ("tenant_id","username");--> statement-breakpoint
CREATE INDEX "ig_people_lead_idx" ON "ig_people" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "ig_people_seen_idx" ON "ig_people" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ig_private_replies_comment_uq" ON "ig_private_replies" USING btree ("tenant_id","comment_id");--> statement-breakpoint
CREATE INDEX "ig_private_replies_sent_idx" ON "ig_private_replies" USING btree ("tenant_id","sent_at");--> statement-breakpoint
CREATE INDEX "ig_private_replies_due_idx" ON "ig_private_replies" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ig_webhook_events_key_uq" ON "ig_webhook_events" USING btree ("tenant_id","event_key");--> statement-breakpoint
CREATE INDEX "ig_webhook_events_due_idx" ON "ig_webhook_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ig_webhook_events_received_idx" ON "ig_webhook_events" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_ig_person_id_ig_people_id_fk" FOREIGN KEY ("ig_person_id") REFERENCES "public"."ig_people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prospect_opportunities_person_idx" ON "prospect_opportunities" USING btree ("ig_person_id");--> statement-breakpoint
ALTER TABLE "contact_opt_outs" ADD CONSTRAINT "contact_opt_outs_key_kind_check" CHECK ("contact_opt_outs"."key_kind" in ('lead', 'phone', 'email', 'instagram_user', 'instagram_igsid', 'place_id', 'cnpj'));