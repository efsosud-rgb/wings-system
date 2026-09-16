CREATE TYPE "public"."credential_token_purpose" AS ENUM('invite', 'reset');--> statement-breakpoint
CREATE TABLE "credential_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"purpose" "credential_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_employee_id_employees_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_target_employee_id_employees_id_fk";
--> statement-breakpoint
ALTER TABLE "credential_tokens" ADD CONSTRAINT "credential_tokens_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_tokens" ADD CONSTRAINT "credential_tokens_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_tokens_employee_idx" ON "credential_tokens" USING btree ("employee_id","purpose");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_employee_id_employees_id_fk" FOREIGN KEY ("actor_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_target_employee_id_employees_id_fk" FOREIGN KEY ("target_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_credentials" DROP COLUMN "invite_token_hash";--> statement-breakpoint
ALTER TABLE "employee_credentials" DROP COLUMN "invite_expires_at";