import type {
  AdPlatform,
  DashboardFunnel,
  DashboardSite,
  DashboardWindow,
  FunnelCampaignRow,
  FunnelPlatformRow,
  SiteTrafficRow,
} from '@wings/shared';
import { and, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import {
  adCampaignDrafts,
  adCampaigns,
  ga4TrafficDaily,
  rdCrmDeals,
} from '../../../db/schema/index.js';
import type { Env } from '../../../env.js';
import { ga4CredentialsOf } from '../../../lib/ga4.js';
import { activeAccounts, sumsByEntity } from './queries.js';
import { windowOf } from './window.js';

/**
 * After the click. `site()` is the GA4 view by source / medium / campaign;
 * `funnel()` follows each ad campaign from impression to the site session and
 * the lead, and each platform down to the RD CRM's meetings and sales.
 *
 * Why the CRM stops at the platform: RD's deals carry RD's own labels ("Busca
 * Paga | Facebook Ads", "META ADS"), not the ad campaign. A per-campaign sale
 * needs the lead's UTM kept with the deal (CRM próprio, fase 1, §1.4).
 */

const siteConfigured = (env: Env) => Boolean(env.GA4_PROPERTY_ID && ga4CredentialsOf(env));

export async function site(
  db: Database,
  env: Env,
  days: DashboardWindow,
  now = new Date(),
): Promise<DashboardSite> {
  const window = windowOf(days, now);
  const rows = await db
    .select({
      source: ga4TrafficDaily.source,
      medium: ga4TrafficDaily.medium,
      campaign: ga4TrafficDaily.campaign,
      sessions: sql<string>`sum(${ga4TrafficDaily.sessions})`,
      engagedSessions: sql<string>`sum(${ga4TrafficDaily.engagedSessions})`,
      engagementSeconds: sql<string>`sum(${ga4TrafficDaily.engagementSeconds})`,
      pageViews: sql<string>`sum(${ga4TrafficDaily.pageViews})`,
      keyEvents: sql<string>`sum(${ga4TrafficDaily.keyEvents})`,
      fetchedAt: sql<Date | null>`max(${ga4TrafficDaily.fetchedAt})`,
    })
    .from(ga4TrafficDaily)
    .where(and(gte(ga4TrafficDaily.day, window.since), lte(ga4TrafficDaily.day, window.until)))
    .groupBy(ga4TrafficDaily.source, ga4TrafficDaily.medium, ga4TrafficDaily.campaign);

  const list: SiteTrafficRow[] = rows
    .map((row) => ({
      source: row.source,
      medium: row.medium,
      campaign: row.campaign,
      sessions: Number(row.sessions),
      engagedSessions: Number(row.engagedSessions),
      engagementSeconds: Number(row.engagementSeconds),
      pageViews: Number(row.pageViews),
      keyEvents: Number(row.keyEvents),
    }))
    .sort((a, b) => b.sessions - a.sessions);
  const totals = list.reduce(
    (sum, row) => ({
      sessions: sum.sessions + row.sessions,
      engagedSessions: sum.engagedSessions + row.engagedSessions,
      engagementSeconds: sum.engagementSeconds + row.engagementSeconds,
      pageViews: sum.pageViews + row.pageViews,
      keyEvents: sum.keyEvents + row.keyEvents,
    }),
    { sessions: 0, engagedSessions: 0, engagementSeconds: 0, pageViews: 0, keyEvents: 0 },
  );
  const fetched = rows.reduce<Date | null>((latest, row) => {
    const at = row.fetchedAt ? new Date(row.fetchedAt) : null;
    return at && (!latest || at > latest) ? at : latest;
  }, null);
  return {
    days,
    since: window.since,
    until: window.until,
    configured: siteConfigured(env),
    propertyId: env.GA4_PROPERTY_ID ?? null,
    fetchedAt: fetched?.toISOString() ?? null,
    totals,
    rows: list,
  };
}

const norm = (value: string) => value.trim().toLowerCase();

/** GA4 source/medium that a paid click from each platform arrives as. */
function platformOfSession(source: string, medium: string): AdPlatform | null {
  const s = norm(source);
  const m = norm(medium);
  const paid = /cpc|ppc|paid|cpm|ads/.test(m);
  if (paid && /facebook|instagram|^fb$|^ig$|meta/.test(s)) return 'meta';
  if (paid && /google/.test(s)) return 'google';
  return null;
}

export async function funnel(
  db: Database,
  env: Env,
  days: DashboardWindow,
  now = new Date(),
): Promise<DashboardFunnel> {
  const window = windowOf(days, now);
  const accounts = await activeAccounts(db);
  const ids = accounts.map((account) => account.id);
  const platformOf = new Map(
    accounts.map((account) => [account.id, account.platform as AdPlatform]),
  );
  const configured = siteConfigured(env);

  const [campaignRows, sums, drafts, sessions, deals] = await Promise.all([
    ids.length
      ? db.query.adCampaigns.findMany({ where: inArray(adCampaigns.adAccountId, ids) })
      : [],
    ids.length ? sumsByEntity(db, ids, 'campaign', window.since, window.until) : new Map(),
    ids.length
      ? db
          .select({ campaignId: adCampaignDrafts.campaignId, payload: adCampaignDrafts.payload })
          .from(adCampaignDrafts)
          .where(isNotNull(adCampaignDrafts.campaignId))
      : [],
    db
      .select({
        source: ga4TrafficDaily.source,
        medium: ga4TrafficDaily.medium,
        campaign: ga4TrafficDaily.campaign,
        sessions: sql<string>`sum(${ga4TrafficDaily.sessions})`,
      })
      .from(ga4TrafficDaily)
      .where(and(gte(ga4TrafficDaily.day, window.since), lte(ga4TrafficDaily.day, window.until)))
      .groupBy(ga4TrafficDaily.source, ga4TrafficDaily.medium, ga4TrafficDaily.campaign),
    db
      .select({
        platform: rdCrmDeals.platform,
        reachedMeeting: rdCrmDeals.reachedMeeting,
        win: rdCrmDeals.win,
        fetchedAt: rdCrmDeals.fetchedAt,
      })
      .from(rdCrmDeals)
      .where(
        and(
          gte(rdCrmDeals.createdAt, new Date(`${window.since}T00:00:00-03:00`)),
          lte(rdCrmDeals.createdAt, new Date(`${window.until}T23:59:59-03:00`)),
        ),
      ),
  ]);

  const sessionsByCampaign = new Map<string, number>();
  const sessionsByPlatform = new Map<AdPlatform, number>();
  for (const row of sessions) {
    const count = Number(row.sessions);
    sessionsByCampaign.set(
      norm(row.campaign),
      (sessionsByCampaign.get(norm(row.campaign)) ?? 0) + count,
    );
    const platform = platformOfSession(row.source, row.medium);
    if (platform) sessionsByPlatform.set(platform, (sessionsByPlatform.get(platform) ?? 0) + count);
  }
  const utmOf = new Map<string, string>();
  for (const draft of drafts) {
    const utm = (draft.payload as { utms?: { utm_campaign?: string } } | null)?.utms?.utm_campaign;
    if (draft.campaignId && utm) utmOf.set(draft.campaignId, utm);
  }

  const campaignsOut: FunnelCampaignRow[] = [];
  for (const campaign of campaignRows) {
    const totals = sums.get(campaign.externalId);
    const keys = [
      ...new Set([utmOf.get(campaign.id), campaign.name].filter(Boolean).map((key) => norm(key!))),
    ];
    const matched = keys.filter((key) => sessionsByCampaign.has(key));
    const siteSessions = matched.reduce(
      (total, key) => total + (sessionsByCampaign.get(key) ?? 0),
      0,
    );
    if (!totals?.impressions && siteSessions === 0) continue;
    campaignsOut.push({
      platform: platformOf.get(campaign.adAccountId) ?? 'meta',
      externalId: campaign.externalId,
      name: campaign.name,
      spendCents: totals?.spendCents ?? 0,
      impressions: totals?.impressions ?? 0,
      clicks: totals?.clicks ?? 0,
      sessions: configured ? siteSessions : null,
      leads: totals?.conversions ?? 0,
      matchedSiteCampaigns: matched,
    });
  }
  campaignsOut.sort((a, b) => b.spendCents - a.spendCents);

  const platformsOut: FunnelPlatformRow[] = (['meta', 'google'] as const)
    .filter((platform) => accounts.some((account) => account.platform === platform))
    .map((platform) => {
      const rows = campaignsOut.filter((row) => row.platform === platform);
      const crm = deals.filter((deal) => deal.platform === platform);
      return {
        platform,
        spendCents: rows.reduce((total, row) => total + row.spendCents, 0),
        impressions: rows.reduce((total, row) => total + row.impressions, 0),
        clicks: rows.reduce((total, row) => total + row.clicks, 0),
        sessions: configured ? (sessionsByPlatform.get(platform) ?? 0) : null,
        leads: rows.reduce((total, row) => total + row.leads, 0),
        crmLeads: crm.length,
        meetings: crm.filter((deal) => deal.reachedMeeting).length,
        sales: crm.filter((deal) => deal.win === true).length,
      };
    });

  const crmFetchedAt = deals.reduce<Date | null>(
    (latest, deal) => (!latest || deal.fetchedAt > latest ? deal.fetchedAt : latest),
    null,
  );
  return {
    days,
    since: window.since,
    until: window.until,
    siteConfigured: configured,
    crmConfigured: Boolean(env.RD_CRM_API_TOKEN),
    crmFetchedAt: crmFetchedAt?.toISOString() ?? null,
    campaigns: campaignsOut,
    platforms: platformsOut,
    crmUnattributed: deals.filter((deal) => deal.platform === null).length,
  };
}
