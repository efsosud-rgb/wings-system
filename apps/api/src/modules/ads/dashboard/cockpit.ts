import {
  CAMPAIGN_LEADS_SINCE,
  isQualifiedLead,
  adDeliveryIssue,
  campaignDelivering,
  ufOfRegion,
  type AdPlatform,
  type CockpitAdWarning,
  type CockpitAlert,
  type CockpitCampaignOption,
  type CockpitCampaign,
  type CockpitCampaignScope,
  type CockpitStatusSummary,
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
  adSets,
  adMetricsBreakdownDaily,
  adMetricsDaily,
  campaignLeads,
  ga4TrafficDaily,
  rdCrmDeals,
} from '../../../db/schema/index.js';
import type { Env } from '../../../env.js';
import { ga4CredentialsOf } from '../../../lib/ga4.js';
import { effectiveCampaignEnds } from '../campaign-end.js';
import { activeAccounts, creatives, sumsByEntity } from './queries.js';
import { confirmedTargets } from './targets.js';
import { addDays, daysBetween, windowOf } from './window.js';

/**
 * Cockpit: the executive screen, from the same copies the other tabs read.
 * Every figure has its previous-window twin so the screen can say better or
 * worse; nothing here reaches a platform. Only campaigns that are delivering
 * count (`campaignDelivering`), in both windows; ads switched on but not
 * serving (in review, disapproved…) are listed as warnings and ranked nowhere.
 */

const saoPauloDayOf = (at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(at);

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export async function cockpit(
  db: Database,
  env: Env,
  days: DashboardWindow,
  now = new Date(),
  campaignScope: CockpitCampaignScope = 'ativas',
  pickedIds: string[] = [],
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
  // A campaign with no end of its own ends with its ad sets that are on (Meta keeps the schedule there).
  const endOf = await effectiveCampaignEnds(db, campaignRows);
  const active = campaignRows.filter((campaign) =>
    campaignDelivering(
      {
        platform: platformOf.get(campaign.adAccountId) ?? 'meta',
        status: campaign.status,
        deliveryStatus: campaign.deliveryStatus,
        endDate: endOf.get(campaign.id) ?? null,
      },
      today,
    ),
  );
  const activeIds = new Set(active.map((campaign) => campaign.id));
  const activeExternal = active.map((campaign) => campaign.externalId);
  // "Ativo" is the status a person set; "entregando" is the rule above. The chip
  // says both, so 4 campaigns marked active and 2 in the figures do not look like a mistake.
  const withActiveStatus = campaignRows.filter((campaign) => campaign.status === 'ACTIVE');
  const endedCampaigns = withActiveStatus.filter((campaign) => {
    const end = endOf.get(campaign.id);
    return Boolean(end && end < today);
  });
  const deliveringCount = withActiveStatus.filter((campaign) => activeIds.has(campaign.id)).length;
  const statusSummary: CockpitStatusSummary = {
    withStatus: withActiveStatus.length,
    delivering: deliveringCount,
    ended: endedCampaigns
      .map((campaign) => ({
        platform: platformOf.get(campaign.adAccountId) ?? ('meta' as AdPlatform),
        name: campaign.name,
        endDate: endOf.get(campaign.id)!,
      }))
      .sort((a, b) => a.endDate.localeCompare(b.endDate) || a.name.localeCompare(b.name)),
    notDelivering: withActiveStatus.length - deliveringCount - endedCampaigns.length,
  };
  // No active campaign: every sum below is over nothing, not over everything.
  const none = ['-'];
  const dayRange = (column: typeof adMetricsDaily.day) =>
    and(gte(column, window.previousSince), lte(column, window.until));

  // "Todas": also the paused and ended campaigns that delivered in either
  // window. "Só ativas" (the default): only the ones delivering now.
  let inScope = active;
  if (campaignScope === 'todas' && ids.length) {
    const delivered = await db
      .selectDistinct({
        accountId: adMetricsDaily.adAccountId,
        externalId: adMetricsDaily.entityExternalId,
      })
      .from(adMetricsDaily)
      .where(
        and(
          inArray(adMetricsDaily.adAccountId, ids),
          eq(adMetricsDaily.level, 'campaign'),
          dayRange(adMetricsDaily.day),
          sql`(${adMetricsDaily.spendCents} > 0 or ${adMetricsDaily.impressions} > 0)`,
        ),
      );
    const keys = new Set(delivered.map((row) => `${row.accountId}:${row.externalId}`));
    inScope = campaignRows.filter(
      (campaign) =>
        activeIds.has(campaign.id) || keys.has(`${campaign.adAccountId}:${campaign.externalId}`),
    );
  }
  // The picker offers every campaign of the scope; a pick narrows all that follows.
  const campaignOptions: CockpitCampaignOption[] = inScope
    .map((campaign) => ({
      id: campaign.id,
      platform: platformOf.get(campaign.adAccountId) ?? ('meta' as AdPlatform),
      name: campaign.name,
      delivering: activeIds.has(campaign.id),
    }))
    .sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
  const picking = pickedIds.length > 0;
  if (picking) {
    const picked = new Set(pickedIds);
    inScope = inScope.filter((campaign) => picked.has(campaign.id));
  }
  const scopeIds = new Set(inScope.map((campaign) => campaign.id));
  const scopeExternal = inScope.map((campaign) => campaign.externalId);

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
              inArray(adMetricsDaily.entityExternalId, scopeExternal.length ? scopeExternal : none),
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
          eq(rdCrmDeals.isTest, false),
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
                scopeExternal.length ? scopeExternal : none,
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
            entityLevel: adAlerts.entityLevel,
            entityExternalId: adAlerts.entityExternalId,
          })
          .from(adAlerts)
          .where(and(inArray(adAlerts.adAccountId, ids), isNull(adAlerts.resolvedAt)))
          .orderBy(desc(adAlerts.lastSeenAt))
      : [],
  ]);

  // Picked campaigns: RD's CRM figures come from the leads attributed to them
  // (`campaign_leads`, counted from 28/09), not from the paid-platform totals.
  const crmSince = saoPauloDayOf(new Date(CAMPAIGN_LEADS_SINCE));
  const pickedLeads =
    picking && scopeIds.size
      ? await db.query.campaignLeads.findMany({
          where: and(
            inArray(campaignLeads.campaignId, [...scopeIds]),
            eq(campaignLeads.isTest, false),
            gte(campaignLeads.enteredAt, new Date(`${window.previousSince}T00:00:00-03:00`)),
            lte(campaignLeads.enteredAt, new Date(`${window.until}T23:59:59-03:00`)),
          ),
          columns: { enteredAt: true, win: true },
        })
      : [];

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
    const windowLeads = pickedLeads.filter(
      (lead) => inCurrent(dealDay(lead.enteredAt)) === current,
    );
    // The attribution starts on `crmSince`: a window that ends before it has nothing to count.
    const attributed = (current ? window.until : window.previousUntil) >= crmSince;
    const sessions = [...sessionsByDay]
      .filter(([day]) => inCurrent(day) === current)
      .reduce((total, [, count]) => total + count, 0);
    return {
      spendCents: sum((row) => row.spend),
      impressions: sum((row) => row.impressions),
      clicks: sum((row) => row.clicks),
      leads: sum((row) => row.leads),
      sessions: siteOn && !picking ? sessions : null,
      crmLeads: picking ? (attributed ? windowLeads.length : null) : windowDeals.length,
      meetings: picking ? null : windowDeals.filter((deal) => deal.reachedMeeting).length,
      sales: picking
        ? attributed
          ? windowLeads.filter((lead) => lead.win === true).length
          : null
        : windowDeals.filter((deal) => deal.win === true).length,
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
  const scopeAds = new Set(
    adRows
      .filter((ad) => ad.campaignId && scopeIds.has(ad.campaignId))
      .map((ad) => `${platformOf.get(ad.adAccountId) ?? 'meta'}:${ad.externalId}`),
  );
  for (const ad of adRows) {
    if (!ad.campaignId || !activeIds.has(ad.campaignId) || !scopeIds.has(ad.campaignId)) continue;
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

  // "Só ativas": serving ads of active campaigns. "Todas": every ad of the
  // campaigns in scope that delivered. Leads first, then the cheapest lead,
  // then spend: what worked, at the top.
  const ranked = creativeData.creatives
    .filter((creative) =>
      (campaignScope === 'todas' ? scopeAds : servingAds).has(
        `${creative.platform}:${creative.adExternalId}`,
      ),
    )
    .sort(
      (a, b) =>
        b.totals.conversions - a.totals.conversions ||
        (a.totals.conversions > 0 && b.totals.conversions > 0
          ? a.totals.spendCents / a.totals.conversions - b.totals.spendCents / b.totals.conversions
          : 0) ||
        b.totals.spendCents - a.totals.spendCents,
    );

  // Only what belongs to a campaign in scope (or to the account itself): in
  // "Só ativas", an alert about an ad of a paused campaign is left out.
  const adSetRows = scopeIds.size
    ? await db.query.adSets.findMany({ where: inArray(adSets.campaignId, [...scopeIds]) })
    : [];
  const activeExternalIds = new Set(scopeExternal);
  const activeAdSets = new Set(adSetRows.map((row) => row.externalId));
  const activeAds = new Set(
    adRows
      .filter((row) => row.campaignId && scopeIds.has(row.campaignId))
      .map((row) => `${row.adAccountId}:${row.externalId}`),
  );
  const alertInScope = (row: (typeof alertRows)[number]) => {
    if (!row.entityLevel || !row.entityExternalId) return !picking; // account-wide: not a picked campaign's
    const key = `${row.adAccountId}:${row.entityExternalId}`;
    if (row.entityLevel === 'campaign') return activeExternalIds.has(row.entityExternalId);
    if (row.entityLevel === 'ad_set') return activeAdSets.has(row.entityExternalId);
    return activeAds.has(key);
  };

  const alerts: CockpitAlert[] = alertRows
    .filter(alertInScope)
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
    .slice(0, 8)
    .map((row) => ({
      id: row.id,
      severity: row.severity,
      title: row.title,
      firstSeenAt: row.firstSeenAt.toISOString(),
      platform: platformOf.get(row.adAccountId) ?? 'meta',
    }));

  // Performance ativa: RD leads of the active campaigns since 28/09.
  const activeSince = saoPauloDayOf(new Date(CAMPAIGN_LEADS_SINCE));
  // With a pick, the performance block judges the picked campaigns.
  const perfIds = picking ? scopeIds : activeIds;
  const perfExternal = picking ? scopeExternal : activeExternal;
  const [leadRows, [activeSpend], [leadsFetched], [spendRead]] = await Promise.all([
    perfIds.size
      ? db.query.campaignLeads.findMany({
          where: and(
            inArray(campaignLeads.campaignId, [...perfIds]),
            eq(campaignLeads.isTest, false),
            gte(campaignLeads.enteredAt, new Date(CAMPAIGN_LEADS_SINCE)),
          ),
        })
      : [],
    perfExternal.length
      ? db
          .select({ spend: sql<string>`coalesce(sum(${adMetricsDaily.spendCents}), 0)` })
          .from(adMetricsDaily)
          .where(
            and(
              inArray(adMetricsDaily.adAccountId, ids),
              eq(adMetricsDaily.level, 'campaign'),
              inArray(adMetricsDaily.entityExternalId, perfExternal),
              gte(adMetricsDaily.day, activeSince),
            ),
          )
      : [{ spend: '0' }],
    db.select({ at: sql<string | null>`max(${campaignLeads.fetchedAt})` }).from(campaignLeads),
    // When the platforms were last read for the campaigns every figure is summed over.
    scopeExternal.length
      ? db
          .select({ at: sql<string | null>`max(${adMetricsDaily.fetchedAt})` })
          .from(adMetricsDaily)
          .where(
            and(
              inArray(adMetricsDaily.adAccountId, ids),
              eq(adMetricsDaily.level, 'campaign'),
              inArray(adMetricsDaily.entityExternalId, scopeExternal),
              gte(adMetricsDaily.day, window.previousSince),
            ),
          )
      : [{ at: null }],
  ]);
  const spendSince = Number(activeSpend?.spend ?? 0);
  const qualified = leadRows.filter(isQualifiedLead).length;
  const won = leadRows.filter((row) => row.win === true);
  const revenueCents = won.reduce((total, row) => total + row.amountCents, 0);
  const perUnit = (count: number) => (count > 0 ? Math.round(spendSince / count) : null);

  // For the visual cards: today's spend and the budget in force per active
  // campaign (the forecast's rule: an ABO campaign's budget is its active
  // ad sets'), the window's spend per platform and the confirmed CPL target.
  const [todayRows, windowByCampaign, targets] = await Promise.all([
    sumsByEntity(db, ids, 'campaign', today, today),
    sumsByEntity(db, ids, 'campaign', window.since, window.until),
    confirmedTargets(db),
  ]);
  const dailyBudgetOf = (campaign: (typeof active)[number]) => {
    const daily =
      campaign.budgetLevel === 'ad_set'
        ? adSetRows
            .filter((row) => row.campaignId === campaign.id && row.status === 'ACTIVE')
            .reduce((total, row) => total + (row.dailyBudgetCents ?? 0), 0)
        : campaign.dailyBudgetCents;
    return daily || null;
  };
  const spendByPlatform: Record<AdPlatform, number> = { meta: 0, google: 0 };
  for (const campaign of inScope) {
    const platform = platformOf.get(campaign.adAccountId) ?? 'meta';
    spendByPlatform[platform] += windowByCampaign.get(campaign.externalId)?.spendCents ?? 0;
  }

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
    campaignScope,
    activeCampaigns: inScope
      .map((campaign): CockpitCampaign => ({
        id: campaign.id,
        platform: platformOf.get(campaign.adAccountId) ?? 'meta',
        externalId: campaign.externalId,
        name: campaign.name,
        deliveryStatus: campaign.deliveryStatus,
        delivering: activeIds.has(campaign.id),
        startDate: campaign.startDate,
        endDate: endOf.get(campaign.id) ?? null,
        dailyBudgetCents: dailyBudgetOf(campaign),
        spentTodayCents: todayRows.get(campaign.externalId)?.spendCents ?? 0,
      }))
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name)),
    campaignOptions,
    selection: picking
      ? {
          ids: inScope.map((campaign) => campaign.id),
          unknown: pickedIds.length - inScope.length,
          crmSince: window.since < crmSince ? crmSince : null,
          why: {
            sessions: 'as sessões do site não são separadas por campanha',
            crmLeads:
              window.until < crmSince
                ? `a atribuição de leads a campanhas começou em ${crmSince.split('-').reverse().join('/')}`
                : null,
            meetings: 'o RD não atribui reuniões a uma campanha',
            sales:
              window.until < crmSince
                ? `a atribuição de vendas a campanhas começou em ${crmSince.split('-').reverse().join('/')}`
                : null,
          },
        }
      : null,
    adWarnings,
    activePerformance: {
      since: activeSince,
      spendCents: spendSince,
      leads: leadRows.length,
      qualified,
      sales: won.length,
      revenueCents,
      costPerLeadCents: perUnit(leadRows.length),
      costPerQualifiedCents: perUnit(qualified),
      cacCents: perUnit(won.length),
      roasCentuple:
        won.length && spendSince > 0 ? Math.round((revenueCents / spendSince) * 100) : null,
      smallSample: leadRows.length < 10,
      fetchedAt: leadsFetched?.at ? new Date(leadsFetched.at).toISOString() : null,
    },
    statusSummary,
    spendReadAt: spendRead?.at ? new Date(spendRead.at).toISOString() : null,
    spendByPlatform,
    cplTargetCents: targets.get('leads') ?? null,
    today,
  };
}
