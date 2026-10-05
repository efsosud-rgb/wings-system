CREATE TABLE "crm_distribution_members" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline" text NOT NULL,
	"employee_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_assigned_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_stages" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"rd_stage_id" text,
	"sofia_entry" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_notes" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"author_employee_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_stage_history" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"from_stage" text,
	"to_stage" text,
	"won" boolean,
	"lost_reason" text,
	"source" text NOT NULL,
	"actor_employee_id" uuid
);
--> statement-breakpoint
CREATE TABLE "lead_tasks" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" text DEFAULT 'follow_up' NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"assignee_employee_id" uuid,
	"auto" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" uuid
);
--> statement-breakpoint
CREATE TABLE "meta_leadgen_events" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leadgen_id" text NOT NULL,
	"form_id" text,
	"page_id" text,
	"ad_id" text,
	"adgroup_id" text,
	"created_time" timestamp with time zone,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"lead_id" uuid,
	"lead_created" boolean,
	"rd_deal_id" text,
	"rd_outcome" text
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "form_answers" jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "managed_by" text DEFAULT 'wings' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_distribution_members" ADD CONSTRAINT "crm_distribution_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_distribution_members" ADD CONSTRAINT "crm_distribution_members_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_distribution_members" ADD CONSTRAINT "crm_distribution_members_updated_by_employees_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stages" ADD CONSTRAINT "crm_stages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stages" ADD CONSTRAINT "crm_stages_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_author_employee_id_employees_id_fk" FOREIGN KEY ("author_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_from_stage_id_crm_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_to_stage_id_crm_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_actor_employee_id_employees_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_assignee_employee_id_employees_id_fk" FOREIGN KEY ("assignee_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_done_by_employees_id_fk" FOREIGN KEY ("done_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_leadgen_events" ADD CONSTRAINT "meta_leadgen_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_leadgen_events" ADD CONSTRAINT "meta_leadgen_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_distribution_members_uq" ON "crm_distribution_members" USING btree ("tenant_id","pipeline","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_stages_pipeline_name_uq" ON "crm_stages" USING btree ("tenant_id","pipeline","name");--> statement-breakpoint
CREATE INDEX "crm_stages_pipeline_position_idx" ON "crm_stages" USING btree ("pipeline","position");--> statement-breakpoint
CREATE INDEX "lead_notes_lead_idx" ON "lead_notes" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_stage_history_lead_idx" ON "lead_stage_history" USING btree ("lead_id","at");--> statement-breakpoint
CREATE INDEX "lead_tasks_lead_idx" ON "lead_tasks" USING btree ("lead_id","due_at");--> statement-breakpoint
CREATE INDEX "lead_tasks_assignee_due_idx" ON "lead_tasks" USING btree ("assignee_employee_id","done_at","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_leadgen_events_leadgen_uq" ON "meta_leadgen_events" USING btree ("leadgen_id");--> statement-breakpoint
CREATE INDEX "meta_leadgen_events_status_idx" ON "meta_leadgen_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "meta_leadgen_events_received_idx" ON "meta_leadgen_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "leads_stage_id_idx" ON "leads" USING btree ("stage_id");--> statement-breakpoint
-- Data: the stages RD CRM has today, as the leads already mirror them (nothing invented); positions by RD's order.
INSERT INTO "crm_stages" ("pipeline", "name", "position")
SELECT l."pipeline", l."stage", MIN(COALESCE(l."stage_order", 999))
FROM "leads" l
WHERE l."pipeline" IN ('expansao', 'formatacao') AND l."stage" IS NOT NULL
GROUP BY l."pipeline", l."stage"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Tie every lead to its stage row.
UPDATE "leads" l SET "stage_id" = s."id"
FROM "crm_stages" s
WHERE l."stage_id" IS NULL AND s."pipeline" = l."pipeline" AND s."name" = l."stage";--> statement-breakpoint
-- Leads that came from RD stay mirrored from RD until someone touches them here.
UPDATE "leads" SET "managed_by" = 'rd' WHERE "rd_deal_id" IS NOT NULL;--> statement-breakpoint
-- The rotation starts with the sellers we already know from RD (rd_user_map → employee), by their role's funnel.
INSERT INTO "crm_distribution_members" ("pipeline", "employee_id")
SELECT CASE r."key" WHEN 'vendedor_expansao' THEN 'expansao' ELSE 'formatacao' END, e."id"
FROM "rd_user_map" m
JOIN "employees" e ON e."id" = m."employee_id"
JOIN "roles" r ON r."id" = e."role_id"
WHERE m."rd_active" AND m."departed_at" IS NULL AND e."status" = 'active'
  AND r."key" IN ('vendedor_expansao', 'vendedor_formatacao')
ON CONFLICT DO NOTHING;
