CREATE TABLE "instagram_business_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"username" text NOT NULL,
	"status" text NOT NULL,
	"followers_count" integer,
	"media_count" integer,
	"recent_media_read" smallint,
	"avg_likes_milli" integer,
	"avg_comments_milli" integer,
	"posts_last_30d" smallint,
	"last_post_at" timestamp with time zone,
	"error_code" integer,
	"source" text DEFAULT 'meta_business_discovery' NOT NULL,
	"api_version" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "instagram_business_snapshots_status_check" CHECK ("instagram_business_snapshots"."status" in ('encontrada', 'nao_comercial', 'erro'))
);
--> statement-breakpoint
CREATE TABLE "instagram_discovery_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"employee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instagram_business_snapshots" ADD CONSTRAINT "instagram_business_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_discovery_calls" ADD CONSTRAINT "instagram_discovery_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instagram_discovery_calls" ADD CONSTRAINT "instagram_discovery_calls_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "instagram_business_snapshots_username_uq" ON "instagram_business_snapshots" USING btree ("tenant_id","username");--> statement-breakpoint
CREATE INDEX "instagram_business_snapshots_fetched_idx" ON "instagram_business_snapshots" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "instagram_discovery_calls_created_idx" ON "instagram_discovery_calls" USING btree ("tenant_id","created_at");