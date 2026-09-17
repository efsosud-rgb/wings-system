import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAds,
  adCampaigns,
  adCreatives,
  adMetricsDaily,
} from '../../db/schema/index.js';
import type { AdsPlatformClient, MetricsLevel } from './platform/types.js';

/**
 * Performance ingestion for the cockpit.
 *
 * Read-only against the platform. Two things this deliberately does NOT do:
 *
 *  - it never writes to ad_spend_snapshots, which is the guardrail's
 *    money-truth and stays append-only. Analytics and the budget wall must not
 *    share a table;
 *  - it never derives a conversion count from clicks. The Stage 6.0 spike found
 *    this account has no lead events at all, so `conversions` stays zero until
 *    a real conversion action appears rather than being faked from engagement.
 *
 * Zero rows is the normal state for an account that is not delivering; it is
 * not treated as a failure.
 */

/** Action types that genuinely represent a lead, in order of preference. */
export const LEAD_ACTION_TYPES = [
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'leadgen_grouped',
] as const;

export function conversionsFrom(actions: Record<string, number>): number {
  for (const type of LEAD_ACTION_TYPES) {
    const value = actions[type];
    if (typeof value === 'number' && value > 0) return value;
  }
  return 0;
}

export interface SyncAdsResult {
  ads: number;
  creatives: number;
  disapproved: number;
}

/** Mirrors ads and the creative detail the cockpit displays. */
export async function syncAds(
  db: Database,
  client: AdsPlatformClient,
  adAccountId: string,
  now = new Date(),
): Promise<SyncAdsResult> {
  const platformAds = await client.listAds();

  const campaigns = await db.query.adCampaigns.findMany({
    where: eq(adCampaigns.adAccountId, adAccountId),
  });
  const campaignByExternal = new Map(campaigns.map((c) => [c.externalId, c.id]));

  const storedAdSets = await db.query.adSets.findMany();
  const adSetByExternal = new Map(storedAdSets.map((a) => [a.externalId, a.id]));

  let creatives = 0;
  let disapproved = 0;

  for (const ad of platformAds) {
    if (ad.creative) {
      await db
        .insert(adCreatives)
        .values({
          adAccountId,
          externalId: ad.creative.id,
          name: ad.creative.name,
          thumbnailUrl: ad.creative.thumbnailUrl,
          title: ad.creative.title,
          body: ad.creative.body,
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: [adCreatives.adAccountId, adCreatives.externalId],
          set: {
            name: ad.creative.name,
            thumbnailUrl: ad.creative.thumbnailUrl,
            title: ad.creative.title,
            body: ad.creative.body,
            lastSyncedAt: now,
          },
        });
      creatives += 1;
    }

    if (ad.effectiveStatus === 'DISAPPROVED') disapproved += 1;

    await db
      .insert(adAds)
      .values({
        adAccountId,
        campaignId: campaignByExternal.get(ad.campaignId) ?? null,
        adSetId: adSetByExternal.get(ad.adSetId) ?? null,
        externalId: ad.id,
        name: ad.name,
        status: ad.status,
        effectiveStatus: ad.effectiveStatus,
        creativeExternalId: ad.creative?.id ?? null,
        reviewFeedback: ad.reviewFeedback ?? null,
        issuesInfo: ad.issuesInfo ?? null,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [adAds.adAccountId, adAds.externalId],
        set: {
          name: ad.name,
          status: ad.status,
          effectiveStatus: ad.effectiveStatus,
          creativeExternalId: ad.creative?.id ?? null,
          reviewFeedback: ad.reviewFeedback ?? null,
          issuesInfo: ad.issuesInfo ?? null,
          lastSyncedAt: now,
          updatedAt: now,
        },
      });
  }

  return { ads: platformAds.length, creatives, disapproved };
}

export interface IngestResult {
  level: MetricsLevel;
  rows: number;
  spendCents: number;
  conversions: number;
}

/** Pulls daily performance for one level and upserts it. */
export async function ingestMetrics(
  db: Database,
  client: AdsPlatformClient,
  adAccountId: string,
  level: MetricsLevel,
  sinceDate: string,
  now = new Date(),
): Promise<IngestResult> {
  const rows = await client.getInsights(level, sinceDate);

  const campaigns = await db.query.adCampaigns.findMany({
    where: eq(adCampaigns.adAccountId, adAccountId),
  });
  const campaignByExternal = new Map(campaigns.map((c) => [c.externalId, c.id]));
  const storedAdSets = await db.query.adSets.findMany();
  const adSetByExternal = new Map(storedAdSets.map((a) => [a.externalId, a.id]));
  const storedAds = await db.query.adAds.findMany({ where: eq(adAds.adAccountId, adAccountId) });
  const adByExternal = new Map(storedAds.map((a) => [a.externalId, a.id]));

  let spendCents = 0;
  let conversions = 0;

  for (const row of rows) {
    const rowConversions = conversionsFrom(row.actions);
    spendCents += row.spendCents;
    conversions += rowConversions;

    await db
      .insert(adMetricsDaily)
      .values({
        adAccountId,
        level,
        entityExternalId: row.entityId,
        campaignId: level === 'campaign' ? (campaignByExternal.get(row.entityId) ?? null) : null,
        adSetId: level === 'ad_set' ? (adSetByExternal.get(row.entityId) ?? null) : null,
        adId: level === 'ad' ? (adByExternal.get(row.entityId) ?? null) : null,
        day: row.date,
        spendCents: row.spendCents,
        impressions: row.impressions,
        clicks: row.clicks,
        reach: row.reach,
        ctrMilli: row.ctrMilli,
        frequencyMilli: row.frequencyMilli,
        conversions: rowConversions,
        actions: row.actions,
        qualityRanking: row.qualityRanking,
        engagementRateRanking: row.engagementRateRanking,
        conversionRateRanking: row.conversionRateRanking,
        fetchedAt: now,
      })
      // Platforms revise figures for days afterwards: the newest pull wins.
      .onConflictDoUpdate({
        target: [
          adMetricsDaily.adAccountId,
          adMetricsDaily.level,
          adMetricsDaily.entityExternalId,
          adMetricsDaily.day,
        ],
        set: {
          spendCents: row.spendCents,
          impressions: row.impressions,
          clicks: row.clicks,
          reach: row.reach,
          ctrMilli: row.ctrMilli,
          frequencyMilli: row.frequencyMilli,
          conversions: rowConversions,
          actions: row.actions,
          qualityRanking: row.qualityRanking,
          engagementRateRanking: row.engagementRateRanking,
          conversionRateRanking: row.conversionRateRanking,
          fetchedAt: now,
        },
      });
  }

  return { level, rows: rows.length, spendCents, conversions };
}

export interface CampaignPerformance {
  campaignExternalId: string;
  name: string;
  status: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Percentage x1000; null when there were no impressions. */
  ctrMilli: number | null;
  frequencyMilli: number | null;
  /** Null when there are no conversions — never inferred from clicks. */
  costPerLeadCents: number | null;
}

/** Rolled-up performance for the cockpit table. */
export async function campaignPerformance(
  db: Database,
  adAccountId: string,
  sinceDate: string,
): Promise<CampaignPerformance[]> {
  const rows = await db
    .select({
      campaignExternalId: adMetricsDaily.entityExternalId,
      spendCents: sql<string>`sum(${adMetricsDaily.spendCents})`,
      impressions: sql<string>`sum(${adMetricsDaily.impressions})`,
      clicks: sql<string>`sum(${adMetricsDaily.clicks})`,
      conversions: sql<string>`sum(${adMetricsDaily.conversions})`,
      frequencyMilli: sql<string>`max(${adMetricsDaily.frequencyMilli})`,
    })
    .from(adMetricsDaily)
    .where(
      and(
        eq(adMetricsDaily.adAccountId, adAccountId),
        eq(adMetricsDaily.level, 'campaign'),
        gte(adMetricsDaily.day, sinceDate),
      ),
    )
    .groupBy(adMetricsDaily.entityExternalId);

  const campaigns = await db.query.adCampaigns.findMany({
    where: eq(adCampaigns.adAccountId, adAccountId),
  });
  const byExternal = new Map(campaigns.map((c) => [c.externalId, c]));

  return rows.map((row) => {
    const spendCents = Number(row.spendCents ?? 0);
    const impressions = Number(row.impressions ?? 0);
    const clicks = Number(row.clicks ?? 0);
    const conversions = Number(row.conversions ?? 0);
    const campaign = byExternal.get(row.campaignExternalId);

    return {
      campaignExternalId: row.campaignExternalId,
      name: campaign?.name ?? row.campaignExternalId,
      status: campaign?.status ?? 'UNKNOWN',
      spendCents,
      impressions,
      clicks,
      conversions,
      ctrMilli: impressions > 0 ? Math.round((clicks / impressions) * 100 * 1000) : null,
      frequencyMilli: Number(row.frequencyMilli ?? 0) || null,
      // No conversions means no cost per lead. An empty column is honest; a
      // cost-per-click wearing a CPL label is not.
      costPerLeadCents: conversions > 0 ? Math.round(spendCents / conversions) : null,
    };
  });
}

/** Accounts whose metrics have not been refreshed recently. */
export async function staleMetricAccounts(db: Database, maxAgeMinutes = 180, now = new Date()) {
  const accounts = await db.query.adAccounts.findMany();
  const stale: { accountId: string; lastFetchedAt: Date | null }[] = [];

  for (const account of accounts) {
    const latest = await db
      .select({ fetchedAt: sql<Date | null>`max(${adMetricsDaily.fetchedAt})` })
      .from(adMetricsDaily)
      .where(eq(adMetricsDaily.adAccountId, account.id));

    const fetchedAt = latest[0]?.fetchedAt ?? null;
    const age = fetchedAt ? (now.getTime() - new Date(fetchedAt).getTime()) / 60_000 : Infinity;
    if (age > maxAgeMinutes) stale.push({ accountId: account.id, lastFetchedAt: fetchedAt });
  }
  return stale;
}

/** Ensures the account row exists; used when seeding a real account. */
export async function ensureAdAccount(
  db: Database,
  input: { platform: 'meta' | 'google' | 'tiktok'; externalId: string; name: string },
): Promise<string> {
  const [row] = await db
    .insert(adAccounts)
    .values(input)
    .onConflictDoUpdate({
      target: [adAccounts.platform, adAccounts.externalId],
      set: { name: input.name, updatedAt: new Date() },
    })
    .returning({ id: adAccounts.id });
  if (!row) throw new Error('failed to create ad account');
  return row.id;
}
