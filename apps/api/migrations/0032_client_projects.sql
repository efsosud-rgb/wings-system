CREATE TYPE "public"."client_project_stage_progress" AS ENUM('nao_iniciada', 'em_andamento', 'concluida', 'bloqueada');--> statement-breakpoint
CREATE TYPE "public"."client_project_status" AS ENUM('em_andamento', 'parado', 'cancelado', 'finalizado');--> statement-breakpoint
CREATE TABLE "client_project_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"department" text NOT NULL,
	"progress" "client_project_stage_progress" DEFAULT 'nao_iniciada' NOT NULL,
	"note" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "client_project_status_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"from_status" "client_project_status",
	"to_status" "client_project_status" NOT NULL,
	"reason" text,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_project_status_history_reason_check" CHECK ("client_project_status_history"."to_status" not in ('parado', 'cancelado') or length(btrim(coalesce("client_project_status_history"."reason", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "client_projects" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"status" "client_project_status" DEFAULT 'em_andamento' NOT NULL,
	"current_stage" text DEFAULT '01' NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_project_stages" ADD CONSTRAINT "client_project_stages_project_id_client_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."client_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_project_stages" ADD CONSTRAINT "client_project_stages_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_project_status_history" ADD CONSTRAINT "client_project_status_history_project_id_client_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."client_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_project_status_history" ADD CONSTRAINT "client_project_status_history_changed_by_employees_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_projects" ADD CONSTRAINT "client_projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_projects" ADD CONSTRAINT "client_projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_projects" ADD CONSTRAINT "client_projects_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_project_stages_project_slot_idx" ON "client_project_stages" USING btree ("project_id","slot");--> statement-breakpoint
CREATE INDEX "client_project_status_history_project_idx" ON "client_project_status_history" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_projects_client_idx" ON "client_projects" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_projects_status_idx" ON "client_projects" USING btree ("status");--> statement-breakpoint
-- Every client registered so far (Wings Company excepted: it is not a client of
-- itself) gets its project, Em Andamento at stage 01, and the eight stages not
-- yet started. Registering a client from now on does the same in the route.
INSERT INTO "client_projects" ("tenant_id", "client_id")
SELECT c."tenant_id", c."id"
  FROM "clients" AS c
 WHERE c."id" <> '00000000-0000-4000-8000-0000000000c1'
   AND NOT EXISTS (SELECT 1 FROM "client_projects" AS p WHERE p."client_id" = c."id");--> statement-breakpoint
INSERT INTO "client_project_stages" ("project_id", "slot", "department")
SELECT p."id", s."slot", s."department"
  FROM "client_projects" AS p
 CROSS JOIN (VALUES
   ('01', 'imersao'), ('02', 'imersao'), ('03', 'imersao'), ('04', 'financeiro'),
   ('05', 'projetos'), ('06', 'juridico'), ('07', 'comercial'), ('08', 'marketing')
 ) AS s ("slot", "department")
 WHERE NOT EXISTS (
   SELECT 1 FROM "client_project_stages" AS x WHERE x."project_id" = p."id" AND x."slot" = s."slot"
 );--> statement-breakpoint
-- The read-only role of staging (wings-staging-sql) reads the new tables at
-- once. Local, test and any database without the role skip this.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON "client_projects", "client_project_stages", "client_project_status_history" TO wings_ro;
  END IF;
END
$$;
