ALTER TABLE "lead_source_rules" ADD COLUMN "rd_deal_intake" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Eric, 01/10/2026: the pages found without a rule by the landing-page audit
-- make no RD deal until he decides (RD's own automation may already make one).
-- Covers rules a person already made on the screen; the seed makes the rest off.
UPDATE "lead_source_rules" SET "rd_deal_intake" = false
WHERE "kind" = 'landing_page' AND "pattern" IN ('mister-russo', 'familia-k', 'wash-club');
