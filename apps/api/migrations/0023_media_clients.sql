CREATE TABLE "clients" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Wings Company is a client like any other, with a fixed id: every client_id below
-- defaults to it, so the row has to exist before the foreign keys do.
INSERT INTO "clients" ("id", "name", "slug") VALUES ('00000000-0000-4000-8000-0000000000c1', 'Wings Company', 'wings-company');--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ALTER COLUMN "generation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "client_id" uuid DEFAULT '00000000-0000-4000-8000-0000000000c1' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ADD COLUMN "client_id" uuid DEFAULT '00000000-0000-4000-8000-0000000000c1' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ADD COLUMN "balance_reported" integer;--> statement-breakpoint
ALTER TABLE "media_generations" ADD COLUMN "client_id" uuid DEFAULT '00000000-0000-4000-8000-0000000000c1' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_slug_idx" ON "clients" USING btree ("tenant_id","slug");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_credit_ledger" ADD CONSTRAINT "media_credit_ledger_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_generations" ADD CONSTRAINT "media_generations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_client_idx" ON "media_assets" USING btree ("client_id");