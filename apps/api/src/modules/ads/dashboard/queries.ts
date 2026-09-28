import {
  addTotals,
  EMPTY_TOTALS,
  fatigueOf,
  killSwitchRuleOf,
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
  type HeatCell,
  type KillSwitchState,
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
  adCampaignDrafts,
  adCampaigns,
  adCreatives,
  adGuardrailEvents,
  adMetricsBreakdownDaily,
  adMetricsDaily,
  adSets,
  agentMessages,
  insightRuns,
  integrationConnections,
  mediaCreditLedger,
} from '../../../db/schema/index.js';
import type { Env } from '../../../env.js';
import { getPeriodState } from '../budget-guard.js';
import { hasPlatformCredentials } from '../platform/factory.js';
import { usdToBrlCents } from '../../media/providers/quota.js';
import { accountHealth } from './health.js';
import { ingestionStatus } from './ingestion.js';
import { campaignVerdicts } from './verdicts.js';
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
  videoStarts: sql<string>`coalesce(sum(${adMetricsDaily.videoStarts}), 0)`,
  videoWatchMs: sql<string>`coalesce(sum(${adMetricsDaily.videoWatchMs}), 0)`,
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
    videoStarts: Number(row.videoStarts),
    videoWatchMs: Number(row.videoWatchMs),
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

/**
 * What is missing between "credentials in the environment" and "figures on
 * the screen", said plainly. On staging the Google strip read "não
 * configurado" with the credentials set, because no account row had ever
 * been seeded: `configured` now follows the credentials and this note says
 * what is left to do.
 */
function setupNoteOf(
  env: Env,
  platform: AdPlatform,
  accounts: Account[],
  latest: Map<string, unknown>,
): string | null {
  if (!hasPlatformCredentials(env, platform)) return null;
  if (accounts.length === 0) {
    const account =
      platform === 'google'
        ? (env.GOOGLE_ADS_CUSTOMER_ID ?? '<id do cliente>')
        : (env.META_WRITE_ACCOUNT_ID ?? 'act_<id>');
    return `Credenciais configuradas, mas a conta ainda não foi semeada na ingestão: ingest-cli --seed --platform ${platform} --account ${account} --name "…" --cap <centavos> --usable 70`;
  }
  if (accounts.every((account) => !latest.has(account.id))) {
    return 'Conta semeada; a primeira ingestão ainda não gravou o dia da conta.';
  }
  return null;
}

/**
 * Why the kill switch is engaged, from the account row and the guard's own
 * event: `engageKillSwitch` writes the reason on the account and a
 * `kill_switch_engaged` event carrying it (a refused attempt writes the same
 * kind with `attempted` instead, and is not the trip).
 */
async function killSwitchOf(db: Database, accounts: Account[]): Promise<KillSwitchState | null> {
  const engaged = accounts.find((account) => account.killSwitchEngaged);
  if (!engaged) return null;
  const [event] = await db
    .select({ createdAt: adGuardrailEvents.createdAt })
    .from(adGuardrailEvents)
    .where(
      and(
        eq(adGuardrailEvents.adAccountId, engaged.id),
        eq(adGuardrailEvents.kind, 'kill_switch_engaged'),
        sql`${adGuardrailEvents.detail} ? 'reason'`,
      ),
    )
    .orderBy(desc(adGuardrailEvents.createdAt))
    .limit(1);
  return {
    rule: killSwitchRuleOf(engaged.killSwitchReason),
    reason: engaged.killSwitchReason,
    engagedAt: event?.createdAt.toISOString() ?? null,
    accountExternalId: engaged.externalId,
  };
}

const brl = (cents: number) =>
  `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The month's forecast from the budgets in force, not from the past pace: a
 * campaign switched on today at R$ 240/day would take a week to move a
 * straight-line projection. Spent so far + what is left of today's budget +
 * the active daily budget for every day left, each campaign stopping at its
 * own end date. The platform's overdelivery (Meta up to 25% a day) is not
 * added: this is what the budgets say, not the worst case.
 */
async function budgetForecast(
  db: Database,
  accountIds: string[],
  month: ReturnType<typeof monthOf>,
  spentCents: number,
): Promise<{ forecast: number; forecastRule: string }> {
  const monthEnd = `${month.periodMonth.slice(0, 8)}${String(month.totalDays).padStart(2, '0')}`;
  const [campaignRows, adSetRows, todayRows] = await Promise.all([
    db.query.adCampaigns.findMany({
      where: and(inArray(adCampaigns.adAccountId, accountIds), eq(adCampaigns.status, 'ACTIVE')),
    }),
    db
      .select({
        campaignId: adSets.campaignId,
        status: adSets.status,
        dailyBudgetCents: adSets.dailyBudgetCents,
      })
      .from(adSets)
      .innerJoin(adCampaigns, eq(adCampaigns.id, adSets.campaignId))
      .where(inArray(adCampaigns.adAccountId, accountIds)),
    sumsByEntity(db, accountIds, 'campaign', month.today, month.today),
  ]);

  let rest = 0;
  let activeDaily = 0;
  let running = 0;
  for (const campaign of campaignRows) {
    const daily =
      campaign.budgetLevel === 'ad_set'
        ? adSetRows
            .filter((row) => row.campaignId === campaign.id && row.status === 'ACTIVE')
            .reduce((total, row) => total + (row.dailyBudgetCents ?? 0), 0)
        : campaign.dailyBudgetCents;
    if (!daily) continue;
    const lastDay = campaign.endDate && campaign.endDate < monthEnd ? campaign.endDate : monthEnd;
    if (lastDay < month.today) continue;
    running += 1;
    activeDaily += daily;
    const spentToday = todayRows.get(campaign.externalId)?.spendCents ?? 0;
    const fullDaysLeft = daysBetween(addDays(month.today, 1), lastDay).length;
    rest += Math.max(0, daily - spentToday) + daily * fullDaysLeft;
  }
  const daysLeft = daysBetween(addDays(month.today, 1), monthEnd).length;
  const forecastRule =
    running === 0
      ? `Nenhuma campanha ativa com verba: o previsto é o gasto até agora, ${brl(spentCents)}.`
      : `Gasto até agora ${brl(spentCents)} + o que falta da verba de hoje + ${brl(activeDaily)}/dia de ` +
        `${running} campanha(s) ativa(s) nos ${daysLeft} dia(s) que restam no mês, cada uma até a sua data de fim` +
        ` = ${brl(spentCents + rest)}. Sem a sobreentrega da plataforma.`;
  return { forecast: spentCents + rest, forecastRule };
}

async function paidStrip(
  db: Database,
  env: Env,
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
  const configured = hasPlatformCredentials(env, platform) || accounts.length > 0;

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
    configured,
    spent,
    ...(accounts.length > 0
      ? await budgetForecast(db, ids, month, spent)
      : { forecast: null, forecastRule: null }),
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
    killSwitch: await killSwitchOf(db, accounts),
    setupNote: setupNoteOf(env, platform, accounts, latest),
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
const ledgerDay = (
  column:
    | typeof mediaCreditLedger.createdAt
    | typeof agentMessages.createdAt
    | typeof insightRuns.startedAt,
) => sql<string>`to_char(${column} at time zone 'America/Sao_Paulo', 'YYYY-MM-DD')`;

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
    forecastRule: null,
    available: Math.max(0, env.KAIROGEN_MONTHLY_CREDITS - spent),
    balance: balance?.balance ?? null,
    balanceSource: balance ? 'kairogen.get_credits' : null,
    ceiling: env.KAIROGEN_MONTHLY_CREDITS,
    daily,
    activeDailyBudget: null,
    refreshedAt: balance?.at ? balance.at.toISOString() : null,
    killSwitchEngaged: false,
    killSwitch: null,
    setupNote: null,
  };
}

async function aiStrip(
  db: Database,
  env: Env,
  month: ReturnType<typeof monthOf>,
  monthStart: Date,
): Promise<SpendStrip> {
  // The agent's ledger and the insights generator's, on the same day axis:
  // both spend through the same key, so the month's AI figure is their sum.
  const [conversations, generations] = await Promise.all([
    db
      .select({
        day: ledgerDay(agentMessages.createdAt),
        amount: sql<string>`coalesce(sum(${agentMessages.costMicroUsd}), 0)`,
      })
      .from(agentMessages)
      .where(gte(agentMessages.createdAt, monthStart))
      .groupBy(ledgerDay(agentMessages.createdAt)),
    db
      .select({
        day: ledgerDay(insightRuns.startedAt),
        amount: sql<string>`coalesce(sum(${insightRuns.costMicroUsd}), 0)`,
      })
      .from(insightRuns)
      .where(gte(insightRuns.startedAt, monthStart))
      .groupBy(ledgerDay(insightRuns.startedAt)),
  ]);
  const byDay = new Map<string, number>();
  for (const row of [...conversations, ...generations]) {
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + Number(row.amount));
  }
  const rows = [...byDay].map(([day, amount]) => ({ day, amount: String(amount) }));
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
    forecastRule: null,
    // The agent's ceiling is per person per day (AGENT_DAILY_USD); the month has none.
    available: null,
    balance: null,
    balanceSource: null,
    ceiling: null,
    daily,
    activeDailyBudget: usdToBrlCents(env.AGENT_DAILY_USD, env.BRL_PER_USD),
    refreshedAt: null,
    killSwitchEngaged: false,
    killSwitch: null,
    setupNote: null,
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
    forecastRule: null,
    available: Math.max(0, ceiling - spent),
    balance: null,
    balanceSource: null,
    ceiling,
    daily,
    activeDailyBudget: null,
    refreshedAt: null,
    killSwitchEngaged: false,
    killSwitch: null,
    setupNote: null,
  };
}

export async function overview(
  db: Database,
  env: Env,
  now = new Date(),
): Promise<DashboardOverview> {
  const month = monthOf(now);
  const monthStart = new Date(`${month.periodMonth}T00:00:00-03:00`);
  const accounts = await activeAccounts(db);
  const ids = accounts.map((account) => account.id);

  const [meta, google, kairogen, ai, media, ingestion, reconciliation, latest] = await Promise.all([
    paidStrip(
      db,
      env,
      'meta',
      accounts.filter((a) => a.platform === 'meta'),
      month,
    ),
    paidStrip(
      db,
      env,
      'google',
      accounts.filter((a) => a.platform === 'google'),
      month,
    ),
    kairogenStrip(db, env, month, monthStart),
    aiStrip(db, env, month, monthStart),
    mediaStrip(db, env, month, monthStart),
    ingestionStatus(db, env, ids, now),
    ingestionStatus(db, env, ids, now, { kind: 'reconcile' }),
    latestAccountDays(db, ids),
  ]);
  const health = await accountHealth(db, accounts, latest, now);

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
    ingestion,
    reconciliation,
    health,
    accounts: accounts.map((account) => ({
      id: account.id,
      platform: account.platform as AdPlatform,
      name: account.name,
    })),
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
  const byKey = new Map<
    string,
    { format: MirroredFormat; thumbnailUrl: string | null; title: string | null }
  >();
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

  const [
    campaignRows,
    adSetRows,
    adRows,
    creatives,
    campaignSums,
    adSetSums,
    adSums,
    alertRows,
    verdicts,
    drafts,
  ] = await Promise.all([
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
    campaignVerdicts(db, days, now),
    // A campaign this system created is the one its executed draft points at.
    db
      .select({
        campaignId: adCampaignDrafts.campaignId,
        startDate: adCampaignDrafts.startDate,
        endDate: adCampaignDrafts.endDate,
      })
      .from(adCampaignDrafts)
      .innerJoin(adCampaigns, eq(adCampaigns.id, adCampaignDrafts.campaignId))
      .where(inArray(adCampaigns.adAccountId, ids)),
  ]);
  const verdictOf = new Map(verdicts.map((row) => [row.campaignId, row.verdict]));
  const targetOf = new Map(verdicts.map((row) => [row.campaignId, row.targetCplCents]));
  const draftOf = new Map(drafts.map((row) => [row.campaignId, row]));

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
  for (const campaign of campaignRows)
    campaignOfEntity.set(campaign.externalId, campaign.externalId);
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
      accountExternalId: account?.externalId ?? '',
      systemCreated: draftOf.has(campaign.id),
      // The platform's own schedule first; the draft's for a campaign not synced since.
      startDate: campaign.startDate ?? draftOf.get(campaign.id)?.startDate ?? null,
      endDate: campaign.endDate ?? draftOf.get(campaign.id)?.endDate ?? null,
      mirroredAt: campaign.createdAt.toISOString(),
      targetCplCents: targetOf.get(campaign.id) ?? null,
      name: campaign.name,
      status: campaign.status,
      objective: campaign.objective,
      budgetLevel: campaign.budgetLevel,
      dailyBudgetCents: campaign.dailyBudgetCents || null,
      totals: campaignSums.get(campaign.externalId) ?? EMPTY_TOTALS,
      adSets: adSetNodes,
      orphanAds,
      alertCount: alertCount.get(campaign.externalId) ?? 0,
      verdict: verdictOf.get(campaign.id) ?? {
        verdict: 'insufficient',
        primary: 'ctr',
        reasons: [],
      },
    };
  });

  // Newest first: by start date, then by when the mirror first saw it. The
  // screen can flip the order or sort by spend; the API picks the default.
  const byRecency = (a: CampaignNode, b: CampaignNode) =>
    (b.startDate ?? '').localeCompare(a.startDate ?? '') ||
    b.mirroredAt.localeCompare(a.mirroredAt) ||
    bySpend(a, b);
  return { days, since: window.since, until: window.until, campaigns: nodes.sort(byRecency) };
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
    const entry = byFormat.get(item.format) ?? {
      format: item.format,
      ads: 0,
      totals: EMPTY_TOTALS,
    };
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
  if (ids.length === 0) return { ...base, rows: [], heatmap: [] };

  // The weekday × hour map: the hourly rows and the day each fell on. Sunday
  // is 0, as Postgres counts it.
  const weekdayOf = sql<string>`extract(dow from ${adMetricsBreakdownDaily.day})::int`;
  const heatRows = await db
    .select({
      weekday: weekdayOf,
      hour: adMetricsBreakdownDaily.key,
      spendCents: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.spendCents}), 0)`,
      impressions: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.impressions}), 0)`,
      clicks: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.clicks}), 0)`,
      conversions: sql<string>`coalesce(sum(${adMetricsBreakdownDaily.conversions}), 0)`,
    })
    .from(adMetricsBreakdownDaily)
    .where(
      and(
        inArray(adMetricsBreakdownDaily.adAccountId, ids),
        eq(adMetricsBreakdownDaily.kind, 'hour'),
        gte(adMetricsBreakdownDaily.day, window.since),
        lte(adMetricsBreakdownDaily.day, window.until),
      ),
    )
    .groupBy(weekdayOf, adMetricsBreakdownDaily.key);
  const heatmap: HeatCell[] = heatRows
    .map((row) => ({
      weekday: Number(row.weekday),
      hour: row.hour,
      spendCents: Number(row.spendCents),
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      conversions: Number(row.conversions),
    }))
    .filter((cell) => cell.impressions > 0 || cell.spendCents > 0)
    .sort((a, b) => a.weekday - b.weekday || a.hour.localeCompare(b.hour));

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
    heatmap,
  };
}
