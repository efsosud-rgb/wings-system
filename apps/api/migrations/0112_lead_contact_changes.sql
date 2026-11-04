CREATE TABLE "lead_contact_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"actor_employee_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_contact_changes_field_check" CHECK ("lead_contact_changes"."field" in ('name', 'phone', 'email', 'instagram', 'website'))
);
--> statement-breakpoint
ALTER TABLE "lead_contact_changes" ADD CONSTRAINT "lead_contact_changes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_contact_changes" ADD CONSTRAINT "lead_contact_changes_actor_employee_id_employees_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_contact_changes_lead_idx" ON "lead_contact_changes" USING btree ("lead_id","at");