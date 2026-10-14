CREATE TABLE "lead_triage_queue" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid,
	"conversation_id" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "lead_triage_queue_one_target" CHECK (num_nonnulls("lead_triage_queue"."lead_id", "lead_triage_queue"."conversation_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "lead_triage_queue" ADD CONSTRAINT "lead_triage_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_triage_queue" ADD CONSTRAINT "lead_triage_queue_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_triage_queue" ADD CONSTRAINT "lead_triage_queue_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_triage_queue_lead_uq" ON "lead_triage_queue" USING btree ("lead_id") WHERE "lead_triage_queue"."lead_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_triage_queue_conversation_uq" ON "lead_triage_queue" USING btree ("conversation_id") WHERE "lead_triage_queue"."conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "lead_triage_queue_open_idx" ON "lead_triage_queue" USING btree ("queued_at") WHERE "lead_triage_queue"."done_at" is null;--> statement-breakpoint
-- Ids and times only, no personal data: readable through `wings-staging-sql` to see what waits (guarded, as in 0075).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "lead_triage_queue" TO wings_ro;
  END IF;
END
$$;
