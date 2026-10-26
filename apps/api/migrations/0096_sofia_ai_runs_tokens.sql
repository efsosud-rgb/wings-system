ALTER TABLE "sofia_ai_runs" ADD COLUMN "tools" text[];--> statement-breakpoint
ALTER TABLE "sofia_ai_runs" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "sofia_ai_runs" ADD COLUMN "output_tokens" integer;