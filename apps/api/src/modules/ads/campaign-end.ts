import { effectiveCampaignEnd } from '@wings/shared';
import { inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adSets } from '../../db/schema/index.js';

/**
 * The day each campaign stops delivering: its own end date, else the latest end
 * among its ad sets that are on (Meta keeps the schedule on the ad set, so the
 * campaign row shows no end). One rule for the Cockpit, the dashboard, the
 * budget projection and the lead attribution (`effectiveCampaignEnd`).
 */
export async function effectiveCampaignEnds(
  db: Database,
  campaigns: { id: string; endDate: string | null }[],
): Promise<Map<string, string | null>> {
  const ids = campaigns.map((campaign) => campaign.id);
  const rows = ids.length
    ? await db
        .select({ campaignId: adSets.campaignId, status: adSets.status, endDate: adSets.endDate })
        .from(adSets)
        .where(inArray(adSets.campaignId, ids))
    : [];
  const byCampaign = new Map<string, { status: string; endDate: string | null }[]>();
  for (const row of rows) {
    const list = byCampaign.get(row.campaignId) ?? [];
    list.push({ status: row.status, endDate: row.endDate });
    byCampaign.set(row.campaignId, list);
  }
  return new Map(
    campaigns.map((campaign) => [
      campaign.id,
      effectiveCampaignEnd(campaign.endDate, byCampaign.get(campaign.id) ?? []),
    ]),
  );
}
