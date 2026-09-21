ALTER TABLE "ad_campaigns" ADD COLUMN "objective" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "diagnostics" jsonb DEFAULT '{}'::jsonb NOT NULL;