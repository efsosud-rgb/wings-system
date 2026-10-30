ALTER TABLE "campaign_leads" ALTER COLUMN "rd_deal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_lead_id_unique" UNIQUE("lead_id");--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_origin_check" CHECK ("campaign_leads"."rd_deal_id" is not null or "campaign_leads"."lead_id" is not null);