ALTER TABLE "ad_accounts" ADD COLUMN "spend_cap_reset" text;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD COLUMN "platform_spend_cap_cents" bigint;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD COLUMN "platform_amount_spent_cents" bigint;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD COLUMN "platform_amount_due_cents" bigint;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD COLUMN "platform_prepaid_balance_cents" bigint;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD COLUMN "platform_funding_kind" text;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD COLUMN "platform_read_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ad_budget_periods" ADD COLUMN "platform_read_error" text;--> statement-breakpoint
-- Meta's billing screen for this account says the R$ 2.500 spending limit
-- "A redefinição ocorre no primeiro dia de cada mês" (seen by Eric, 2026-09-30).
-- The Graph API does not report it, so it is recorded as the account's rule.
UPDATE "ad_accounts" SET "spend_cap_reset" = 'monthly' WHERE "platform" = 'meta' AND "external_id" = 'act_694058302567457' AND "spend_cap_reset" IS NULL;
