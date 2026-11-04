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
  /**
   * Set when an account of this strip has no budget period open for the
   * month: the reading goes on (spend comes from the platform's daily rows),
   * but launching or raising budgets stays blocked until the month's cap is
   * opened in Administração → Integrações. Null otherwise.
   */
  periodMissingNote: string | null;
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
  /** Last day it delivers, when the ad set carries its own schedule. */
  endDate: string | null;
  /** Where it delivers; null: automatic placements (or not read yet). */
  placements: AdSetPlacements | null;
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
  /**
   * What the draft that created it said about its ads — UTMs, destination,
   * page and Instagram — so new creatives added to it start from the same
   * values. Null for a campaign a person made by hand.
   */
  launchDefaults: {
    utms: { utm_source: string; utm_medium: string; utm_campaign: string };
    destinationUrl: string;
    identity: { pageId: string; instagramActorId: string | null } | null;
  } | null;
  /** First and last day, as the platform reports them (or the draft's); null end = no end date. */
  startDate: string | null;
  endDate: string | null;
  /** Ran its course (`campaignEnded`): "Encerrada", and neither Pausar nor Retomar is offered. */
  ended: boolean;
  /** The one rule for "Em veiculação" (`campaignDelivering`): spent in the last 24 h, or an active status. */
  delivering: boolean;
  /** The platform's own delivery status (Meta effective_status, Google serving_status); null before the first read. */
  deliveryStatus: string | null;
  /** The last day it spent anything, in any window; null when it never spent. */
  lastSpendDate: string | null;
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
  /** The utm_content its link carries (video-1, imagem-2…), read at ingestion; null when none. */
  utmContent: string | null;
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
  /** False until GA4_PROPERTY_ID and GA4_REFRESH_TOKEN are set. */
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
  /** The Wings System's own leads this campaign brought in the window, and how far they went. */
  crm: FunnelCrmCounts;
  /** The same, ad by ad (spend and platform leads from the ad's own metrics). */
  ads: FunnelAdRow[];
}

/**
 * Leads of the Wings System (not the platform's count) that entered in the
 * window, and how many of them reached a meeting stage ("Reunião…") or a
 * proposal stage ("Proposta…"), by the furthest stage each one reached; a won
 * lead reached them all.
 */
export interface FunnelCrmCounts {
  leads: number;
  meetings: number;
  proposals: number;
}

export interface FunnelAdRow {
  externalId: string;
  name: string;
  spendCents: number;
  /** Leads the platform reports for the ad. */
  leads: number;
  crm: FunnelCrmCounts;
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
  /** Wings System leads of the window that no campaign claims (no ad id, no UTM of a known campaign). */
  leadsWithoutCampaign: number;
}

// ---------------------------------------------------------------------------
// Cockpit: the executive view, one screen
// ---------------------------------------------------------------------------

/** Brazil's states, for the map. `row` and `col` place each one on a tile grid that keeps the country's shape. */
export const BRAZIL_STATE_TILES: { uf: string; name: string; row: number; col: number }[] = [
  { uf: 'RR', name: 'Roraima', row: 0, col: 2 },
  { uf: 'AP', name: 'Amapá', row: 0, col: 4 },
  { uf: 'AM', name: 'Amazonas', row: 1, col: 1 },
  { uf: 'PA', name: 'Pará', row: 1, col: 3 },
  { uf: 'MA', name: 'Maranhão', row: 1, col: 5 },
  { uf: 'CE', name: 'Ceará', row: 1, col: 6 },
  { uf: 'RN', name: 'Rio Grande do Norte', row: 1, col: 7 },
  { uf: 'AC', name: 'Acre', row: 2, col: 0 },
  { uf: 'RO', name: 'Rondônia', row: 2, col: 1 },
  { uf: 'TO', name: 'Tocantins', row: 2, col: 4 },
  { uf: 'PI', name: 'Piauí', row: 2, col: 5 },
  { uf: 'PB', name: 'Paraíba', row: 2, col: 7 },
  { uf: 'PE', name: 'Pernambuco', row: 2, col: 6 },
  { uf: 'MT', name: 'Mato Grosso', row: 3, col: 2 },
  { uf: 'BA', name: 'Bahia', row: 3, col: 5 },
  { uf: 'AL', name: 'Alagoas', row: 3, col: 7 },
  { uf: 'SE', name: 'Sergipe', row: 3, col: 6 },
  { uf: 'GO', name: 'Goiás', row: 4, col: 3 },
  { uf: 'DF', name: 'Distrito Federal', row: 4, col: 4 },
  { uf: 'MG', name: 'Minas Gerais', row: 4, col: 5 },
  { uf: 'ES', name: 'Espírito Santo', row: 4, col: 6 },
  { uf: 'MS', name: 'Mato Grosso do Sul', row: 5, col: 2 },
  { uf: 'SP', name: 'São Paulo', row: 5, col: 4 },
  { uf: 'RJ', name: 'Rio de Janeiro', row: 5, col: 5 },
  { uf: 'PR', name: 'Paraná', row: 6, col: 3 },
  { uf: 'SC', name: 'Santa Catarina', row: 7, col: 3 },
  { uf: 'RS', name: 'Rio Grande do Sul', row: 8, col: 3 },
];

const foldName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^state of /, '')
    .replace(/\s*\((state|estado)\)\s*$/, '')
    .replace(/^estado d[eo] /, '')
    .trim();

/** "Rio de Janeiro (state)" (Meta), "State of Rio de Janeiro" (Google) → "RJ"; null when not a Brazilian state. */
export function ufOfRegion(name: string): string | null {
  const folded = foldName(name);
  if (folded === 'federal district' || folded === 'distrito federal') return 'DF';
  return BRAZIL_STATE_TILES.find((state) => foldName(state.name) === folded)?.uf ?? null;
}

/**
 * Where an ad set delivers, as the platform reports it. `platforms` are the
 * publisher platforms ("instagram", "facebook"…); `positions` the placements
 * inside them, prefixed by platform ("instagram:stream", "instagram:reels").
 * Absent (null) means automatic placements: the platform chooses.
 */
export interface AdSetPlacements {
  platforms: string[];
  positions: string[];
}

/** "Instagram" or "Instagram, Facebook"; null when placements are automatic. */
export function placementsLabel(placements: AdSetPlacements | null | undefined): string | null {
  if (!placements || placements.platforms.length === 0) return null;
  const names: Record<string, string> = {
    instagram: 'Instagram',
    facebook: 'Facebook',
    messenger: 'Messenger',
    audience_network: 'Audience Network',
    threads: 'Threads',
  };
  return placements.platforms.map((platform) => names[platform] ?? platform).join(', ');
}

/** The earlier of two end days; null is "no end", so the other one stands. */
export function earliestEnd(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * The day a campaign stops delivering. A campaign whose schedule lives on the
 * ad sets (Meta keeps `end_time` there) has no end of its own, so it ends on
 * the latest end among the ad sets that are on, but only when every one of
 * them has an end: a single ad set without one keeps it open. Paused ad sets
 * do not count; with none on, there is no end to speak of. With both, the
 * earlier wins: a campaign ending on the 20th whose only ad set stops on the
 * 10th delivers until the 10th.
 */
export function effectiveCampaignEnd(
  campaignEnd: string | null,
  adSets: { status: string; endDate: string | null }[],
): string | null {
  const on = adSets.filter((adSet) => adSet.status === 'ACTIVE');
  const setsEnd =
    on.length > 0 && on.every((adSet) => adSet.endDate)
      ? on.reduce((latest, adSet) => (adSet.endDate! > latest ? adSet.endDate! : latest), '')
      : null;
  return earliestEnd(campaignEnd, setsEnd);
}

/**
 * The days that stand for "the last 24 hours" when spend is only kept per
 * São Paulo day: today and the day before. A campaign that spent on either
 * counts as having spent in the last 24 hours (it can lag the clock by up to
 * a day, never the other way round).
 */
export function last24hDays(today: string): { since: string; until: string } {
  const before = new Date(Date.parse(`${today}T00:00:00Z`) - 24 * 3600_000);
  return { since: before.toISOString().slice(0, 10), until: today };
}

/**
 * The one rule for "em veiculação", used by every tab (Eric, 29/10/2026:
 * "o gasto manda, com o status ao lado"). A campaign that spent in the last
 * 24 hours is delivering, even paused or past its end date; the platform's
 * status is shown beside it, never instead of it. With no spend, the status
 * decides as before: Meta counts when its effective_status is ACTIVE; Google
 * when the campaign is ENABLED and serving_status is SERVING; a campaign whose
 * end date has passed does not. Until the ingestion has read the delivery
 * status (null), the status a person set stands in for it. "Sem veiculação"
 * is therefore zero spend and an inactive status, nothing less.
 */
export function campaignDelivering(
  campaign: {
    platform: AdPlatform;
    status: string;
    deliveryStatus: string | null;
    endDate: string | null;
    /** Spent on any of `last24hDays` (any amount above zero). */
    spentLast24h: boolean;
  },
  today: string,
): boolean {
  if (campaign.spentLast24h) return true;
  if (campaign.endDate && campaign.endDate < today) return false;
  if (campaign.platform === 'google') {
    return campaign.status === 'ACTIVE' && (campaign.deliveryStatus ?? 'SERVING') === 'SERVING';
  }
  return (campaign.deliveryStatus ?? campaign.status) === 'ACTIVE';
}

/**
 * Whether a campaign has run its course: Google says so (serving_status
 * ENDED, while its status may still read ENABLED), or its last day has
 * passed. Meta has no such delivery status; its end date is the rule there.
 */
export function campaignEnded(
  campaign: { deliveryStatus: string | null; endDate: string | null },
  today: string,
): boolean {
  return (
    campaign.deliveryStatus === 'ENDED' || Boolean(campaign.endDate && campaign.endDate < today)
  );
}

/** Google approval states an ad serves under; anything else is a warning. */
const GOOGLE_SERVING_APPROVALS = new Set(['APPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY']);

/**
 * Whether an ad inside an active campaign delivers. Null when it does; the
 * reason a person set it on and it still does not serve, otherwise. An ad a
 * person paused is neither: it is simply off, and returns 'off'.
 */
export function adDeliveryIssue(ad: {
  platform: AdPlatform;
  status: string;
  effectiveStatus: string | null;
}): null | 'off' | string {
  if (ad.status !== 'ACTIVE') return 'off';
  if (ad.platform === 'google') {
    return ad.effectiveStatus === null || GOOGLE_SERVING_APPROVALS.has(ad.effectiveStatus)
      ? null
      : ad.effectiveStatus;
  }
  const effective = ad.effectiveStatus ?? 'ACTIVE';
  if (effective === 'ACTIVE') return null;
  // Paused above it (ad set or campaign): off, not a problem with the ad.
  if (effective.endsWith('_PAUSED') || effective === 'PAUSED') return 'off';
  return effective;
}

/** Portuguese for the delivery issues a person can act on. */
export const AD_ISSUE_LABEL: Record<string, string> = {
  IN_PROCESS: 'Em processamento',
  PENDING_REVIEW: 'Em análise',
  UNDER_REVIEW: 'Em análise',
  DISAPPROVED: 'Reprovado',
  WITH_ISSUES: 'Com problemas',
  PENDING_BILLING_INFO: 'Pagamento pendente',
  AREA_OF_INTEREST_ONLY: 'Aprovado só na área de interesse',
};

/** Which campaigns the Cockpit sums: delivering now (default) or every one that delivered in the window. */
export const COCKPIT_CAMPAIGN_SCOPES = ['ativas', 'todas'] as const;
export type CockpitCampaignScope = (typeof COCKPIT_CAMPAIGN_SCOPES)[number];

export interface CockpitCampaign {
  /** The campaign's id in our tables: what `?campanha=` carries. */
  id: string;
  platform: AdPlatform;
  externalId: string;
  name: string;
  deliveryStatus: string | null;
  /** `campaignDelivering`: spent in the last 24 h or active; false for a campaign shown under "Todas" that is neither. */
  delivering: boolean;
  startDate: string | null;
  endDate: string | null;
  /** Daily budget in force (campaign or the sum of its ad sets); null when it has a lifetime budget only. */
  dailyBudgetCents: number | null;
  /** Spend reported for today (São Paulo) so far. */
  spentTodayCents: number;
}

/** An ad that a person switched on inside an active campaign and that is not serving. */
export interface CockpitAdWarning {
  platform: AdPlatform;
  adExternalId: string;
  adName: string;
  campaignName: string;
  /** The platform's own word: IN_PROCESS, PENDING_REVIEW, DISAPPROVED… */
  issue: string;
}

export interface CockpitCampaignOption {
  id: string;
  platform: AdPlatform;
  name: string;
  delivering: boolean;
}

export interface CockpitSelection {
  /** The picked campaigns found in the scope. */
  ids: string[];
  /** Picked ids that are not campaigns of this scope (ignored). */
  unknown: number;
  /** CRM leads and sales of picked campaigns exist only from this day (attribution starts then); null when the whole window is covered. */
  crmSince: string | null;
  /** Why a figure is "—" while campaigns are picked. */
  why: { sessions: string; crmLeads: string | null; meetings: string; sales: string | null };
}

export interface CockpitFigures {
  spendCents: number;
  impressions: number;
  clicks: number;
  /** Leads the platforms report. */
  leads: number;
  /** GA4 sessions; null while GA4 is not connected. */
  sessions: number | null;
  /** RD CRM deals from a paid platform, meetings and sales. Null when campaigns are picked and RD cannot say (see `DashboardCockpit.selection`). */
  crmLeads: number | null;
  meetings: number | null;
  sales: number | null;
}

export interface CockpitDay {
  day: string;
  /** The same position in the previous window. */
  previousDay: string;
  spendCents: number;
  previousSpendCents: number;
  leads: number;
  previousLeads: number;
  clicks: number;
  previousClicks: number;
}

export interface CockpitRegion {
  uf: string;
  spendCents: number;
  leads: number;
  impressions: number;
}

export interface CockpitAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  firstSeenAt: string;
  platform: AdPlatform;
}

/**
 * Performance ativa: the active campaigns since the day the campaign leads
 * start (28/09), judged by the RD CRM leads they brought, not by the
 * platforms' own lead counts. Null ratios where the base is zero.
 */
export interface CockpitActivePerformance {
  since: string;
  spendCents: number;
  leads: number;
  qualified: number;
  sales: number;
  revenueCents: number;
  costPerLeadCents: number | null;
  costPerQualifiedCents: number | null;
  cacCents: number | null;
  /** Revenue ÷ spend, x100 (2.5x -> 250); null without a sale. */
  roasCentuple: number | null;
  /** Fewer than 10 leads: the ratios move a lot with each new one. */
  smallSample: boolean;
  /** When the RD read last finished; null before the first. */
  fetchedAt: string | null;
}

/**
 * How the campaigns that carry the "active" status split once the rule of
 * what is really delivering (`campaignDelivering`) is applied: the screen says
 * "2 de 4 com status ativo; 2 encerradas em 05/10" instead of a bare count.
 */
export interface CockpitStatusSummary {
  /** Campaigns whose own status is ACTIVE. */
  withStatus: number;
  /** Of those, the ones delivering now (the ones every figure is summed over). */
  delivering: number;
  /** Of those, the ones whose end date has passed. */
  ended: { platform: AdPlatform; name: string; endDate: string }[];
  /** Of those, the ones neither delivering nor ended (in review, no budget, …). */
  notDelivering: number;
}

export interface DashboardCockpit {
  days: DashboardWindow;
  since: string;
  until: string;
  previousSince: string;
  previousUntil: string;
  current: CockpitFigures;
  previous: CockpitFigures;
  daily: CockpitDay[];
  regions: CockpitRegion[];
  /** Spend on regions that are not a Brazilian state (unknown, abroad). */
  otherRegionsSpendCents: number;
  creatives: CreativePerformance[];
  alerts: CockpitAlert[];
  campaignScope: CockpitCampaignScope;
  /** The campaigns every figure above is summed over (the name predates "Todas"). */
  activeCampaigns: CockpitCampaign[];
  /** Every campaign the picker offers for this scope (before any pick). */
  campaignOptions: CockpitCampaignOption[];
  /** Set only when campaigns were picked: which ones, and what RD cannot say about them. */
  selection: CockpitSelection | null;
  /** Ads switched on in those campaigns that are not serving; outside every figure. */
  adWarnings: CockpitAdWarning[];
  activePerformance: CockpitActivePerformance;
  /** Status "ativo" against really delivering, for the scope chip. */
  statusSummary: CockpitStatusSummary;
  /** When the spend of the campaigns above was last read from the platforms (ISO); null before the first read. */
  spendReadAt: string | null;
  /** Spend of the window per platform, active campaigns only. */
  spendByPlatform: Record<AdPlatform, number>;
  /** The company's confirmed CPL target for leads campaigns; null until a person confirms one. */
  cplTargetCents: number | null;
  /** Today in São Paulo, for the timeline's "hoje" mark. */
  today: string;
}
