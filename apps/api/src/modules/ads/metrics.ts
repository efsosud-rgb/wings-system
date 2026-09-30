import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAds,
  adAlerts,
  adCampaigns,
  adCreatives,
  adMetricsDaily,
} from '../../db/schema/index.js';
import { assertClientServesAccount } from './reconcile.js';
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

/** Same protection as reconciliation: a client may only write its own account. */
async function assertMirrorTarget(
  db: Database,
  client: AdsPlatformClient,
  adAccountId: string,
): Promise<void> {
  const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, adAccountId) });
  if (!account) throw new Error('ad account not found');
  assertClientServesAccount(client, account.externalId);
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
  await assertMirrorTarget(db, client, adAccountId);
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
          format: ad.creative.format ?? 'unknown',
          lastSyncedAt: now,
        })
        .onConflictDoUpdate({
          target: [adCreatives.adAccountId, adCreatives.externalId],
          set: {
            name: ad.creative.name,
            thumbnailUrl: ad.creative.thumbnailUrl,
            title: ad.creative.title,
            body: ad.creative.body,
            // A client that does not say the format never erases a known one.
            ...(ad.creative.format ? { format: ad.creative.format } : {}),
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
        utmContent: ad.creative?.utmContent ?? null,
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
          // A client that does not read links (Google, the fake) never erases one.
          ...(ad.creative?.utmContent !== undefined ? { utmContent: ad.creative.utmContent } : {}),
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
  /** What the platform would not answer (a metric this API version lacks); the rows still landed. */
  warnings: string[];
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
  await assertMirrorTarget(db, client, adAccountId);
  const rows = await client.getInsights(level, sinceDate);
  const warnings = client.drainWarnings?.() ?? [];

  const campaigns = await db.query.adCampaigns.findMany({
    where: eq(adCampaigns.adAccountId, adAccountId),
  });
  const campaignByExternal = new Map(campaigns.map((c) => [c.externalId, c.id]));
  const storedAdSets = await db.query.adSets.findMany();
  const adSetByExternal = new Map(storedAdSets.map((a) => [a.externalId, a.id]));
  const storedAds = await db.query.adAds.findMany({ where: eq(adAds.adAccountId, adAccountId) });
  const adByExternal = new Map(storedAds.map((a) => [a.externalId, a.id]));

  // Budget in force per entity, captured now. The platform APIs join the
  // CURRENT budget to historical metrics, so a ratio computed later from
  // whatever the budget happens to be then is wrong the moment someone edits
  // it — this is the only chance to record the real one.
  const budgetByExternalId = new Map<string, number | null>();
  if (level === 'campaign') {
    for (const campaign of campaigns) {
      budgetByExternalId.set(campaign.externalId, campaign.dailyBudgetCents || null);
    }
  } else if (level === 'ad_set') {
    for (const adSet of storedAdSets) {
      budgetByExternalId.set(adSet.externalId, adSet.dailyBudgetCents || null);
    }
  }

  // Only today's budget is knowable; for a past day we record nothing rather
  // than a number that would look authoritative and be wrong.
  const todayInAccountTz = now.toISOString().slice(0, 10);

  let spendCents = 0;
  let conversions = 0;

  for (const row of rows) {
    const rowConversions = conversionsFrom(row.actions);
    spendCents += row.spendCents;
    conversions += rowConversions;
    const video = {
      videoPlays: row.video?.plays ?? 0,
      videoThruplays: row.video?.thruplays ?? 0,
      videoP25: row.video?.p25 ?? 0,
      videoP50: row.video?.p50 ?? 0,
      videoP75: row.video?.p75 ?? 0,
      videoP100: row.video?.p100 ?? 0,
      videoStarts: row.video?.starts ?? 0,
      videoWatchMs: row.video?.watchMs ?? 0,
    };

    await db
      .insert(adMetricsDaily)
      .values({
        ...video,
        adAccountId,
        level,
        entityExternalId: row.entityId,
        campaignId: level === 'campaign' ? (campaignByExternal.get(row.entityId) ?? null) : null,
        adSetId: level === 'ad_set' ? (adSetByExternal.get(row.entityId) ?? null) : null,
        adId: level === 'ad' ? (adByExternal.get(row.entityId) ?? null) : null,
        day: row.date,
        dailyBudgetCents:
          row.date === todayInAccountTz ? (budgetByExternalId.get(row.entityId) ?? null) : null,
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
          ...video,
          // A day that has closed keeps the budget it was ingested with; only
          // the current day may still be corrected.
          dailyBudgetCents:
            row.date === todayInAccountTz
              ? (budgetByExternalId.get(row.entityId) ?? null)
              : sql`${adMetricsDaily.dailyBudgetCents}`,
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

  return { level, rows: rows.length, spendCents, conversions, warnings };
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

/**
 * Archives an ad account: it stops being ingested, stops appearing in the
 * cockpit and stops producing alerts, while every row it ever produced stays
 * exactly where it is.
 *
 * Deliberately not a delete. Approvals, change requests, guardrail events and
 * the append-only audit trail all reference the account, and two of its ads
 * carry real rejection reasons from the platform. Deleting would destroy
 * evidence to tidy a list; migrating the rows to another account would be
 * worse, inventing a history that account never had.
 *
 * Open alerts are resolved with the reason recorded on them, so nobody is left
 * with a red badge for an account nobody watches any more.
 */
export async function archiveAdAccount(
  db: Database,
  externalId: string,
  reason: string,
  now = new Date(),
): Promise<{ accountId: string; alertsResolved: number } | null> {
  const account = await db.query.adAccounts.findFirst({
    where: eq(adAccounts.externalId, externalId),
  });
  if (!account) return null;

  await db
    .update(adAccounts)
    .set({ archivedAt: now, archivedReason: reason, updatedAt: now })
    .where(eq(adAccounts.id, account.id));

  const resolved = await db
    .update(adAlerts)
    .set({
      resolvedAt: now,
      detail: sql`${adAlerts.detail} || ${JSON.stringify({ resolvedBecause: reason })}::jsonb`,
    })
    .where(and(eq(adAlerts.adAccountId, account.id), isNull(adAlerts.resolvedAt)))
    .returning({ id: adAlerts.id });

  return { accountId: account.id, alertsResolved: resolved.length };
}

/** Accounts the system should still mirror: everything not archived. */
export async function activeAdAccounts(db: Database, platform?: 'meta' | 'google' | 'tiktok') {
  return db.query.adAccounts.findMany({
    where: platform
      ? and(isNull(adAccounts.archivedAt), eq(adAccounts.platform, platform))
      : isNull(adAccounts.archivedAt),
  });
}
