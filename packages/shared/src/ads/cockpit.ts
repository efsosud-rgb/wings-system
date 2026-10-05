import { z } from 'zod';

/**
 * Contract for the traffic cockpit: the performance table and the alert feed.
 *
 * Two rules the whole module depends on:
 *  - money is integer cents, never a float;
 *  - a metric that cannot be computed honestly is `null`, never zero. An empty
 *    CPL column means "no leads yet", and must not be confused with R$ 0,00.
 */

export const ALERT_KINDS = [
  'ad_rejected',
  'budget_pacing',
  'creative_fatigue',
  'quality_below_average',
  'conversion_silence',
  'meta_ad_without_utms',
  'google_campaign_own_suffix',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  ad_rejected: 'Anúncio reprovado',
  budget_pacing: 'Ritmo de gasto fora do previsto',
  creative_fatigue: 'Desgaste de criativo',
  quality_below_average: 'Qualidade abaixo da média',
  conversion_silence: 'Silêncio de conversão',
  meta_ad_without_utms: 'Anúncio da Meta sem as UTMs padrão',
  google_campaign_own_suffix: 'Campanha do Google com sufixo próprio',
};

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: 'Informativo',
  warning: 'Atenção',
  critical: 'Crítico',
};

export interface AlertItem {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: Record<string, unknown>;
  entityLevel: 'campaign' | 'ad_set' | 'ad' | null;
  entityExternalId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  notifiedAt: string | null;
  notificationError: string | null;
}

export interface CampaignPerformanceItem {
  campaignExternalId: string;
  name: string;
  status: string;
  /** Where the budget lives — a paused campaign's ad sets never deliver. */
  budgetLevel: 'campaign' | 'ad_set' | 'none';
  dailyBudgetCents: number | null;
  spendCents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Percentage x1000; null when there were no impressions. */
  ctrMilli: number | null;
  frequencyMilli: number | null;
  /** Null when there are no conversions — never inferred from clicks. */
  costPerLeadCents: number | null;
  /** Open alerts touching this campaign or anything under it. */
  alertCount: number;
}

/** Spend pace against the month, as the cockpit header shows it. */
export interface PacingSummary {
  periodMonth: string;
  capCents: number;
  usableCents: number;
  committedCents: number;
  spentCents: number;
  availableCents: number;
  /** What should have been spent by now if the usable budget ran evenly. */
  expectedCents: number;
  /** Positive = spending ahead of plan. Null before the period has run long enough to judge. */
  deviationPercent: number | null;
  elapsedDays: number;
  totalDays: number;
  killSwitchEngaged: boolean;
  /**
   * What the platform itself still allows, as last synced by reconciliation.
   * Null when never synced or when the platform sets no limit — never a
   * fabricated number. See `platformLimitNote` for why, when it is null.
   */
  platformRemainingCents: number | null;
  /** Which field this came from, e.g. `meta.spend_cap`, `meta.prepaid_balance`. */
  platformLimitSource: string | null;
  platformLimitSyncedAtIso: string | null;
  /** Why the platform would not answer, in its own words; null when it did. */
  platformLimitNote: string | null;
  /**
   * When `reconcileAccount` last ran successfully for this account — the
   * freshness of every figure above, not only the platform limit. Null when
   * this month's period has never reconciled.
   */
  lastReconciledAt: string | null;
  /** The platform's own account figures, each line with its reading time. */
  platformReading: PlatformAccountReading;
}

/**
 * The account as the platform itself last reported it. Every money figure is
 * null unless `status` is `ok`: an old number is never shown as current.
 */
export interface PlatformAccountReading {
  /**
   * `ok` — read within `PLATFORM_READING_STALE_MINUTES`; `failed` — the last
   * attempt failed (`reason` says why); `stale` — no successful read for too
   * long (the scheduled task stopped); `never` — never read.
   */
  status: 'ok' | 'failed' | 'stale' | 'never';
  /** Why there is no current figure, in words for the screen; null when `ok`. */
  reason: string | null;
  /** Last successful read. */
  readAtIso: string | null;
  /** Last attempt, successful or not. */
  attemptedAtIso: string | null;
  /** Account spending limit (Meta `spend_cap`); null when unset or unread. */
  spendCapCents: number | null;
  /** Spent against that limit (Meta `amount_spent`). */
  amountSpentCents: number | null;
  /** `spendCapCents − amountSpentCents`, never below zero. */
  spendCapRemainingCents: number | null;
  /** What the next charge takes (Meta `balance`); not money available. */
  amountDueCents: number | null;
  /** Prepaid money left, only where the platform states one. */
  prepaidBalanceCents: number | null;
  /** `credit_card`, `prepaid`, `invoice`, `unavailable`…; a code, never the card. */
  fundingKind: string | null;
  /** The account's rule for when the spending limit starts over; null when unknown. */
  spendCapReset: SpendCapReset | null;
  /** Next reset day (YYYY-MM-DD) under that rule; null when unknown. */
  spendCapResetsOn: string | null;
}

/** Three missed 15-minute cycles: past this, a platform figure is not current. */
export const PLATFORM_READING_STALE_MINUTES = 45;

export const SPEND_CAP_RESETS = ['monthly'] as const;
export type SpendCapReset = (typeof SPEND_CAP_RESETS)[number];

/** A budget that keeps drawing on the account's spending limit, day by day. */
export interface SpendStream {
  dailyBudgetCents: number;
  /** YYYY-MM-DD; null = already running. */
  startDate: string | null;
  /** YYYY-MM-DD, inclusive; null = runs until someone stops it. */
  endDate: string | null;
}

/** An active campaign's budget as the cockpit knows it, for the projection. */
export interface ActiveCampaignBudget extends SpendStream {
  campaignExternalId: string;
  name: string;
}

export interface SpendCapProjection {
  /** Day the limit runs out; null when it holds to `horizonEnd`. */
  pauseDate: string | null;
  /** Last day projected. */
  horizonEnd: string;
  /** Spend projected from today until the pause (or the next reset / horizon). */
  projectedCents: number;
  /** What the limit still allowed at the start of that stretch. */
  allowedCents: number;
}

const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** First day of the month after `day`, YYYY-MM-DD. */
export function firstOfNextMonth(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * When the platform will stop the whole account at its spending limit, if the
 * budgets given keep running as planned. A plan, not a forecast of delivery:
 * each day costs its full daily budget, today included (what is already spent
 * today is in `remainingCents` too, so the date errs early — "por volta de").
 *
 * With a `monthly` reset the limit starts over on the 1st at `spendCapCents`;
 * with none known, the remainder is all there is. Open-ended budgets are
 * projected to the end of next month.
 */
export function projectSpendCapPause(input: {
  today: string;
  remainingCents: number;
  spendCapCents: number;
  reset: SpendCapReset | null;
  streams: SpendStream[];
}): SpendCapProjection {
  const live = input.streams.filter(
    (stream) =>
      stream.dailyBudgetCents > 0 && (stream.endDate === null || stream.endDate >= input.today),
  );
  const openEnded = live.some((stream) => stream.endDate === null);
  const lastEnd = live.reduce(
    (latest, stream) => (stream.endDate && stream.endDate > latest ? stream.endDate : latest),
    input.today,
  );
  const horizonEnd = openEnded
    ? addDays(firstOfNextMonth(firstOfNextMonth(input.today)), -1)
    : lastEnd;

  let left = input.remainingCents;
  let allowed = input.remainingCents;
  let projected = 0;
  for (let day = input.today; day <= horizonEnd; day = addDays(day, 1)) {
    if (input.reset === 'monthly' && day !== input.today && day.endsWith('-01')) {
      left = input.spendCapCents;
      allowed = input.spendCapCents;
      projected = 0;
    }
    const cost = live
      .filter(
        (stream) =>
          (stream.startDate === null || stream.startDate <= day) &&
          (stream.endDate === null || stream.endDate >= day),
      )
      .reduce((total, stream) => total + stream.dailyBudgetCents, 0);
    projected += cost;
    left -= cost;
    if (left < 0)
      return { pauseDate: day, horizonEnd, projectedCents: projected, allowedCents: allowed };
  }
  return { pauseDate: null, horizonEnd, projectedCents: projected, allowedCents: allowed };
}

export interface CockpitAccount {
  id: string;
  name: string;
  platform: 'meta' | 'google' | 'tiktok';
  externalId: string;
}

export interface CockpitSnapshot {
  account: CockpitAccount;
  pacing: PacingSummary | null;
  campaigns: CampaignPerformanceItem[];
  alerts: AlertItem[];
  /** When metrics were last pulled from the platform; null when never. */
  metricsFetchedAt: string | null;
  /** Window the performance figures cover. */
  sinceDate: string;
  /**
   * Budgets in force now (ACTIVE campaigns: a CBO campaign's own budget, or an
   * ABO campaign's active ad sets), for the spending-limit projection.
   */
  activeBudgets: ActiveCampaignBudget[];
  counts: {
    ads: number;
    disapprovedAds: number;
    openAlerts: number;
    pendingApprovals: number;
  };
  /**
   * The cross-platform figure: summed across every non-archived account's
   * currently open budget period this month. Null only when literally no
   * account has one open — not the selected account's own figure, which is
   * `pacing` (null there means "this account has no cap", not "nobody does").
   */
  wingsTotal: {
    capCents: number;
    usableCents: number;
    committedCents: number;
    spentCents: number;
  } | null;
}

/** One ad account, as Administração → Integrações lists it for cap editing. */
export interface AdAccountBudgetCapView {
  accountId: string;
  platform: 'meta' | 'google' | 'tiktok';
  name: string;
  externalId: string;
  /** First day of the month the figures below cover. */
  periodMonth: string;
  /** Null when no period is open yet this month. */
  capCents: number | null;
  usableCents: number | null;
  usablePercent: number | null;
}

/** Body of `POST /ads/accounts/:accountId/budget-cap` — opens or edits this month's cap. */
export const budgetCapUpdateSchema = z.object({
  capCents: z.number().int().positive(),
  usablePercent: z.number().int().min(1).max(100),
  reason: z.string().trim().min(3).max(500),
});

export type BudgetCapUpdateInput = z.output<typeof budgetCapUpdateSchema>;
