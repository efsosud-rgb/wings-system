ALTER TABLE "leads" ADD COLUMN "entered_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "entered_at_source" text DEFAULT 'received' NOT NULL;--> statement-breakpoint
-- Every lead that exists keeps the date it already had. An RD CRM lead was born with the RD deal's
-- own creation date in created_at (the import passes it), so that one is the source's date; every
-- other lead has no known source date here and stays 'received' until the filling script (which
-- reads Meta's created_time and the RD conversion date) says otherwise.
UPDATE "leads" SET "entered_at" = "created_at", "entered_at_source" = CASE WHEN "source" = 'rd_crm' THEN 'rd_deal_created' ELSE 'received' END;--> statement-breakpoint
CREATE INDEX "leads_entered_idx" ON "leads" USING btree ("entered_at");
