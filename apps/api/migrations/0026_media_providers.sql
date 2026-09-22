ALTER TYPE "public"."media_origin" ADD VALUE 'cloudflare';--> statement-breakpoint
ALTER TYPE "public"."media_origin" ADD VALUE 'gemini';--> statement-breakpoint
ALTER TYPE "public"."media_origin" ADD VALUE 'higgsfield';--> statement-breakpoint
ALTER TYPE "public"."media_origin" ADD VALUE 'mpt';--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "generation_id" uuid;--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ADD COLUMN "provider" text DEFAULT 'kairogen' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ADD COLUMN "brl_cents_estimated" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ADD COLUMN "brl_cents_charged" integer;--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ADD COLUMN "brl_cents_delta" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "provider" text DEFAULT 'kairogen' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "brl_cents_estimated" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "brl_cents_charged" integer;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "campaign" text;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "routed_from" jsonb;--> statement-breakpoint
CREATE INDEX "media_credit_ledger_provider_idx" ON "media_credit_ledger" USING btree ("provider","created_at");