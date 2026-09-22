import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccountDaily,
  adAccounts,
  adCampaigns,
  adMetricsBreakdownDaily,
  adSets,
} from '../../db/schema/index.js';
import { conversionsFrom } from './metrics.js';
import { assertClientServesAccount } from './reconcile.js';
import type { AdsPlatformClient, BreakdownKind } from './platform/types.js';

/**
 * The wider ingestion the marketing dashboard needs, beside the per-entity
 * daily rows `ingestMetrics` already mirrors:
 *
 *  - campaign figures split by placement, age and gender, region and hour;
 *  - one row per account per day with the platform's own view of the money
 *    (cap, amount spent, prepaid balance) and the budget in force that day.
 *
 * Read-only against the platform, like everything in the ingest job. Both
 * upsert, and the newest pull wins — the platforms revise figures for days.
 */

export const BREAKDOWN_KINDS: readonly BreakdownKind[] = ['placement', 'age_gender', 'region', 'hour'];

export interface BreakdownIngestResult {
  kind: BreakdownKind;
  rows: number;
}

/** Pulls one split of daily campaign figures and upserts it. */
export async function ingestBreakdown(
  db: Database,
  client: AdsPlatformClient,
  adAccountId: string,
  kind: BreakdownKind,
  sinceDate: string,
  now = new Date(),
): Promise<BreakdownIngestResult> {
  const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, adAccountId) });
  if (!account) throw new Error('ad account not found');
  assertClientServesAccount(client, account.externalId);

  const rows = await client.getBreakdowns(kind, sinceDate);
  const campaigns = await db.query.adCampaigns.findMany({
    where: eq(adCampaigns.adAccountId, adAccountId),
  });
  const campaignByExternal = new Map(campaigns.map((c) => [c.externalId, c.id]));

  for (const row of rows) {
    const figures = {
      spendCents: row.spendCents,
      impressions: row.impressions,
      clicks: row.clicks,
      reach: row.reach,
      conversions: conversionsFrom(row.actions),
      actions: row.actions,
      fetchedAt: now,
    };
    await db
      .insert(adMetricsBreakdownDaily)
      .values({
        adAccountId,
        campaignId: campaignByExternal.get(row.campaignId) ?? null,
        campaignExternalId: row.campaignId,
        day: row.date,
        kind,
        key: row.key,
        subKey: row.subKey,
        ...figures,
      })
      .onConflictDoUpdate({
        target: [
          adMetricsBreakdownDaily.adAccountId,
          adMetricsBreakdownDaily.campaignExternalId,
          adMetricsBreakdownDaily.day,
          adMetricsBreakdownDaily.kind,
          adMetricsBreakdownDaily.key,
          adMetricsBreakdownDaily.subKey,
        ],
        set: figures,
      });
  }

  return { kind, rows: rows.length };
}

export interface AccountDayResult {
  day: string;
  activeDailyBudgetCents: number;
  platformRemainingCents: number | null;
  prepaidBalanceCents: number | null;
}

/**
 * Writes today's row of `ad_account_daily` from the account the client reads
 * and the campaigns already mirrored. Today in the account's timezone: a run
 * just after midnight in São Paulo files under the new day, not under UTC's.
 */
export async function recordAccountDay(
  db: Database,
  client: AdsPlatformClient,
  adAccountId: string,
  now = new Date(),
): Promise<AccountDayResult> {
  const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, adAccountId) });
  if (!account) throw new Error('ad account not found');
  assertClientServesAccount(client, account.externalId);

  const platform = await client.getAccount();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: account.timezone }).format(now);

  // Budget in force: an active CBO campaign's own budget, or the budgets of an
  // ABO campaign's active ad sets. A paused campaign starves its ad sets, so
  // theirs count for nothing.
  const campaigns = await db.query.adCampaigns.findMany({
    where: eq(adCampaigns.adAccountId, adAccountId),
  });
  const [adSetRow] = await db
    .select({
      total: sql<string>`coalesce(sum(${adSets.dailyBudgetCents}), 0)`,
    })
    .from(adSets)
    .innerJoin(adCampaigns, eq(adCampaigns.id, adSets.campaignId))
    .where(
      sql`${adCampaigns.adAccountId} = ${adAccountId} and ${adCampaigns.status} = 'ACTIVE' and ${adSets.status} = 'ACTIVE' and ${adCampaigns.budgetLevel} = 'ad_set'`,
    );
  const activeDailyBudgetCents =
    campaigns
      .filter((campaign) => campaign.status === 'ACTIVE' && campaign.budgetLevel === 'campaign')
      .reduce((total, campaign) => total + campaign.dailyBudgetCents, 0) +
    Number(adSetRow?.total ?? 0);

  const platformRemainingCents =
    platform.spendCapCents === null
      ? null
      : Math.max(0, platform.spendCapCents - platform.amountSpentCents);
  const figures = {
    spendCapCents: platform.spendCapCents,
    amountSpentCents: platform.amountSpentCents,
    platformRemainingCents,
    prepaidBalanceCents: platform.prepaidBalanceCents ?? null,
    fundingKind: platform.fundingKind ?? null,
    activeDailyBudgetCents,
    fetchedAt: now,
  };

  await db
    .insert(adAccountDaily)
    .values({ adAccountId, day, ...figures })
    .onConflictDoUpdate({
      target: [adAccountDaily.adAccountId, adAccountDaily.day],
      set: figures,
    });

  return {
    day,
    activeDailyBudgetCents,
    platformRemainingCents,
    prepaidBalanceCents: figures.prepaidBalanceCents,
  };
}
