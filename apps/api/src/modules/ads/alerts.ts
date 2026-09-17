import type { AlertKind, AlertSeverity } from '@wings/shared';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adAccounts, adAds, adAlerts, adCampaigns, adMetricsDaily } from '../../db/schema/index.js';
import { getPeriodState } from './budget-guard.js';
import { formatBrl } from './platform/money.js';
import { periodMonthOf } from './reconcile.js';

/**
 * Alert detection for the cockpit.
 *
 * Detection is a pure read: every rule looks at data already mirrored from the
 * platform and returns findings. Nothing here changes a budget, pauses a
 * campaign or touches an ad platform — an alert's whole job is to put a human
 * in front of a decision.
 *
 * Persistence is deduplicated: one OPEN row per (account, kind, entity). A
 * condition that keeps holding refreshes `lastSeenAt` instead of producing a
 * new alert every hour, and a condition that stops holding is resolved. Only
 * genuinely new critical alerts notify WhatsApp, so a rejected ad reaches the
 * team's phones once, not once per ingest.
 */

export interface AlertRuleConfig {
  adRejected: { enabled: boolean };
  budgetPacing: {
    enabled: boolean;
    /** Deviation from the even-spend line that counts as off-pace. */
    tolerancePercent: number;
    /** Below this share of the month elapsed, pace means nothing yet. */
    minElapsedFraction: number;
  };
  creativeFatigue: { enabled: boolean; frequencyMilli: number; lookbackDays: number };
  qualityBelowAverage: { enabled: boolean; lookbackDays: number };
  conversionSilence: { enabled: boolean; spendCents: number; windowHours: number };
}

/**
 * Shipping defaults, as decided for Stage 6.6.
 *
 * `conversionSilence` ships **switched off**: the Stage 6.0 spike found this
 * account has never recorded a single lead event, so the rule would fire on
 * everything and mean nothing. It turns on when a lead-form campaign actually
 * delivers.
 *
 * `qualityBelowAverage` is enabled but dormant in practice: Meta returns
 * `UNKNOWN` rankings below its impression threshold, and this account is far
 * below it. It costs nothing to leave armed and starts working by itself when
 * volume arrives.
 */
export const DEFAULT_ALERT_CONFIG: AlertRuleConfig = {
  adRejected: { enabled: true },
  budgetPacing: { enabled: true, tolerancePercent: 20, minElapsedFraction: 0.1 },
  creativeFatigue: { enabled: true, frequencyMilli: 3000, lookbackDays: 7 },
  qualityBelowAverage: { enabled: true, lookbackDays: 7 },
  conversionSilence: { enabled: false, spendCents: 5_000, windowHours: 24 },
};

/** Which alerts are worth a phone buzzing at 23:00. */
const CRITICAL_KINDS: ReadonlySet<AlertKind> = new Set<AlertKind>([
  'ad_rejected',
  'conversion_silence',
]);

export interface DetectedAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  entityLevel: 'campaign' | 'ad_set' | 'ad' | null;
  /** The platform's own id for the thing at fault; the account id for account-wide rules. */
  entityExternalId: string;
  title: string;
  detail: Record<string, unknown>;
}

export interface AlertNotification {
  alertId: string;
  adAccountId: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: Record<string, unknown>;
}

export interface AlertNotifier {
  send(notification: AlertNotification): Promise<void>;
}

/** Fallback when no channel is configured: says plainly that it only logged. */
export class LoggingAlertNotifier implements AlertNotifier {
  constructor(private readonly log: (message: string) => void = console.warn) {}

  send(notification: AlertNotification): Promise<void> {
    this.log(
      `[alerts] ${notification.severity.toUpperCase()} ${notification.kind}: ${notification.title} (não enviado — sem canal configurado)`,
    );
    return Promise.resolve();
  }
}

const BELOW_AVERAGE_RANKINGS = new Set([
  'BELOW_AVERAGE_10',
  'BELOW_AVERAGE_20',
  'BELOW_AVERAGE_35',
]);

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(now: Date, days: number): string {
  return dayString(new Date(now.getTime() - days * 24 * 3_600_000));
}

/** The human-readable reason Meta gives for a rejection, if any. */
export function rejectionReasons(reviewFeedback: unknown): string[] {
  if (!reviewFeedback || typeof reviewFeedback !== 'object') return [];
  const reasons: string[] = [];
  for (const section of Object.values(reviewFeedback as Record<string, unknown>)) {
    if (section && typeof section === 'object') {
      for (const key of Object.keys(section as Record<string, unknown>)) reasons.push(key);
    } else if (typeof section === 'string') {
      reasons.push(section);
    }
  }
  return [...new Set(reasons)];
}

// --- the rules ------------------------------------------------------------

/** Rule 1 — an ad the platform refused to run. */
async function detectRejectedAds(db: Database, adAccountId: string): Promise<DetectedAlert[]> {
  const ads = await db.query.adAds.findMany({
    where: and(eq(adAds.adAccountId, adAccountId), eq(adAds.effectiveStatus, 'DISAPPROVED')),
  });

  return ads.map((ad) => {
    const reasons = rejectionReasons(ad.reviewFeedback);
    return {
      kind: 'ad_rejected' as const,
      severity: 'critical' as const,
      entityLevel: 'ad' as const,
      entityExternalId: ad.externalId,
      title: `Anúncio reprovado: ${ad.name}`,
      detail: {
        adName: ad.name,
        adExternalId: ad.externalId,
        // The real reason, verbatim from Meta. The spike showed issues_info is
        // empty exactly on rejected ads, so review feedback is the only source.
        reasons,
        issuesInfo: ad.issuesInfo ?? null,
      },
    };
  });
}

export interface PacingFacts {
  periodMonth: string;
  capCents: number;
  usableCents: number;
  committedCents: number;
  spentCents: number;
  availableCents: number;
  expectedCents: number;
  deviationPercent: number | null;
  elapsedDays: number;
  totalDays: number;
}

/**
 * How the month is running so far.
 *
 * The reference line is the usable budget spread evenly over the month. It is
 * a planning line, not a promise: campaigns start and stop. That is why the
 * rule only fires beyond a tolerance band, and never within the first days.
 */
export async function pacingFacts(
  db: Database,
  adAccountId: string,
  now: Date,
): Promise<PacingFacts | null> {
  const periodMonth = periodMonthOf(now);
  const state = await getPeriodState(db, adAccountId, periodMonth);
  if (!state) return null;

  const totalDays = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  // Counting today as elapsed only in proportion to the hours actually gone.
  const elapsedDays = now.getUTCDate() - 1 + now.getUTCHours() / 24;
  const fraction = elapsedDays / totalDays;
  const expectedCents = Math.round(state.usableCents * fraction);

  return {
    periodMonth,
    capCents: state.capCents,
    usableCents: state.usableCents,
    committedCents: state.committedCents,
    spentCents: state.spentCents,
    availableCents: state.availableCents,
    expectedCents,
    deviationPercent:
      expectedCents > 0
        ? Math.round(((state.spentCents - expectedCents) / expectedCents) * 100)
        : null,
    elapsedDays: Math.round(elapsedDays * 10) / 10,
    totalDays,
  };
}

/** Rule 2 — spending materially ahead of, or behind, the even-spend line. */
async function detectBudgetPacing(
  db: Database,
  adAccountId: string,
  config: AlertRuleConfig['budgetPacing'],
  now: Date,
): Promise<DetectedAlert[]> {
  const facts = await pacingFacts(db, adAccountId, now);
  if (!facts) return [];
  if (facts.elapsedDays / facts.totalDays < config.minElapsedFraction) return [];
  if (facts.deviationPercent === null) return [];
  if (Math.abs(facts.deviationPercent) < config.tolerancePercent) return [];

  const ahead = facts.deviationPercent > 0;
  // Under-spending is only a finding when something is actually committed to
  // spend. An account with nothing running is not "behind" — it is idle.
  if (!ahead && facts.committedCents === 0) return [];

  const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, adAccountId) });

  return [
    {
      kind: 'budget_pacing',
      severity: 'warning',
      entityLevel: null,
      entityExternalId: account?.externalId ?? adAccountId,
      title: ahead
        ? `Gasto ${facts.deviationPercent}% acima do previsto para o mês`
        : `Gasto ${Math.abs(facts.deviationPercent)}% abaixo do previsto para o mês`,
      detail: {
        periodMonth: facts.periodMonth,
        expectedCents: facts.expectedCents,
        spentCents: facts.spentCents,
        committedCents: facts.committedCents,
        usableCents: facts.usableCents,
        deviationPercent: facts.deviationPercent,
        elapsedDays: facts.elapsedDays,
        totalDays: facts.totalDays,
      },
    },
  ];
}

/**
 * Rule 3 — creative fatigue: the same people seeing the same ad too often.
 *
 * Stored rows are daily, so the window frequency has to be estimated:
 * impressions over the window divided by the largest single-day reach. Daily
 * reach overlaps heavily, so this is an *upper bound* on true frequency — the
 * rule errs towards flagging early, which is the right direction for a warning
 * a human reads before acting.
 */
async function detectCreativeFatigue(
  db: Database,
  adAccountId: string,
  config: AlertRuleConfig['creativeFatigue'],
  now: Date,
): Promise<DetectedAlert[]> {
  const since = daysAgo(now, config.lookbackDays);

  const rows = await db
    .select({
      entityExternalId: adMetricsDaily.entityExternalId,
      impressions: sql<string>`sum(${adMetricsDaily.impressions})`,
      maxReach: sql<string>`max(${adMetricsDaily.reach})`,
      maxDailyFrequencyMilli: sql<string>`max(${adMetricsDaily.frequencyMilli})`,
      spendCents: sql<string>`sum(${adMetricsDaily.spendCents})`,
    })
    .from(adMetricsDaily)
    .where(
      and(
        eq(adMetricsDaily.adAccountId, adAccountId),
        eq(adMetricsDaily.level, 'ad'),
        gte(adMetricsDaily.day, since),
      ),
    )
    .groupBy(adMetricsDaily.entityExternalId);

  const ads = await db.query.adAds.findMany({ where: eq(adAds.adAccountId, adAccountId) });
  const nameByExternal = new Map(ads.map((ad) => [ad.externalId, ad.name]));

  const found: DetectedAlert[] = [];
  for (const row of rows) {
    const impressions = Number(row.impressions ?? 0);
    const maxReach = Number(row.maxReach ?? 0);
    if (maxReach <= 0) continue;

    const frequencyMilli = Math.round((impressions / maxReach) * 1000);
    if (frequencyMilli < config.frequencyMilli) continue;

    const name = nameByExternal.get(row.entityExternalId) ?? row.entityExternalId;
    found.push({
      kind: 'creative_fatigue',
      severity: 'warning',
      entityLevel: 'ad',
      entityExternalId: row.entityExternalId,
      title: `Criativo desgastado (frequência ${(frequencyMilli / 1000).toFixed(1)}): ${name}`,
      detail: {
        adName: name,
        frequencyMilli,
        thresholdMilli: config.frequencyMilli,
        maxDailyFrequencyMilli: Number(row.maxDailyFrequencyMilli ?? 0),
        impressions,
        maxDailyReach: maxReach,
        spendCents: Number(row.spendCents ?? 0),
        lookbackDays: config.lookbackDays,
        estimate: 'impressões ÷ maior alcance diário (limite superior)',
      },
    });
  }
  return found;
}

/**
 * Rule 4 — Meta ranks the ad below average against its competition.
 *
 * Dormant on this account: rankings come back `UNKNOWN` below Meta's
 * impression threshold, so the query simply finds nothing until volume rises.
 */
async function detectQualityBelowAverage(
  db: Database,
  adAccountId: string,
  config: AlertRuleConfig['qualityBelowAverage'],
  now: Date,
): Promise<DetectedAlert[]> {
  const since = daysAgo(now, config.lookbackDays);

  const rows = await db.query.adMetricsDaily.findMany({
    where: and(
      eq(adMetricsDaily.adAccountId, adAccountId),
      eq(adMetricsDaily.level, 'ad'),
      gte(adMetricsDaily.day, since),
    ),
  });

  const ads = await db.query.adAds.findMany({ where: eq(adAds.adAccountId, adAccountId) });
  const nameByExternal = new Map(ads.map((ad) => [ad.externalId, ad.name]));

  const worst = new Map<string, { ranking: string; day: string }>();
  for (const row of rows) {
    if (!row.qualityRanking || !BELOW_AVERAGE_RANKINGS.has(row.qualityRanking)) continue;
    const current = worst.get(row.entityExternalId);
    if (!current || row.day > current.day) {
      worst.set(row.entityExternalId, { ranking: row.qualityRanking, day: row.day });
    }
  }

  return [...worst].map(([externalId, { ranking, day }]) => ({
    kind: 'quality_below_average' as const,
    severity: 'warning' as const,
    entityLevel: 'ad' as const,
    entityExternalId: externalId,
    title: `Qualidade abaixo da média: ${nameByExternal.get(externalId) ?? externalId}`,
    detail: {
      adName: nameByExternal.get(externalId) ?? externalId,
      qualityRanking: ranking,
      observedOn: day,
      lookbackDays: config.lookbackDays,
    },
  }));
}

/**
 * Rule 5 — real money spent, no conversion recorded.
 *
 * Off by default. With no lead event ever recorded on this account, every
 * campaign would trip it on day one and the alert would train people to ignore
 * alerts. It is here, tested, waiting for the first delivering lead form.
 */
async function detectConversionSilence(
  db: Database,
  adAccountId: string,
  config: AlertRuleConfig['conversionSilence'],
  now: Date,
): Promise<DetectedAlert[]> {
  const since = dayString(new Date(now.getTime() - config.windowHours * 3_600_000));

  const rows = await db
    .select({
      entityExternalId: adMetricsDaily.entityExternalId,
      spendCents: sql<string>`sum(${adMetricsDaily.spendCents})`,
      conversions: sql<string>`sum(${adMetricsDaily.conversions})`,
    })
    .from(adMetricsDaily)
    .where(
      and(
        eq(adMetricsDaily.adAccountId, adAccountId),
        eq(adMetricsDaily.level, 'campaign'),
        gte(adMetricsDaily.day, since),
      ),
    )
    .groupBy(adMetricsDaily.entityExternalId);

  const campaigns = await db.query.adCampaigns.findMany({
    where: eq(adCampaigns.adAccountId, adAccountId),
  });
  const nameByExternal = new Map(campaigns.map((c) => [c.externalId, c.name]));

  const found: DetectedAlert[] = [];
  for (const row of rows) {
    const spendCents = Number(row.spendCents ?? 0);
    const conversions = Number(row.conversions ?? 0);
    if (conversions > 0 || spendCents < config.spendCents) continue;

    const name = nameByExternal.get(row.entityExternalId) ?? row.entityExternalId;
    found.push({
      kind: 'conversion_silence',
      severity: 'critical',
      entityLevel: 'campaign',
      entityExternalId: row.entityExternalId,
      title: `${formatBrl(spendCents)} gastos sem nenhuma conversão: ${name}`,
      detail: {
        campaignName: name,
        spendCents,
        thresholdCents: config.spendCents,
        windowHours: config.windowHours,
      },
    });
  }
  return found;
}

/** Runs every enabled rule. Pure read — nothing is written here. */
export async function detectAlerts(
  db: Database,
  adAccountId: string,
  config: AlertRuleConfig = DEFAULT_ALERT_CONFIG,
  now = new Date(),
): Promise<DetectedAlert[]> {
  const found: DetectedAlert[] = [];

  if (config.adRejected.enabled) found.push(...(await detectRejectedAds(db, adAccountId)));
  if (config.budgetPacing.enabled) {
    found.push(...(await detectBudgetPacing(db, adAccountId, config.budgetPacing, now)));
  }
  if (config.creativeFatigue.enabled) {
    found.push(...(await detectCreativeFatigue(db, adAccountId, config.creativeFatigue, now)));
  }
  if (config.qualityBelowAverage.enabled) {
    found.push(
      ...(await detectQualityBelowAverage(db, adAccountId, config.qualityBelowAverage, now)),
    );
  }
  if (config.conversionSilence.enabled) {
    found.push(...(await detectConversionSilence(db, adAccountId, config.conversionSilence, now)));
  }

  return found;
}

export interface RunAlertsResult {
  detected: number;
  opened: number;
  refreshed: number;
  resolved: number;
  notified: number;
  notificationErrors: number;
}

export interface RunAlertsOptions {
  config?: AlertRuleConfig;
  notifier?: AlertNotifier;
  now?: Date;
}

/**
 * Detects, stores and notifies in one pass — the job the scheduled task runs.
 *
 * Notification failure never loses the alert: the row is already stored, the
 * error is recorded on it, and the next run tries again because `notifiedAt`
 * is still null.
 */
export async function runAlerts(
  db: Database,
  adAccountId: string,
  options: RunAlertsOptions = {},
): Promise<RunAlertsResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? DEFAULT_ALERT_CONFIG;
  const detected = await detectAlerts(db, adAccountId, config, now);

  const open = await db.query.adAlerts.findMany({
    where: and(eq(adAlerts.adAccountId, adAccountId), isNull(adAlerts.resolvedAt)),
  });
  const key = (kind: string, entity: string | null) => `${kind}::${entity ?? ''}`;
  const openByKey = new Map(open.map((row) => [key(row.kind, row.entityExternalId), row]));

  const result: RunAlertsResult = {
    detected: detected.length,
    opened: 0,
    refreshed: 0,
    resolved: 0,
    notified: 0,
    notificationErrors: 0,
  };
  const toNotify: AlertNotification[] = [];
  const stillOpen = new Set<string>();

  for (const alert of detected) {
    const alertKey = key(alert.kind, alert.entityExternalId);
    stillOpen.add(alertKey);
    const existing = openByKey.get(alertKey);

    if (existing) {
      await db
        .update(adAlerts)
        .set({
          severity: alert.severity,
          title: alert.title,
          detail: alert.detail,
          entityLevel: alert.entityLevel,
          lastSeenAt: now,
        })
        .where(eq(adAlerts.id, existing.id));
      result.refreshed += 1;
      // A still-open alert that never reached anyone is retried, not dropped.
      if (existing.notifiedAt === null && CRITICAL_KINDS.has(alert.kind)) {
        toNotify.push({
          alertId: existing.id,
          adAccountId,
          kind: alert.kind,
          severity: alert.severity,
          title: alert.title,
          detail: alert.detail,
        });
      }
      continue;
    }

    const [inserted] = await db
      .insert(adAlerts)
      .values({
        adAccountId,
        kind: alert.kind,
        severity: alert.severity,
        entityLevel: alert.entityLevel,
        entityExternalId: alert.entityExternalId,
        title: alert.title,
        detail: alert.detail,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning({ id: adAlerts.id });
    result.opened += 1;

    if (inserted && CRITICAL_KINDS.has(alert.kind)) {
      toNotify.push({
        alertId: inserted.id,
        adAccountId,
        kind: alert.kind,
        severity: alert.severity,
        title: alert.title,
        detail: alert.detail,
      });
    }
  }

  // Conditions that stopped holding close themselves: a fixed ad should not
  // leave a red badge behind.
  for (const [alertKey, row] of openByKey) {
    if (stillOpen.has(alertKey)) continue;
    await db.update(adAlerts).set({ resolvedAt: now }).where(eq(adAlerts.id, row.id));
    result.resolved += 1;
  }

  const notifier = options.notifier;
  for (const notification of toNotify) {
    if (!notifier) break;
    try {
      await notifier.send(notification);
      await db
        .update(adAlerts)
        .set({ notifiedAt: now, notificationError: null })
        .where(eq(adAlerts.id, notification.alertId));
      result.notified += 1;
    } catch (error) {
      await db
        .update(adAlerts)
        .set({ notificationError: error instanceof Error ? error.message : String(error) })
        .where(eq(adAlerts.id, notification.alertId));
      result.notificationErrors += 1;
    }
  }

  return result;
}

/** Marks an alert as seen by a person. Acknowledging never resolves it. */
export async function acknowledgeAlert(
  db: Database,
  alertId: string,
  employeeId: string,
  now = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(adAlerts)
    .set({ acknowledgedAt: now, acknowledgedBy: employeeId })
    .where(and(eq(adAlerts.id, alertId), isNull(adAlerts.acknowledgedAt)))
    .returning({ id: adAlerts.id });
  return updated.length > 0;
}
