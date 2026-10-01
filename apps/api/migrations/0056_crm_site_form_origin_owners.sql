ALTER TABLE "lead_source_rules" ADD COLUMN "site_form_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_source_rules" ADD COLUMN "deal_source" text;--> statement-breakpoint
ALTER TABLE "rd_user_map" ADD COLUMN "departed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_projects" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
-- Eric, 01/10/2026: this RD CRM user (a former seller) left the company long
-- ago; their deals count as "dono inativo". Only the RD user id is kept here;
-- the import fills the name. Nothing is reassigned.
INSERT INTO "rd_user_map" ("rd_user_id", "rd_name", "rd_active", "departed_at")
VALUES ('69ef68ab1ca7400013f89513', '(usuário do RD)', true, now())
ON CONFLICT ("rd_user_id") DO UPDATE SET "departed_at" = coalesce("rd_user_map"."departed_at", now());
