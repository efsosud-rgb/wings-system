import {
  adDeliveryIssue,
  campaignDelivering,
  ufOfRegion,
  type AdPlatform,
  type CockpitAdWarning,
  type CockpitAlert,
  type CockpitCampaign,
  type CockpitDay,
  type CockpitFigures,
  type CockpitRegion,
  type DashboardCockpit,
  type DashboardWindow,
} from '@wings/shared';
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import {
  adAds,
  adAlerts,
  adCampaigns,
  adMetricsBreakdownDaily,
  adMetricsDaily,
  ga4TrafficDaily,
  rdCrmDeals,
} from '../../../db/schema/index.js';
import type { Env } from '../../../env.js';
import { ga4CredentialsOf } from '../../../lib/ga4.js';
import { activeAccounts, creatives } from './queries.js';
import { addDays, daysBetween, windowOf } from './window.js';

/**
 * Cockpit: the executive screen, from the same copies the other tabs read.
 * Every figure has its previous-window twin so the screen can say better or
 * worse; nothing here reaches a platform. Only campaigns that are delivering
 * count (`campaignDelivering`), in both windows; ads switched on but not
 * serving (in review, disapproved…) are listed as warnings and ranked nowhere.
 */

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export async function cockpit(
  db: Database,
  env: Env,
  days: DashboardWindow,
  now = new Date(),
): Promise<DashboardCockpit> {
  const window = windowOf(days, now);
  const accounts = await activeAccounts(db);
  const ids = accounts.map((account) => account.id);
  const platformOf = new Map(
    accounts.map((account) => [account.id, account.platform as AdPlatform]),
  );
  const siteOn = Boolean(env.GA4_PROPERTY_ID && ga4CredentialsOf(env));
  const [campaignRows, adRows] = ids.length
    ? await Promise.all([
        db.query.adCampaigns.findMany({ where: inArray(adCampaigns.adAccountId, ids) }),
        db.query.adAds.findMany({ where: inArray(adAds.adAccountId, ids) }),
      ])
    : [[], []];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  const active = campaignRows.filter((campaign) =>
    campaignDelivering(
      {
        platform: platformOf.get(campaign.adAccountId) ?? 'meta',
        status: campaign.status,
        deliveryStatus: campaign.deliveryStatus,
        endDate: campaign.endDate,
      },
      today,
    ),
  );
  const activeIds = new Set(active.map((campaign) => campaign.id));
  const activeExternal = active.map((campaign) => campaign.externalId);
  // No active campaign: every sum below is over nothing, not over everything.
  const none = ['-'];
  const dayRange = (column: typeof adMetricsDaily.day) =>
    and(gte(column, window.previousSince), lte(column, window.until));

  const [perDay, sessionsPerDay, deals, regionRows, creativeData, alertRows] = await Promise.all([
    ids.length
      ? db
          .select({
            day: adMetricsDaily.day,
            spend: sql<string>`coalesce(sum(${adMetricsDaily.spendCents}), 0)`,
            impressions: sql<string>`coalesce(sum(${adMetricsDaily.impressions}), 0)`,
            clicks: sql<string>`coalesce(sum(${adMetricsDaily.clicks}), 0)`,
            leads: sql<string>`coalesce(sum(${adMetricsDaily.conversions}), 0)`,
          })
          .from(adMetricsDaily)
          .where(
            and(
              inArray(adMetricsDaily.adAccountId, ids),
              eq(adMetricsDaily.level, 'campaign'),
              inArray(
                adMetricsDaily.entityExternalId,
                activeExternal.length ? activeExternal : none,
              ),
              dayRange(adMetricsDaily.day),
            ),
          )
          .groupBy(adMetricsDaily.day)
      : [],
    db
      .select({ day: ga4TrafficDaily.day, sessions: sql<string>`sum(${ga4TrafficDaily.sessions})` })
      .from(ga4TrafficDaily)
      .where(
        and(gte(ga4TrafficDaily.day, window.previousSince), lte(ga4TrafficDaily.day, window.until)),
      )
      .groupBy(ga4TrafficDaily.day),
    db
      .select({
        createdAt: rdCrmDeals.createdAt,
        reachedMeeting: rdCrmDeals.reachedMeeting,
        win: rdCrmDeals.win,
      })
      .from(rdCrmDeals)
      .where(
        and(
          isNotNull(rdCrmDeals.platform),
          gte(rdCrmDeals.createdAt, new Date(`${window.previousSince}T00:00:00-03:00`)),
          lte(rdCrmDeals.createdAt, new Date(`${window.until}T23:59:59-03:00`)),
        ),
      ),
    ids.length
      ? db
          .select({
            key: adMetricsBreakdownDaily.key,
            spend: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.spendCents}), 0)`,
            leads: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.conversions}), 0)`,
            impressions: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.impressions}), 0)`,
          })
          .from(adMetricsBreakdownDaily)
          .where(
            and(
              inArray(adMetricsBreakdownDaily.adAccountId, ids),
              inArray(
                adMetricsBreakdownDaily.campaignExternalId,
                activeExternal.length ? activeExternal : none,
              ),
              eq(adMetricsBreakdownDaily.kind, 'region'),
              gte(adMetricsBreakdownDaily.day, window.since),
              lte(adMetricsBreakdownDaily.day, window.until),
            ),
          )
          .groupBy(adMetricsBreakdownDaily.key)
      : [],
    creatives(db, days, now),
    ids.length
      ? db
          .select({
            id: adAlerts.id,
            severity: adAlerts.severity,
            title: adAlerts.title,
            firstSeenAt: adAlerts.firstSeenAt,
            lastSeenAt: adAlerts.lastSeenAt,
            adAccountId: adAlerts.adAccountId,
          })
          .from(adAlerts)
          .where(and(inArray(adAlerts.adAccountId, ids), isNull(adAlerts.resolvedAt)))
          .orderBy(desc(adAlerts.lastSeenAt))
      : [],
  ]);

  const inCurrent = (day: string) => day >= window.since && day <= window.until;
  const byDay = new Map(perDay.map((row) => [row.day, row]));
  const sessionsByDay = new Map(sessionsPerDay.map((row) => [row.day, Number(row.sessions)]));
  const dealDay = (at: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(at);

  const figures = (current: boolean): CockpitFigures => {
    const rows = perDay.filter((row) => inCurrent(row.day) === current);
    const sum = (pick: (row: (typeof perDay)[number]) => string) =>
      rows.reduce((total, row) => total + Number(pick(row)), 0);
    const windowDeals = deals.filter((deal) => inCurrent(dealDay(deal.createdAt)) === current);
    const sessions = [...sessionsByDay]
      .filter(([day]) => inCurrent(day) === current)
      .reduce((total, [, count]) => total + count, 0);
    return {
      spendCents: sum((row) => row.spend),
      impressions: sum((row) => row.impressions),
      clicks: sum((row) => row.clicks),
      leads: sum((row) => row.leads),
      sessions: siteOn ? sessions : null,
      crmLeads: windowDeals.length,
      meetings: windowDeals.filter((deal) => deal.reachedMeeting).length,
      sales: windowDeals.filter((deal) => deal.win === true).length,
    };
  };

  const daily: CockpitDay[] = daysBetween(window.since, window.until).map((day, index) => {
    const previousDay = addDays(window.previousSince, index);
    const now_ = byDay.get(day);
    const before = byDay.get(previousDay);
    return {
      day,
      previousDay,
      spendCents: Number(now_?.spend ?? 0),
      previousSpendCents: Number(before?.spend ?? 0),
      leads: Number(now_?.leads ?? 0),
      previousLeads: Number(before?.leads ?? 0),
      clicks: Number(now_?.clicks ?? 0),
      previousClicks: Number(before?.clicks ?? 0),
    };
  });

  const regions = new Map<string, CockpitRegion>();
  let otherRegionsSpendCents = 0;
  for (const row of regionRows) {
    const uf = ufOfRegion(row.key);
    if (!uf) {
      otherRegionsSpendCents += Number(row.spend);
      continue;
    }
    const entry = regions.get(uf) ?? { uf, spendCents: 0, leads: 0, impressions: 0 };
    entry.spendCents += Number(row.spend);
    entry.leads += Number(row.leads);
    entry.impressions += Number(row.impressions);
    regions.set(uf, entry);
  }

  const campaignById = new Map(campaignRows.map((campaign) => [campaign.id, campaign]));
  const adWarnings: CockpitAdWarning[] = [];
  const servingAds = new Set<string>();
  for (const ad of adRows) {
    if (!ad.campaignId || !activeIds.has(ad.campaignId)) continue;
    const platform = platformOf.get(ad.adAccountId) ?? 'meta';
    const issue = adDeliveryIssue({
      platform,
      status: ad.status,
      effectiveStatus: ad.effectiveStatus,
    });
    if (issue === null) servingAds.add(`${platform}:${ad.externalId}`);
    else if (issue !== 'off') {
      adWarnings.push({
        platform,
        adExternalId: ad.externalId,
        adName: ad.name,
        campaignName: campaignById.get(ad.campaignId)?.name ?? '',
        issue,
      });
    }
  }

  // Serving ads of active campaigns only. Leads first, then the cheapest
  // lead, then spend: what worked, at the top.
  const ranked = creativeData.creatives
    .filter((creative) => servingAds.has(`${creative.platform}:${creative.adExternalId}`))
    .sort(
      (a, b) =>
        b.totals.conversions - a.totals.conversions ||
        (a.totals.conversions > 0 && b.totals.conversions > 0
          ? a.totals.spendCents / a.totals.conversions - b.totals.spendCents / b.totals.conversions
          : 0) ||
        b.totals.spendCents - a.totals.spendCents,
    );

  const alerts: CockpitAlert[] = alertRows
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
    .slice(0, 8)
    .map((row) => ({
      id: row.id,
      severity: row.severity,
      title: row.title,
      firstSeenAt: row.firstSeenAt.toISOString(),
      platform: platformOf.get(row.adAccountId) ?? 'meta',
    }));

  return {
    days,
    since: window.since,
    until: window.until,
    previousSince: window.previousSince,
    previousUntil: window.previousUntil,
    current: figures(true),
    previous: figures(false),
    daily,
    regions: [...regions.values()].sort((a, b) => b.spendCents - a.spendCents),
    otherRegionsSpendCents,
    creatives: ranked.slice(0, 6),
    alerts,
    activeCampaigns: active
      .map((campaign): CockpitCampaign => ({
        platform: platformOf.get(campaign.adAccountId) ?? 'meta',
        externalId: campaign.externalId,
        name: campaign.name,
        deliveryStatus: campaign.deliveryStatus,
        endDate: campaign.endDate,
      }))
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name)),
    adWarnings,
  };
}
