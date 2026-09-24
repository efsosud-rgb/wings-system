CREATE TYPE "public"."roadmap_deliverable_source" AS ENUM('auto_draft', 'manual');--> statement-breakpoint
CREATE TYPE "public"."roadmap_deliverable_status" AS ENUM('pronto', 'em_andamento', 'pendente');--> statement-breakpoint
CREATE TYPE "public"."roadmap_deliverable_weight" AS ENUM('P', 'M', 'G');--> statement-breakpoint
CREATE TYPE "public"."roadmap_recipient_role" AS ENUM('preview', 'ceo');--> statement-breakpoint
CREATE TYPE "public"."roadmap_report_run_status" AS ENUM('rascunho', 'aprovado', 'enviado', 'enviado_simulado');--> statement-breakpoint
CREATE TABLE "roadmap_deliverable_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deliverable_id" uuid NOT NULL,
	"changed_by" uuid,
	"previous" jsonb NOT NULL,
	"next" jsonb NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roadmap_deliverables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" uuid NOT NULL,
	"label" text NOT NULL,
	"weight" "roadmap_deliverable_weight" DEFAULT 'M' NOT NULL,
	"status" "roadmap_deliverable_status" DEFAULT 'pendente' NOT NULL,
	"completed_at" date,
	"source" "roadmap_deliverable_source" DEFAULT 'manual' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roadmap_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_coming_soon" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roadmap_report_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "roadmap_recipient_role" NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roadmap_report_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_date" date NOT NULL,
	"status" "roadmap_report_run_status" DEFAULT 'rascunho' NOT NULL,
	"computed" jsonb NOT NULL,
	"message_text" text NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roadmap_deliverable_changes" ADD CONSTRAINT "roadmap_deliverable_changes_deliverable_id_roadmap_deliverables_id_fk" FOREIGN KEY ("deliverable_id") REFERENCES "public"."roadmap_deliverables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roadmap_deliverable_changes" ADD CONSTRAINT "roadmap_deliverable_changes_changed_by_employees_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roadmap_deliverables" ADD CONSTRAINT "roadmap_deliverables_module_id_roadmap_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."roadmap_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roadmap_report_runs" ADD CONSTRAINT "roadmap_report_runs_approved_by_employees_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "roadmap_deliverable_changes_deliverable_idx" ON "roadmap_deliverable_changes" USING btree ("deliverable_id");--> statement-breakpoint
CREATE INDEX "roadmap_deliverables_module_idx" ON "roadmap_deliverables" USING btree ("module_id");--> statement-breakpoint
CREATE INDEX "roadmap_deliverables_status_idx" ON "roadmap_deliverables" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "roadmap_modules_key_uq" ON "roadmap_modules" USING btree ("key");--> statement-breakpoint
CREATE INDEX "roadmap_report_recipients_role_idx" ON "roadmap_report_recipients" USING btree ("role","active");--> statement-breakpoint
CREATE UNIQUE INDEX "roadmap_report_runs_date_uq" ON "roadmap_report_runs" USING btree ("report_date");