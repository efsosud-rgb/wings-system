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
  counts: {
    ads: number;
    disapprovedAds: number;
    openAlerts: number;
    pendingApprovals: number;
  };
}
