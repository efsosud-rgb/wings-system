CREATE TABLE "site_posts" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"outcome" text NOT NULL,
	"wordpress_post_id" bigint,
	"edit_url" text,
	"detail" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_posts" ADD CONSTRAINT "site_posts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_posts" ADD CONSTRAINT "site_posts_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_posts_created_idx" ON "site_posts" USING btree ("created_at");