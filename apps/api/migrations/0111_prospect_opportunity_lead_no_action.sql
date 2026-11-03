ALTER TABLE "prospect_opportunities" DROP CONSTRAINT "prospect_opportunities_lead_id_leads_id_fk";
--> statement-breakpoint
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;