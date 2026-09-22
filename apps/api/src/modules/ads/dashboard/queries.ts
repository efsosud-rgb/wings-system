import {
  addTotals,
  EMPTY_TOTALS,
  fatigueOf,
  ratiosOf,
  type AdNode,
  type AdPlatform,
  type AdSetNode,
  type BreakdownKind,
  type CampaignNode,
  type CreativePerformance,
  type DashboardAudience,
  type DashboardCampaigns,
  type DashboardCreatives,
  type DashboardOverview,
  type DashboardPlatforms,
  type DashboardWindow,
  type FormatPerformance,
  type MetricTotals,
  type MirroredFormat,
  type SpendStrip,
} from '@wings/shared';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import {
  adAccountDaily,
  adAccounts,
  adAds,
  adAlerts,
  adCampaigns,
  adCreatives,
  adMetricsBreakdownDaily,
  adMetricsDaily,
  adSets,
  agentMessages,
  integrationConnections,
  mediaCreditLedger,
} from '../../../db/schema/index.js';
import type { Env } from '../../../env.js';
import { getPeriodState } from '../budget-guard.js';
import { usdToBrlCents } from '../../media/providers/quota.js';
import { addDays, daysBetween, forecastOf, monthOf, windowOf } from './window.js';

/**
 * Everything the marketing dashboard shows, read from our own tables.
 *
 * No function here calls a platform. The figures are whatever the ingest job
 * mirrored last, and the screen says when that was. Sums are computed at read
 * time from the daily rows, so a window is always internally consistent; the
 * index `ad_metrics_daily_account_level_day_idx` is what keeps that cheap.
 */

const PLATFORMS: AdPlatform[] = ['meta', 'google'];

export type Account = typeof adAccounts.$inferSelect;

export async function activeAccounts(db: Database): Promise<Account[]> {
  return db.query.adAccounts.findMany({
    where: and(isNull(adAccounts.archivedAt), inArray(adAccounts.platform, PLATFORMS)),
    orderBy: adAccounts.createdAt,
  });
}

const sumColumns = {
  spendCents: sql<string>`coalesce(sum(${adMetricsDaily.spendCents}), 0)`,
  impressions: sql<string>`coalesce(sum(${adMetricsDaily.impressions}), 0)`,
  clicks: sql<string>`coalesce(sum(${adMetricsDaily.clicks}), 0)`,
  reach: sql<string>`coalesce(sum(${adMetricsDaily.reach}), 0)`,
  conversions: sql<string>`coalesce(sum(${adMetricsDaily.conversions}), 0)`,
  videoPlays: sql<string>`coalesce(sum(${adMetricsDaily.videoPlays}), 0)`,
  videoThruplays: sql<string>`coalesce(sum(${adMetricsDaily.videoThruplays}), 0)`,
  videoP25: sql<string>`coalesce(sum(${adMetricsDaily.videoP25}), 0)`,
  videoP50: sql<string>`coalesce(sum(${adMetricsDaily.videoP50}), 0)`,
  videoP75: sql<string>`coalesce(sum(${adMetricsDaily.videoP75}), 0)`,
  videoP100: sql<string>`coalesce(sum(${adMetricsDaily.videoP100}), 0)`,
};

type SumRow = Record<keyof typeof sumColumns, string>;

function totalsOf(row: SumRow): MetricTotals {
  return {
    spendCents: Number(row.spendCents),
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    reach: Number(row.reach),
    conversions: Number(row.conversions),
    videoPlays: Number(row.videoPlays),
    videoThruplays: Number(row.videoThruplays),
    videoP25: Number(row.videoP25),
    videoP50: Number(row.videoP50),
    videoP75: Number(row.videoP75),
    videoP100: Number(row.videoP100),
  };
}

/** Sums of one level over the accounts and days, grouped by entity. */
export async function sumsByEntity(
  db: Database,
  accountIds: string[],
  level: 'campaign' | 'ad_set' | 'ad',
  since: string,
  until: string,
): Promise<Map<string, MetricTotals>> {
  const byEntity = new Map<string, MetricTotals>();
  if (accountIds.length === 0) return byEntity;
  const rows = await db
    .select({ entity: adMetricsDaily.entityExternalId, ...sumColumns })
    .from(adMetricsDaily)
    .where(
      and(
        inArray(adMetricsDaily.adAccountId, accountIds),
        eq(adMetricsDaily.level, level),
        gte(adMetricsDaily.day, since),
        lte(adMetricsDaily.day, until),
      ),
    )
    .groupBy(adMetricsDaily.entityExternalId);
  for (const row of rows) byEntity.set(row.entity, totalsOf(row));
  return byEntity;
}

/** One campaign-level sum over the accounts and days. */
async function sumsOf(
  db: Database,
  accountIds: string[],
  since: string,
  until: string,
): Promise<MetricTotals> {
  if (accountIds.length === 0) return EMPTY_TOTALS;
  const [row] = await db
    .select(sumColumns)
    .from(adMetricsDaily)
    .where(
      and(
        inArray(adMetricsDaily.adAccountId, accountIds),
        eq(adMetricsDaily.level, 'campaign'),
        gte(adMetricsDaily.day, since),
        lte(adMetricsDaily.day, until),
      ),
    );
  return row ? totalsOf(row) : EMPTY_TOTALS;
}

/** Campaign-level spend per day, every day of the span present. */
async function dailySpend(
  db: Database,
  accountIds: string[],
  since: string,
  until: string,
): Promise<{ day: string; amount: number }[]> {
  const byDay = new Map(daysBetween(since, until).map((day) => [day, 0]));
  if (accountIds.length > 0) {
    const rows = await db
      .select({
        day: adMetricsDaily.day,
        spendCents: sql<string>`coalesce(sum(${adMetricsDaily.spendCents}), 0)`,
      })
      .from(adMetricsDaily)
      .where(
        and(
          inArray(adMetricsDaily.adAccountId, accountIds),
          eq(adMetricsDaily.level, 'campaign'),
          gte(adMetricsDaily.day, since),
          lte(adMetricsDaily.day, until),
        ),
      )
      .groupBy(adMetricsDaily.day);
    for (const row of rows) if (byDay.has(row.day)) byDay.set(row.day, Number(row.spendCents));
  }
  return [...byDay].map(([day, amount]) => ({ day, amount }));
}

async function metricsFetchedAt(db: Database, accountIds: string[]): Promise<string | null> {
  if (accountIds.length === 0) return null;
  const [row] = await db
    .select({ fetchedAt: sql<Date | null>`max(${adMetricsDaily.fetchedAt})` })
    .from(adMetricsDaily)
    .where(inArray(adMetricsDaily.adAccountId, accountIds));
  return row?.fetchedAt ? new Date(row.fetchedAt).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** The latest `ad_account_daily` row of each account, by account id. */
async function latestAccountDays(db: Database, accountIds: string[]) {
  const latest = new Map<string, typeof adAccountDaily.$inferSelect>();
  if (accountIds.length === 0) return latest;
  const rows = await db
    .select()
    .from(adAccountDaily)
    .where(inArray(adAccountDaily.adAccountId, accountIds))
    .orderBy(desc(adAccountDaily.day));
  for (const row of rows) if (!latest.has(row.adAccountId)) latest.set(row.adAccountId, row);
  return latest;
}

/** Sums that stay null when every input is null: "no ceiling" is not "zero". */
function sumOrNull(values: (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

async function paidStrip(
  db: Database,
  platform: AdPlatform,
  accounts: Account[],
  month: ReturnType<typeof monthOf>,
): Promise<SpendStrip> {
  const ids = accounts.map((account) => account.id);
  const [states, latest, daily] = await Promise.all([
    Promise.all(ids.map((id) => getPeriodState(db, id, month.periodMonth))),
    latestAccountDays(db, ids),
    dailySpend(db, ids, month.periodMonth, month.today),
  ]);

  // Money truth is the guard's own reconciled figure, not the analytics rows.
  const spent = states.reduce((total, state) => total + (state?.spentCents ?? 0), 0);
  const days = [...latest.values()];
  const balances = days.map((row) => row.prepaidBalanceCents ?? row.platformRemainingCents);
  const balanceSource =
    days.length === 0
      ? null
      : days.some((row) => row.prepaidBalanceCents !== null)
        ? `${platform}.prepaid_balance`
        : platform === 'meta'
          ? 'meta.spend_cap'
          : 'google.account_budget';

  return {
    source: platform,
    unit: 'brl',
    configured: accounts.length > 0,
    spent,
    forecast: accounts.length > 0 ? forecastOf(spent, month) : null,
    available: sumOrNull(states.map((state) => state?.availableCents ?? null)),
    balance: sumOrNull(balances),
    balanceSource: sumOrNull(balances) === null ? null : balanceSource,
    ceiling: sumOrNull(states.map((state) => state?.capCents ?? null)),
    daily,
    activeDailyBudget:
      days.length === 0 ? null : days.reduce((total, row) => total + row.activeDailyBudgetCents, 0),
    refreshedAt:
      days.length === 0
        ? null
        : new Date(Math.max(...days.map((row) => row.fetchedAt.getTime()))).toISOString(),
    killSwitchEngaged: accounts.some((account) => account.killSwitchEngaged),
  };
}

/** A per-day series from ledger-style rows, every day of the month present. */
function seriesOf(
  rows: { day: string; amount: string }[],
  month: ReturnType<typeof monthOf>,
): { day: string; amount: number }[] {
  const byDay = new Map(daysBetween(month.periodMonth, month.today).map((day) => [day, 0]));
  for (const row of rows) if (byDay.has(row.day)) byDay.set(row.day, Number(row.amount));
  return [...byDay].map(([day, amount]) => ({ day, amount }));
}

/** `created_at` as a São Paulo day, for grouping ledger rows. */
const ledgerDay = (column: typeof mediaCreditLedger.createdAt | typeof agentMessages.createdAt) =>
  sql<string>`to_char(${column} at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')`;

async function kairogenStrip(
  db: Database,
  env: Env,
  month: ReturnType<typeof monthOf>,
  monthStart: Date,
): Promise<SpendStrip> {
  const [connection] = await db
    .select({ state: integrationConnections.state })
    .from(integrationConnections)
    .where(eq(integrationConnections.provider, 'kairogen'))
    .limit(1);
  const rows = await db
    .select({
      day: ledgerDay(mediaCreditLedger.createdAt),
      amount: sql<string>`coalesce(sum(${mediaCreditLedger.creditsDelta}), 0)`,
    })
    .from(mediaCreditLedger)
    .where(
      and(eq(mediaCreditLedger.provider, 'kairogen'), gte(mediaCreditLedger.createdAt, monthStart)),
    )
    .groupBy(ledgerDay(mediaCreditLedger.createdAt));
  const [balance] = await db
    .select({ balance: mediaCreditLedger.balanceReported, at: mediaCreditLedger.createdAt })
    .from(mediaCreditLedger)
    .where(sql`${mediaCreditLedger.balanceReported} is not null`)
    .orderBy(desc(mediaCreditLedger.createdAt))
    .limit(1);

  const daily = seriesOf(rows, month);
  const spent = daily.reduce((total, point) => total + point.amount, 0);
  const configured = connection?.state === 'connected';
  return {
    source: 'kairogen',
    unit: 'credits',
    configured,
    spent,
    forecast: configured ? forecastOf(spent, month) : null,
    available: Math.max(0, env.KAIROGEN_MONTHLY_CREDITS - spent),
    balance: balance?.balance ?? null,
    balanceSource: balance ? 'kairogen.get_credits' : null,
    ceiling: env.KAIROGEN_MONTHLY_CREDITS,
    daily,
    activeDailyBudget: null,
    refreshedAt: balance?.at ? balance.at.toISOString() : null,
    killSwitchEngaged: false,
  };
}

async function aiStrip(
  db: Database,
  env: Env,
  month: ReturnType<typeof monthOf>,
  monthStart: Date,
): Promise<SpendStrip> {
  const rows = await db
    .select({
      day: ledgerDay(agentMessages.createdAt),
      amount: sql<string>`coalesce(sum(${agentMessages.costMicroUsd}), 0)`,
    })
    .from(agentMessages)
    .where(gte(agentMessages.createdAt, monthStart))
    .groupBy(ledgerDay(agentMessages.createdAt));
  // Millionths of a dollar into cents of reais, at the rate the ledger uses.
  const daily = seriesOf(rows, month).map((point) => ({
    day: point.day,
    amount: usdToBrlCents(point.amount / 1_000_000, env.BRL_PER_USD),
  }));
  const spent = daily.reduce((total, point) => total + point.amount, 0);
  const configured = Boolean(env.OPENROUTER_API_KEY);
  return {
    source: 'ai',
    unit: 'brl',
    configured,
    spent,
    forecast: configured ? forecastOf(spent, month) : null,
    // The agent's ceiling is per person per day (AGENT_DAILY_USD); the month has none.
    available: null,
    balance: null,
    balanceSource: null,
    ceiling: null,
    daily,
    activeDailyBudget: usdToBrlCents(env.AGENT_DAILY_USD, env.BRL_PER_USD),
    refreshedAt: null,
    killSwitchEngaged: false,
  };
}

async function mediaStrip(
  db: Database,
  env: Env,
  month: ReturnType<typeof monthOf>,
  monthStart: Date,
): Promise<SpendStrip> {
  const rows = await db
    .select({
      day: ledgerDay(mediaCreditLedger.createdAt),
      amount: sql<string>`coalesce(sum(${mediaCreditLedger.brlCentsDelta}), 0)`,
    })
    .from(mediaCreditLedger)
    .where(gte(mediaCreditLedger.createdAt, monthStart))
    .groupBy(ledgerDay(mediaCreditLedger.createdAt));
  const daily = seriesOf(rows, month);
  const spent = daily.reduce((total, point) => total + point.amount, 0);
  const ceiling = Math.round(env.MEDIA_MONTHLY_BRL * 100);
  const configured = Boolean(
    env.CF_WORKERS_AI_TOKEN || env.GEMINI_API_KEY || env.HIGGSFIELD_API_KEY || env.MPT_BASE_URL,
  );
  return {
    source: 'media',
    unit: 'brl',
    configured,
    spent,
    forecast: configured ? forecastOf(spent, month) : null,
    available: Math.max(0, ceiling - spent),
    balance: null,
    balanceSource: null,
    ceiling,
    daily,
    activeDailyBudget: null,
    refreshedAt: null,
    killSwitchEngaged: false,
  };
}

export async function overview(db: Database, env: Env, now = new Date()): Promise<DashboardOverview> {
  const month = monthOf(now);
  const monthStart = new Date(`${month.periodMonth}T00:00:00-03:00`);
  const accounts = await activeAccounts(db);
  const ids = accounts.map((account) => account.id);

  const [meta, google, kairogen, ai, media] = await Promise.all([
    paidStrip(db, 'meta', accounts.filter((a) => a.platform === 'meta'), month),
    paidStrip(db, 'google', accounts.filter((a) => a.platform === 'google'), month),
    kairogenStrip(db, env, month, monthStart),
    aiStrip(db, env, month, monthStart),
    mediaStrip(db, env, month, monthStart),
  ]);

  const [alerts] = ids.length
    ? await db
        .select({
          open: sql<string>`count(*)`,
          critical: sql<string>`count(*) filter (where ${adAlerts.severity} = 'critical')`,
        })
        .from(adAlerts)
        .where(and(inArray(adAlerts.adAccountId, ids), isNull(adAlerts.resolvedAt)))
    : [];
  const [approvals] = ids.length
    ? await db
        .execute<{ count: string }>(
          sql`select count(*)::text as count from ad_approval_requests
               where ad_account_id in ${ids} and status in ('pending', 'escalated')`,
        )
        .then((result) => result.rows)
    : [];
  const [disapproved] = ids.length
    ? await db
        .select({ count: sql<string>`count(*)` })
        .from(adAds)
        .where(and(inArray(adAds.adAccountId, ids), eq(adAds.effectiveStatus, 'DISAPPROVED')))
    : [];

  return {
    periodMonth: month.periodMonth,
    elapsedDays: month.elapsedDays,
    totalDays: month.totalDays,
    strips: [meta, google, kairogen, ai, media],
    counts: {
      openAlerts: Number(alerts?.open ?? 0),
      criticalAlerts: Number(alerts?.critical ?? 0),
      pendingApprovals: Number(approvals?.count ?? 0),
      disapprovedAds: Number(disapproved?.count ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Per platform
// ---------------------------------------------------------------------------

export async function platforms(
  db: Database,
  days: DashboardWindow,
  now = new Date(),
): Promise<DashboardPlatforms> {
  const window = windowOf(days, now);
  const accounts = await activeAccounts(db);

  const result = await Promise.all(
    PLATFORMS.map(async (platform) => {
      const own = accounts.filter((account) => account.platform === platform);
      const ids = own.map((account) => account.id);
      const [current, previous, daily] = await Promise.all([
        sumsOf(db, ids, window.since, window.until),
        sumsOf(db, ids, window.previousSince, window.previousUntil),
        dailySpend(db, ids, window.since, window.until),
      ]);
      return {
        platform,
        accounts: own.map(({ id, name, externalId }) => ({ id, name, externalId })),
        current,
        previous,
        daily,
      };
    }),
  );

  return {
    days,
    since: window.since,
    until: window.until,
    previousSince: window.previousSince,
    platforms: result,
    metricsFetchedAt: await metricsFetchedAt(
      db,
      accounts.map((account) => account.id),
    ),
  };
}

// ---------------------------------------------------------------------------
// Campaigns → ad sets → ads
// ---------------------------------------------------------------------------

async function creativesByKey(db: Database, accountIds: string[]) {
  const byKey = new Map<string, { format: MirroredFormat; thumbnailUrl: string | null; title: string | null }>();
  if (accountIds.length === 0) return byKey;
  const rows = await db.query.adCreatives.findMany({
    where: inArray(adCreatives.adAccountId, accountIds),
  });
  for (const row of rows) {
    byKey.set(`${row.adAccountId}:${row.externalId}`, {
      format: row.format as MirroredFormat,
      thumbnailUrl: row.thumbnailUrl,
      title: row.title,
    });
  }
  return byKey;
}

export async function campaigns(
  db: Database,
  days: DashboardWindow,
  now = new Date(),
): Promise<DashboardCampaigns> {
  const window = windowOf(days, now);
  const accounts = await activeAccounts(db);
  const ids = accounts.map((account) => account.id);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  if (ids.length === 0) return { days, since: window.since, until: window.until, campaigns: [] };

  const [campaignRows, adSetRows, adRows, creatives, campaignSums, adSetSums, adSums, alertRows] =
    await Promise.all([
      db.query.adCampaigns.findMany({ where: inArray(adCampaigns.adAccountId, ids) }),
      db
        .select()
        .from(adSets)
        .innerJoin(adCampaigns, eq(adCampaigns.id, adSets.campaignId))
        .where(inArray(adCampaigns.adAccountId, ids))
        .then((rows) => rows.map((row) => row.ad_sets)),
      db.query.adAds.findMany({ where: inArray(adAds.adAccountId, ids) }),
      creativesByKey(db, ids),
      sumsByEntity(db, ids, 'campaign', window.since, window.until),
      sumsByEntity(db, ids, 'ad_set', window.since, window.until),
      sumsByEntity(db, ids, 'ad', window.since, window.until),
      db
        .select({ entityExternalId: adAlerts.entityExternalId })
        .from(adAlerts)
        .where(and(inArray(adAlerts.adAccountId, ids), isNull(adAlerts.resolvedAt))),
    ]);

  const adNode = (ad: (typeof adRows)[number]): AdNode => {
    const creative = ad.creativeExternalId
      ? creatives.get(`${ad.adAccountId}:${ad.creativeExternalId}`)
      : undefined;
    return {
      externalId: ad.externalId,
      name: ad.name,
      status: ad.status,
      effectiveStatus: ad.effectiveStatus,
      format: creative?.format ?? 'unknown',
      thumbnailUrl: creative?.thumbnailUrl ?? null,
      totals: adSums.get(ad.externalId) ?? EMPTY_TOTALS,
    };
  };
  const bySpend = <T extends { totals: MetricTotals; name: string }>(a: T, b: T) =>
    b.totals.spendCents - a.totals.spendCents || a.name.localeCompare(b.name, 'pt-BR');

  // An alert on an ad or an ad set is badged on the campaign above it.
  const campaignOfEntity = new Map<string, string>();
  const campaignExternalById = new Map(campaignRows.map((c) => [c.id, c.externalId]));
  for (const campaign of campaignRows) campaignOfEntity.set(campaign.externalId, campaign.externalId);
  for (const adSet of adSetRows) {
    const owner = campaignExternalById.get(adSet.campaignId);
    if (owner) campaignOfEntity.set(adSet.externalId, owner);
  }
  for (const ad of adRows) {
    const owner = ad.campaignId ? campaignExternalById.get(ad.campaignId) : undefined;
    if (owner) campaignOfEntity.set(ad.externalId, owner);
  }
  const alertCount = new Map<string, number>();
  for (const alert of alertRows) {
    const owner = alert.entityExternalId ? campaignOfEntity.get(alert.entityExternalId) : undefined;
    if (owner) alertCount.set(owner, (alertCount.get(owner) ?? 0) + 1);
  }

  const nodes: CampaignNode[] = campaignRows.map((campaign) => {
    const account = accountById.get(campaign.adAccountId);
    const ownAdSets = adSetRows.filter((adSet) => adSet.campaignId === campaign.id);
    const adSetNodes: AdSetNode[] = ownAdSets
      .map((adSet) => ({
        externalId: adSet.externalId,
        name: adSet.name,
        status: adSet.status,
        dailyBudgetCents: adSet.dailyBudgetCents || null,
        totals: adSetSums.get(adSet.externalId) ?? EMPTY_TOTALS,
        ads: adRows
          .filter((ad) => ad.adSetId === adSet.id)
          .map(adNode)
          .sort(bySpend),
      }))
      .sort(bySpend);
    const orphanAds = adRows
      .filter((ad) => ad.campaignId === campaign.id && !ad.adSetId)
      .map(adNode)
      .sort(bySpend);
    return {
      externalId: campaign.externalId,
      platform: (account?.platform ?? 'meta') as AdPlatform,
      accountName: account?.name ?? '',
      name: campaign.name,
      status: campaign.status,
      objective: campaign.objective,
      budgetLevel: campaign.budgetLevel,
      dailyBudgetCents: campaign.dailyBudgetCents || null,
      totals: campaignSums.get(campaign.externalId) ?? EMPTY_TOTALS,
      adSets: adSetNodes,
      orphanAds,
      alertCount: alertCount.get(campaign.externalId) ?? 0,
    };
  });

  return { days, since: window.since, until: window.until, campaigns: nodes.sort(bySpend) };
}

// ---------------------------------------------------------------------------
// Creatives
// ---------------------------------------------------------------------------

export async function creatives(
  db: Database,
  days: DashboardWindow,
  now = new Date(),
): Promise<DashboardCreatives> {
  const window = windowOf(days, now);
  const accounts = await activeAccounts(db);
  const ids = accounts.map((account) => account.id);
  const empty = { days, since: window.since, until: window.until, formats: [], creatives: [] };
  if (ids.length === 0) return empty;

  const [adRows, campaignRows, creativeRows, sums, firstHalf, secondHalf] = await Promise.all([
    db.query.adAds.findMany({ where: inArray(adAds.adAccountId, ids) }),
    db.query.adCampaigns.findMany({ where: inArray(adCampaigns.adAccountId, ids) }),
    creativesByKey(db, ids),
    sumsByEntity(db, ids, 'ad', window.since, window.until),
    sumsByEntity(db, ids, 'ad', window.since, window.midpoint),
    sumsByEntity(db, ids, 'ad', addDays(window.midpoint, 1), window.until),
  ]);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const campaignById = new Map(campaignRows.map((campaign) => [campaign.id, campaign]));

  const list: CreativePerformance[] = [];
  for (const ad of adRows) {
    const totals = sums.get(ad.externalId);
    // Only ads that delivered in the window: a ranking of zeros says nothing.
    if (!totals || totals.impressions === 0) continue;
    const creative = ad.creativeExternalId
      ? creativeRows.get(`${ad.adAccountId}:${ad.creativeExternalId}`)
      : undefined;
    const ratios = ratiosOf(totals);
    list.push({
      adExternalId: ad.externalId,
      name: ad.name,
      campaignName: (ad.campaignId && campaignById.get(ad.campaignId)?.name) || '',
      platform: (accountById.get(ad.adAccountId)?.platform ?? 'meta') as AdPlatform,
      format: creative?.format ?? 'unknown',
      thumbnailUrl: creative?.thumbnailUrl ?? null,
      headline: creative?.title ?? null,
      effectiveStatus: ad.effectiveStatus,
      totals,
      fatigue: fatigueOf(
        ratiosOf(firstHalf.get(ad.externalId) ?? EMPTY_TOTALS).ctrMilli,
        ratiosOf(secondHalf.get(ad.externalId) ?? EMPTY_TOTALS).ctrMilli,
        ratios.frequencyMilli,
      ),
    });
  }
  list.sort((a, b) => b.totals.spendCents - a.totals.spendCents);

  const byFormat = new Map<MirroredFormat, FormatPerformance>();
  for (const item of list) {
    const entry = byFormat.get(item.format) ?? { format: item.format, ads: 0, totals: EMPTY_TOTALS };
    byFormat.set(item.format, {
      format: item.format,
      ads: entry.ads + 1,
      totals: addTotals(entry.totals, item.totals),
    });
  }

  return {
    ...empty,
    formats: [...byFormat.values()].sort((a, b) => b.totals.spendCents - a.totals.spendCents),
    creatives: list,
  };
}

// ---------------------------------------------------------------------------
// Audience and region
// ---------------------------------------------------------------------------

export async function audience(
  db: Database,
  days: DashboardWindow,
  now = new Date(),
): Promise<DashboardAudience> {
  const window = windowOf(days, now);
  const accounts = await activeAccounts(db);
  const ids = accounts.map((account) => account.id);
  const base = {
    days,
    since: window.since,
    until: window.until,
    platforms: [...new Set(accounts.map((account) => account.platform as AdPlatform))],
  };
  if (ids.length === 0) return { ...base, rows: [] };

  const rows = await db
    .select({
      kind: adMetricsBreakdownDaily.kind,
      key: adMetricsBreakdownDaily.key,
      subKey: adMetricsBreakdownDaily.subKey,
      spendCents: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.spendCents}), 0)`,
      impressions: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.impressions}), 0)`,
      clicks: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.clicks}), 0)`,
      reach: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.reach}), 0)`,
      conversions: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.conversions}), 0)`,
    })
    .from(adMetricsBreakdownDaily)
    .where(
      and(
        inArray(adMetricsBreakdownDaily.adAccountId, ids),
        gte(adMetricsBreakdownDaily.day, window.since),
        lte(adMetricsBreakdownDaily.day, window.until),
      ),
    )
    .groupBy(
      adMetricsBreakdownDaily.kind,
      adMetricsBreakdownDaily.key,
      adMetricsBreakdownDaily.subKey,
    );

  return {
    ...base,
    rows: rows
      .map((row) => ({
        kind: row.kind as BreakdownKind,
        key: row.key,
        subKey: row.subKey,
        totals: {
          ...EMPTY_TOTALS,
          spendCents: Number(row.spendCents),
          impressions: Number(row.impressions),
          clicks: Number(row.clicks),
          reach: Number(row.reach),
          conversions: Number(row.conversions),
        },
      }))
      .sort((a, b) => b.totals.spendCents - a.totals.spendCents),
  };
}
