CREATE TABLE "meta_lead_forms" (
	"form_id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"page_name" text,
	"name" text,
	"status" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"polled_through" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"leads_listed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_poll_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_result" jsonb,
	"last_error" text
);

--> statement-breakpoint
-- Ids, form names and counters only: readable by the read-only role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON TABLE "meta_lead_forms" TO wings_ro;
    GRANT SELECT ON TABLE "meta_poll_state" TO wings_ro;
  END IF;
END $$;
