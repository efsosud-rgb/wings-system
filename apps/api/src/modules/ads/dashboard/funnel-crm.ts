import type { FunnelCrmCounts } from '@wings/shared';
import { and, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { adAds, crmStages, leads } from '../../../db/schema/index.js';

/**
 * The CRM side of the funnel, campaign by campaign and ad by ad, from the
 * Wings System's own leads (orchestrator, 13/10): RD's deal labels only name
 * the platform. A lead belongs to a campaign by the ad ids it keeps (Meta
 * instant forms, or the UTMs Leads das Campanhas found), else by its UTM
 * campaign (the campaign's draft UTM, name or id); to an ad by the ad id, else
 * by its UTM content (the ad's own `utm_content`). Meetings and proposals are
 * the furthest stage each lead reached (its stage now or any stage in its
 * history), a won lead reaching them all. A lead marked as a likely robot and
 * not cleared by a person counts nowhere.
 */

const key = (value: string | null | undefined) =>
  (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

const MEETING = /reuni/i;
const PROPOSAL = /proposta/i;

export interface CrmCampaign {
  id: string;
  externalId: string;
  name: string;
  /** utm_campaign of the campaign's builder draft, when there is one. */
  draftUtm: string | null;
}

export interface CrmAd {
  id: string;
  externalId: string;
  name: string;
  campaignId: string | null;
}

export interface CrmFunnel {
  byCampaign: Map<string, FunnelCrmCounts>;
  /** By ad id (ours, not the platform's). */
  byAd: Map<string, FunnelCrmCounts>;
  ads: CrmAd[];
  leadsWithoutCampaign: number;
}

const empty = (): FunnelCrmCounts => ({ leads: 0, meetings: 0, proposals: 0 });

export async function crmFunnel(
  db: Database,
  input: { campaigns: CrmCampaign[]; start: Date; end: Date },
): Promise<CrmFunnel> {
  const campaignIds = input.campaigns.map((campaign) => campaign.id);
  const [ads, stages, rows] = await Promise.all([
    campaignIds.length
      ? db
          .select({
            id: adAds.id,
            externalId: adAds.externalId,
            name: adAds.name,
            campaignId: adAds.campaignId,
            utmContent: adAds.utmContent,
          })
          .from(adAds)
          .where(inArray(adAds.campaignId, campaignIds))
      : [],
    db
      .select({ pipeline: crmStages.pipeline, name: crmStages.name, position: crmStages.position })
      .from(crmStages),
    db
      .select({
        pipeline: leads.pipeline,
        won: leads.won,
        adCampaignExternalId: leads.adCampaignExternalId,
        adExternalId: leads.adExternalId,
        utmCampaign: leads.utmCampaign,
        utmContent: leads.utmContent,
        top: sql<number>`greatest(
          coalesce((select s.position from crm_stages s where s.id = "leads"."stage_id"), 0),
          coalesce((select max(s.position) from lead_stage_history h
                      join crm_stages s on s.id = h.to_stage_id where h.lead_id = "leads"."id"), 0)
        )`,
      })
      .from(leads)
      .where(
        and(
          gte(leads.enteredAt, input.start),
          lte(leads.enteredAt, input.end),
          or(isNull(leads.suspectAt), isNotNull(leads.suspectClearedAt)),
        ),
      ),
  ]);

  // The first meeting and proposal stage of each funnel, by position.
  const firstOf = (pattern: RegExp) => {
    const out = new Map<string, number>();
    for (const stage of stages) {
      if (!pattern.test(stage.name)) continue;
      const known = out.get(stage.pipeline);
      if (known === undefined || stage.position < known) out.set(stage.pipeline, stage.position);
    }
    return out;
  };
  const meetingAt = firstOf(MEETING);
  const proposalAt = firstOf(PROPOSAL);

  const byExternal = new Map(input.campaigns.map((campaign) => [campaign.externalId, campaign]));
  const byUtm = new Map<string, CrmCampaign>();
  for (const campaign of input.campaigns) {
    for (const candidate of [campaign.draftUtm, campaign.name, campaign.externalId]) {
      const k = key(candidate);
      if (k && !byUtm.has(k)) byUtm.set(k, campaign);
    }
  }
  const adByExternal = new Map(ads.map((ad) => [ad.externalId, ad]));

  const byCampaign = new Map<string, FunnelCrmCounts>();
  const byAd = new Map<string, FunnelCrmCounts>();
  let leadsWithoutCampaign = 0;
  for (const row of rows) {
    const ownAd = row.adExternalId ? adByExternal.get(row.adExternalId) : undefined;
    const campaign =
      (row.adCampaignExternalId ? byExternal.get(row.adCampaignExternalId) : undefined) ??
      (ownAd?.campaignId
        ? input.campaigns.find((entry) => entry.id === ownAd.campaignId)
        : undefined) ??
      (row.utmCampaign ? byUtm.get(key(row.utmCampaign)) : undefined);
    if (!campaign) {
      leadsWithoutCampaign += 1;
      continue;
    }
    const ad =
      ownAd && ownAd.campaignId === campaign.id
        ? ownAd
        : row.utmContent
          ? ads.find(
              (entry) =>
                entry.campaignId === campaign.id &&
                entry.utmContent !== null &&
                key(entry.utmContent) === key(row.utmContent),
            )
          : undefined;
    const pipeline = row.pipeline ?? '';
    const reached = (at: number | undefined) =>
      row.won === true || (at !== undefined && Number(row.top) >= at);
    const meeting = reached(meetingAt.get(pipeline));
    const proposal = reached(proposalAt.get(pipeline));
    for (const [map, id] of [
      [byCampaign, campaign.id],
      ...(ad ? [[byAd, ad.id] as const] : []),
    ] as const) {
      const counts = map.get(id) ?? empty();
      counts.leads += 1;
      if (meeting) counts.meetings += 1;
      if (proposal) counts.proposals += 1;
      map.set(id, counts);
    }
  }
  return {
    byCampaign,
    byAd,
    ads: ads.map(({ id, externalId, name, campaignId }) => ({ id, externalId, name, campaignId })),
    leadsWithoutCampaign,
  };
}

export const noCrm = empty;
