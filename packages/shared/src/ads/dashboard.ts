import type { VerdictResult } from './verdicts.js';

/**
 * Contract for Dashboard → Marketing: spend and balances across every paid
 * source, and performance read from the mirrored platform data.
 *
 * The same two rules as the cockpit it replaces:
 *  - money is integer cents (or whole credits), never a float;
 *  - a figure that cannot be computed honestly is `null`, never zero. "—" on
 *    screen means "not knowable", and must never be confused with R$ 0,00.
 *
 * Everything here is read from our own tables. Opening the dashboard calls no
 * platform, spends nothing and changes nothing.
 */

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export const DASHBOARD_WINDOWS = [7, 14, 30, 90] as const;
export type DashboardWindow = (typeof DASHBOARD_WINDOWS)[number];

// ---------------------------------------------------------------------------
// Overview: one strip per source of spend
// ---------------------------------------------------------------------------

/** Where money (or credits) goes. Fixed order: it is also the colour order. */
export const SPEND_SOURCES = ['meta', 'google', 'kairogen', 'ai', 'media'] as const;
export type SpendSource = (typeof SPEND_SOURCES)[number];

export const SPEND_SOURCE_LABEL: Record<SpendSource, string> = {
  meta: 'Meta Ads',
  google: 'Google Ads e YouTube',
  kairogen: 'Kairogen',
  ai: 'IA (OpenRouter)',
  media: 'Provedores de mídia',
};

/** Reais in cents, or Kairogen credits. */
export type SpendUnit = 'brl' | 'credits';

export interface DailyAmount {
  /** YYYY-MM-DD in America/Sao_Paulo. */
  day: string;
  amount: number;
}

/** Which guard tripped the kill switch, read from the reason it wrote. */
export const KILL_SWITCH_RULES = [
  'spend_consumed_reservation',
  'unknown_execution',
  'budgets_exceed_plan',
  'reconciliation_stale',
  'other',
] as const;
export type KillSwitchRule = (typeof KILL_SWITCH_RULES)[number];

export const KILL_SWITCH_RULE_LABEL: Record<KillSwitchRule, string> = {
  spend_consumed_reservation: 'Gasto reportado chegou ao teto ou comeu o que estava reservado',
  unknown_execution: 'Uma alteração terminou com resultado desconhecido na plataforma',
  budgets_exceed_plan: 'Orçamentos ativos na plataforma somam mais que o permitido no mês',
  reconciliation_stale: 'Reconciliação parada há mais de 120 minutos (dead-man switch)',
  other: 'Trava acionada por uma pessoa ou por outra regra',
};

/** `engageKillSwitch` writes one of a few fixed sentences; this maps them back to the rule. */
export function killSwitchRuleOf(reason: string | null): KillSwitchRule {
  if (!reason) return 'other';
  if (/consumiu o espaço reservado|atingiu o teto/i.test(reason))
    return 'spend_consumed_reservation';
  if (/resultado desconhecido/i.test(reason)) return 'unknown_execution';
  if (/excedem o limite/i.test(reason)) return 'budgets_exceed_plan';
  if (/Reconciliação parada/i.test(reason)) return 'reconciliation_stale';
  return 'other';
}

export interface KillSwitchState {
  rule: KillSwitchRule;
  /** The sentence the guard wrote when it tripped. */
  reason: string | null;
  /** When the guard tripped; null when no event was recorded (older rows). */
  engagedAt: string | null;
  /** The platform's account id, for the release command. */
  accountExternalId: string;
}

/** Only a person releases it, on the API's shell, after looking. */
export const KILL_SWITCH_RELEASE_HOWTO =
  'Só uma pessoa com acesso ao servidor (Admin Master) libera, depois de verificar a causa, com ops-cli release-kill-switch --account <conta> --reason "…" no container da API. Enquanto houver alteração com resultado desconhecido, a liberação é recusada: resolva com resolve-unknown antes.';

export interface SpendStrip {
  source: SpendSource;
  unit: SpendUnit;
  /** Null when the source is not configured, so the strip says so rather than showing zeros. */
  configured: boolean;
  /** Spent so far this month. */
  spent: number;
  /**
   * What the month will have cost. Meta and Google: spent so far, plus what
   * is left of today's budget, plus the active daily budgets for each day
   * left in the month, stopping at each campaign's end date (`forecastRule`
   * says it in words). Other sources: straight-line projection of `spent`;
   * null before day 2.
   */
  forecast: number | null;
  /** How `forecast` was reached, with the numbers; null for the straight-line sources. */
  forecastRule: string | null;
  /** What the month still allows under the tightest ceiling; null when nothing caps it. */
  available: number | null;
  /**
   * Money on the account itself: Meta's spend cap minus amount spent, Google's
   * prepaid balance, Kairogen's credit balance. Null when the platform gives none.
   */
  balance: number | null;
  /** Where `balance` was read from, e.g. `meta.spend_cap`; null with no balance. */
  balanceSource: string | null;
  /** Our own monthly ceiling for the source; null when there is none. */
  ceiling: number | null;
  /** One point per day of the month so far, zeros included. */
  daily: DailyAmount[];
  /** Sum of the daily budgets in force on active campaigns today (paid platforms only). */
  activeDailyBudget: number | null;
  /** When the figures were last refreshed from the source; null when never. */
  refreshedAt: string | null;
  /** Meta and Google only: the system's own kill switch. */
  killSwitchEngaged: boolean;
  /** Why and when it tripped, and how it is released; null while it is not engaged. */
  killSwitch: KillSwitchState | null;
  /**
   * Set when the source is configured but cannot show figures yet, and says
   * what is missing: credentials present but no account seeded in the
   * ingestion, for instance. Null when there is nothing to say.
   */
  setupNote: string | null;
}

/** How the ingest job is doing, so the header can say when the next run is. */
export interface IngestionStatus {
  /** Start of the last run recorded, ok or not; null when no run was ever recorded. */
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'failed' | 'running' | null;
  /** Accounts that failed in the last run, with the step they died in. */
  lastRunFailures: { platform: AdPlatform | string; step: string }[];
  /** The cron the API was told (ADS_INGEST_CRON), in São Paulo; null when not told. */
  schedule: string | null;
  /** Next run by that schedule; null without a schedule. */
  nextRunAt: string | null;
  /** True when a scheduled run should have happened and no run was recorded since. */
  overdue: boolean;
  /** When the last run that finished ok ended: "dados até" on the screen; null when none did. */
  dataUntil: string | null;
}

export const HEALTH_ITEM_KEYS = [
  'conversions_measuring',
  'creative_fatigue',
  'spend_pacing',
  'active_without_results',
] as const;
export type HealthItemKey = (typeof HEALTH_ITEM_KEYS)[number];

export const HEALTH_ITEM_LABEL: Record<HealthItemKey, string> = {
  conversions_measuring: 'Conversões medindo',
  creative_fatigue: 'Criativos desgastados',
  spend_pacing: 'Ritmo de gasto',
  active_without_results: 'Campanhas ativas sem resultado há 7 dias',
};

export type HealthState = 'ok' | 'attention' | 'problem' | 'unknown';

export const HEALTH_STATE_LABEL: Record<HealthState, string> = {
  ok: 'Em ordem',
  attention: 'Atenção',
  problem: 'Problema',
  unknown: 'Sem dado',
};

/** One line of "Saúde da conta": the state, what was seen and what to do. */
export interface HealthItem {
  key: HealthItemKey;
  platform: AdPlatform;
  state: HealthState;
  /** What the numbers show, with the numbers. */
  detail: string;
  /** What a person does about it; empty when nothing is needed. */
  action: string;
}

export interface DashboardOverview {
  /** First day of the month the strips cover. */
  periodMonth: string;
  /** Day of the month the figures run to, and how many the month has. */
  elapsedDays: number;
  totalDays: number;
  strips: SpendStrip[];
  counts: {
    openAlerts: number;
    criticalAlerts: number;
    pendingApprovals: number;
    disapprovedAds: number;
  };
  ingestion: IngestionStatus;
  /**
   * The fast cycle (`ingest-cli --reconcile-only`), same shape: balance,
   * platform limit and campaign status only, meant to run every 15 minutes.
   */
  reconciliation: IngestionStatus;
  health: HealthItem[];
  /** The active ad accounts, for "Atualizar agora" (one reconciliation per account). */
  accounts: { id: string; platform: AdPlatform; name: string }[];
}

// ---------------------------------------------------------------------------
// Performance figures shared by the platform, campaign and creative views
// ---------------------------------------------------------------------------

/**
 * Sums over a window. Ratios are derived from these at read time, never stored,
 * so a window is always internally consistent.
 */
export interface MetricTotals {
  spendCents: number;
  impressions: number;
  clicks: number;
  reach: number;
  /** Leads: the account's lead action type only, never inferred from clicks. */
  conversions: number;
  /** Video: plays of 3 seconds or more, ThruPlays, and the four quartiles. */
  videoPlays: number;
  videoThruplays: number;
  videoP25: number;
  videoP50: number;
  videoP75: number;
  videoP100: number;
  /** Every start of the video, and the total milliseconds watched; Meta only. */
  videoStarts: number;
  videoWatchMs: number;
}

export const EMPTY_TOTALS: MetricTotals = {
  spendCents: 0,
  impressions: 0,
  clicks: 0,
  reach: 0,
  conversions: 0,
  videoPlays: 0,
  videoThruplays: 0,
  videoP25: 0,
  videoP50: 0,
  videoP75: 0,
  videoP100: 0,
  videoStarts: 0,
  videoWatchMs: 0,
};

/** Ratios, each null when its denominator is zero. All x1000 integers or cents. */
export interface MetricRatios {
  /** Percentage x1000. */
  ctrMilli: number | null;
  cpcCents: number | null;
  cpmCents: number | null;
  costPerLeadCents: number | null;
  /** Impressions per person reached, x1000. */
  frequencyMilli: number | null;
  /** Share of impressions that became a 3-second play, percentage x1000. */
  hookRateMilli: number | null;
  /** Share of 3-second plays that reached ThruPlay, percentage x1000. */
  holdRateMilli: number | null;
  /** Share of 3-second plays that reached the end, percentage x1000. */
  completionRateMilli: number | null;
  /** Average time watched per start, in milliseconds. */
  avgWatchMs: number | null;
  /**
   * Share of starts that reached 25/50/75/100% of the video, percentage x1000.
   * On the starts when Meta reported them, else on the 3-second plays.
   */
  p25Milli: number | null;
  p50Milli: number | null;
  p75Milli: number | null;
  p100Milli: number | null;
}

export function addTotals(a: MetricTotals, b: Partial<MetricTotals>): MetricTotals {
  return {
    spendCents: a.spendCents + (b.spendCents ?? 0),
    impressions: a.impressions + (b.impressions ?? 0),
    clicks: a.clicks + (b.clicks ?? 0),
    reach: a.reach + (b.reach ?? 0),
    conversions: a.conversions + (b.conversions ?? 0),
    videoPlays: a.videoPlays + (b.videoPlays ?? 0),
    videoThruplays: a.videoThruplays + (b.videoThruplays ?? 0),
    videoP25: a.videoP25 + (b.videoP25 ?? 0),
    videoP50: a.videoP50 + (b.videoP50 ?? 0),
    videoP75: a.videoP75 + (b.videoP75 ?? 0),
    videoP100: a.videoP100 + (b.videoP100 ?? 0),
    videoStarts: a.videoStarts + (b.videoStarts ?? 0),
    videoWatchMs: a.videoWatchMs + (b.videoWatchMs ?? 0),
  };
}

const perMille = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 100_000) : null;

const perUnitCents = (cents: number, count: number): number | null =>
  count > 0 ? Math.round(cents / count) : null;

/**
 * Every ratio from the sums, with the same honesty rule everywhere: no
 * impressions means no CTR, no leads means no CPL. Reach is summed over days,
 * which over-counts people seen on several days, so frequency over a window is
 * a floor rather than the platform's own figure.
 */
export function ratiosOf(t: MetricTotals): MetricRatios {
  return {
    ctrMilli: perMille(t.clicks, t.impressions),
    cpcCents: perUnitCents(t.spendCents, t.clicks),
    cpmCents: t.impressions > 0 ? Math.round((t.spendCents / t.impressions) * 1000) : null,
    costPerLeadCents: perUnitCents(t.spendCents, t.conversions),
    frequencyMilli: t.reach > 0 ? Math.round((t.impressions / t.reach) * 1000) : null,
    hookRateMilli: perMille(t.videoPlays, t.impressions),
    holdRateMilli: perMille(t.videoThruplays, t.videoPlays),
    completionRateMilli: perMille(t.videoP100, t.videoPlays),
    avgWatchMs: t.videoStarts > 0 ? Math.round(t.videoWatchMs / t.videoStarts) : null,
    p25Milli: perMille(t.videoP25, t.videoStarts || t.videoPlays),
    p50Milli: perMille(t.videoP50, t.videoStarts || t.videoPlays),
    p75Milli: perMille(t.videoP75, t.videoStarts || t.videoPlays),
    p100Milli: perMille(t.videoP100, t.videoStarts || t.videoPlays),
  };
}

/**
 * Change from one window to the one before it, as a percentage; null when the
 * previous figure is missing or zero, because "up from nothing" is not a rate.
 */
export function deltaPercent(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// ---------------------------------------------------------------------------
// Per platform
// ---------------------------------------------------------------------------

export type AdPlatform = 'meta' | 'google';

export const AD_PLATFORM_LABEL: Record<AdPlatform, string> = {
  meta: 'Meta Ads',
  google: 'Google Ads',
};

export interface PlatformPerformance {
  platform: AdPlatform;
  /** Accounts behind the figures; empty when none is configured. */
  accounts: { id: string; name: string; externalId: string }[];
  current: MetricTotals;
  previous: MetricTotals;
  /** Spend per day over the current window, zeros included. */
  daily: DailyAmount[];
}

export interface DashboardPlatforms {
  days: DashboardWindow;
  /** Inclusive bounds of the current window, YYYY-MM-DD. */
  since: string;
  until: string;
  previousSince: string;
  platforms: PlatformPerformance[];
  metricsFetchedAt: string | null;
}

// ---------------------------------------------------------------------------
// Campaigns → ad sets → ads
// ---------------------------------------------------------------------------

export interface AdNode {
  externalId: string;
  name: string;
  status: string;
  effectiveStatus: string | null;
  format: MirroredFormat;
  thumbnailUrl: string | null;
  totals: MetricTotals;
}

export interface AdSetNode {
  externalId: string;
  name: string;
  status: string;
  dailyBudgetCents: number | null;
  totals: MetricTotals;
  ads: AdNode[];
}

export interface CampaignNode {
  externalId: string;
  platform: AdPlatform;
  accountName: string;
  /** The account's platform id: what a change request names (`POST /ads/change-requests`). */
  accountExternalId: string;
  /**
   * Created by this system (a create_campaign it executed). Only these get
   * Pausar / Retomar / Mudar verba diária on the dashboard; a campaign a
   * person made by hand is changed in the platform.
   */
  systemCreated: boolean;
  /** First and last day, as the platform reports them (or the draft's); null end = no end date. */
  startDate: string | null;
  endDate: string | null;
  /** When the mirror first saw it: the order's tie-break when the start date is unknown. */
  mirroredAt: string;
  /** The CPL target the verdict used (the account's, else the company's); null without one. */
  targetCplCents: number | null;
  name: string;
  status: string;
  objective: string | null;
  budgetLevel: 'campaign' | 'ad_set' | 'none';
  dailyBudgetCents: number | null;
  totals: MetricTotals;
  adSets: AdSetNode[];
  /** Ads under the campaign whose ad set is not mirrored (Google, or a gap in the mirror). */
  orphanAds: AdNode[];
  alertCount: number;
  /** Positiva, Atenção, Negativa… with the numbers behind it (`verdictOf`, in `verdicts.ts`). */
  verdict: VerdictResult;
}

export interface DashboardCampaigns {
  days: DashboardWindow;
  since: string;
  until: string;
  campaigns: CampaignNode[];
}

// ---------------------------------------------------------------------------
// Creatives
// ---------------------------------------------------------------------------

export const MIRRORED_FORMATS = ['image', 'video', 'carousel', 'text', 'unknown'] as const;
export type MirroredFormat = (typeof MIRRORED_FORMATS)[number];

export const MIRRORED_FORMAT_LABEL: Record<MirroredFormat, string> = {
  image: 'Imagem',
  video: 'Vídeo',
  carousel: 'Carrossel',
  /** Google's responsive search ad: headlines and descriptions, no media. */
  text: 'Texto (pesquisa)',
  unknown: 'Formato não informado',
};

export interface FormatPerformance {
  format: MirroredFormat;
  ads: number;
  totals: MetricTotals;
}

/**
 * A wearing-out signal per ad, computed from the halves of the window: CTR in
 * the second half against the first, with the frequency reached. Null halves
 * mean the ad did not deliver in both.
 */
export interface FatigueSignal {
  firstHalfCtrMilli: number | null;
  secondHalfCtrMilli: number | null;
  frequencyMilli: number | null;
  /** True when CTR fell by a fifth or more while frequency passed 2. */
  wornOut: boolean;
}

export interface CreativePerformance {
  adExternalId: string;
  name: string;
  campaignName: string;
  platform: AdPlatform;
  format: MirroredFormat;
  thumbnailUrl: string | null;
  headline: string | null;
  effectiveStatus: string | null;
  totals: MetricTotals;
  fatigue: FatigueSignal;
}

export interface DashboardCreatives {
  days: DashboardWindow;
  since: string;
  until: string;
  formats: FormatPerformance[];
  /** Every ad that delivered in the window, most spend first. */
  creatives: CreativePerformance[];
}

/** Rule for `wornOut`, shared so the screen explains the same thing the API applied. */
export const FATIGUE_CTR_DROP_PERCENT = 20;
export const FATIGUE_FREQUENCY_MILLI = 2000;

export function fatigueOf(
  firstHalfCtrMilli: number | null,
  secondHalfCtrMilli: number | null,
  frequencyMilli: number | null,
): FatigueSignal {
  const drop = deltaPercent(secondHalfCtrMilli, firstHalfCtrMilli);
  const wornOut =
    drop !== null &&
    drop <= -FATIGUE_CTR_DROP_PERCENT &&
    frequencyMilli !== null &&
    frequencyMilli >= FATIGUE_FREQUENCY_MILLI;
  return { firstHalfCtrMilli, secondHalfCtrMilli, frequencyMilli, wornOut };
}

// ---------------------------------------------------------------------------
// Audience and region: the breakdowns
// ---------------------------------------------------------------------------

export const BREAKDOWN_KINDS = ['placement', 'age_gender', 'region', 'hour', 'device'] as const;
export type BreakdownKind = (typeof BREAKDOWN_KINDS)[number];

export const BREAKDOWN_KIND_LABEL: Record<BreakdownKind, string> = {
  placement: 'Posicionamento',
  age_gender: 'Idade e gênero',
  region: 'Região',
  hour: 'Hora do dia',
  device: 'Dispositivo',
};

/** The platforms' device names, as the screen shows them. Unknown names show as they came. */
export const DEVICE_LABEL: Record<string, string> = {
  // Meta: device_platform
  mobile_app: 'Celular (app)',
  mobile_web: 'Celular (navegador)',
  desktop: 'Computador',
  // Google: segments.device
  mobile: 'Celular',
  tablet: 'Tablet',
  connected_tv: 'TV conectada',
  other: 'Outro',
  unknown: 'Não informado',
};

export interface BreakdownRow {
  kind: BreakdownKind;
  /** placement: publisher platform · age_gender: age band · region: state · hour: "00".."23" · device: device name. */
  key: string;
  /** placement: position · age_gender: gender · otherwise empty. */
  subKey: string;
  totals: MetricTotals;
}

/** One cell of the weekday × hour map, from the hourly rows and the day they fell on. */
export interface HeatCell {
  /** 0 = Sunday … 6 = Saturday, in the account's timezone. */
  weekday: number;
  /** "00".."23". */
  hour: string;
  spendCents: number;
  clicks: number;
  impressions: number;
  conversions: number;
}

export const WEEKDAY_LABEL = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const;

export interface DashboardAudience {
  days: DashboardWindow;
  since: string;
  until: string;
  platforms: AdPlatform[];
  rows: BreakdownRow[];
  /** Only cells with any delivery; the screen fills the rest with zeros. */
  heatmap: HeatCell[];
}

/** Meta's gender values, as the screen names them. */
export const GENDER_LABEL: Record<string, string> = {
  male: 'Homens',
  female: 'Mulheres',
  unknown: 'Não informado',
};

// ---------------------------------------------------------------------------
// After the click: the site (GA4) and the funnel down to the sale (RD CRM)
// ---------------------------------------------------------------------------

/** One source / medium / campaign over the window, as GA4 counts it. */
export interface SiteTrafficRow {
  source: string;
  medium: string;
  campaign: string;
  sessions: number;
  engagedSessions: number;
  engagementSeconds: number;
  pageViews: number;
  keyEvents: number;
}

export interface DashboardSite {
  days: DashboardWindow;
  since: string;
  until: string;
  /** False until GA4_PROPERTY_ID and the service account key are set. */
  configured: boolean;
  propertyId: string | null;
  /** When GA4 was last read; null when never. */
  fetchedAt: string | null;
  totals: Omit<SiteTrafficRow, 'source' | 'medium' | 'campaign'>;
  rows: SiteTrafficRow[];
}

/** Engagement rate (engaged ÷ sessions) x1000, average engagement per session in seconds, pages per session x1000. */
export function siteRatiosOf(row: Omit<SiteTrafficRow, 'source' | 'medium' | 'campaign'>): {
  engagementRateMilli: number | null;
  avgEngagementSeconds: number | null;
  pagesPerSessionMilli: number | null;
} {
  const per = (value: number) => (row.sessions > 0 ? value / row.sessions : null);
  const rate = per(row.engagedSessions);
  const seconds = per(row.engagementSeconds);
  const pages = per(row.pageViews);
  return {
    engagementRateMilli: rate === null ? null : Math.round(rate * 100_000),
    avgEngagementSeconds: seconds === null ? null : Math.round(seconds),
    pagesPerSessionMilli: pages === null ? null : Math.round(pages * 1000),
  };
}

/** One ad campaign, impression to lead. Sessions are null when GA4 is not connected. */
export interface FunnelCampaignRow {
  platform: AdPlatform;
  externalId: string;
  name: string;
  spendCents: number;
  impressions: number;
  clicks: number;
  sessions: number | null;
  /** Leads the platform reports (its conversion); the CRM count is per platform, below. */
  leads: number;
  /** The GA4 campaign names matched to this campaign (utm_campaign of its draft, or its own name). */
  matchedSiteCampaigns: string[];
}

/** One platform, impression to sale. CRM stages come from RD's own labels (source / campaign). */
export interface FunnelPlatformRow {
  platform: AdPlatform;
  spendCents: number;
  impressions: number;
  clicks: number;
  sessions: number | null;
  leads: number;
  crmLeads: number;
  meetings: number;
  sales: number;
}

export interface DashboardFunnel {
  days: DashboardWindow;
  since: string;
  until: string;
  siteConfigured: boolean;
  crmConfigured: boolean;
  /** When the RD CRM copy was last refreshed; null when never. */
  crmFetchedAt: string | null;
  campaigns: FunnelCampaignRow[];
  platforms: FunnelPlatformRow[];
  /** Deals in the window whose RD labels name no paid platform (organic, referral, "Tráfego pago" without a platform…). */
  crmUnattributed: number;
}
