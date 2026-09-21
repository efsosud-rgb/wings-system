CREATE TABLE "drive_file_versions" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"checksum" text,
	"replaced_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_files" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"folder_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_id" uuid,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"checksum" text,
	"trashed_at" timestamp with time zone,
	"trashed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_folders" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"department" text NOT NULL,
	"client_id" uuid,
	"origin" text DEFAULT 'manual' NOT NULL,
	"template_node_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_template_nodes" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 'folder' NOT NULL,
	"department" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_uploads" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"folder_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"replace_file_id" uuid,
	"requested_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "drive_file_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_file_versions" ADD CONSTRAINT "drive_file_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_file_versions" ADD CONSTRAINT "drive_file_versions_file_id_drive_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_file_versions" ADD CONSTRAINT "drive_file_versions_replaced_by_employees_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_folder_id_drive_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."drive_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_owner_id_employees_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_trashed_by_employees_id_fk" FOREIGN KEY ("trashed_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_parent_id_drive_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."drive_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_template_node_id_drive_template_nodes_id_fk" FOREIGN KEY ("template_node_id") REFERENCES "public"."drive_template_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_template_nodes" ADD CONSTRAINT "drive_template_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_template_nodes" ADD CONSTRAINT "drive_template_nodes_parent_id_drive_template_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."drive_template_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_folder_id_drive_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."drive_folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_replace_file_id_drive_files_id_fk" FOREIGN KEY ("replace_file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_requested_by_employees_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_file_versions_idx" ON "drive_file_versions" USING btree ("file_id","version");--> statement-breakpoint
CREATE INDEX "drive_files_folder_idx" ON "drive_files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "drive_files_client_idx" ON "drive_files" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "drive_files_trashed_idx" ON "drive_files" USING btree ("trashed_at");--> statement-breakpoint
CREATE INDEX "drive_folders_parent_idx" ON "drive_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "drive_folders_department_idx" ON "drive_folders" USING btree ("department");--> statement-breakpoint
CREATE INDEX "drive_folders_client_idx" ON "drive_folders" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_folders_sibling_name_idx" ON "drive_folders" USING btree ("parent_id",lower("name"));--> statement-breakpoint
CREATE INDEX "drive_template_parent_idx" ON "drive_template_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "drive_uploads_expires_idx" ON "drive_uploads" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_drive_file_id_drive_files_id_fk" FOREIGN KEY ("drive_file_id") REFERENCES "public"."drive_files"("id") ON DELETE set null ON UPDATE no action;