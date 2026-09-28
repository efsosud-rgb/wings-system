import { dailyOverdeliveryFactor, periodOverdeliveryFactor } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCampaigns,
  adChangeRequests,
  adSets,
  budgetPeriods,
} from '../../db/schema/index.js';
import {
  campaignExposure,
  exposureOf,
  remainingDays,
} from './budget-guard.js';

/**
 * The scenario simulator behind the approval screen.
 *
 * Read-only: it computes what a change would mean against the month's cap and
 * changes nothing. It reuses the guard's own exposure maths rather than
 * reimplementing it, so the number an approver reads is the number the guard
 * enforces.
 *
 * One thing this has to be honest about: exposure is reserved **when the change
 * is requested**, not when it is approved. So a pending request is already
 * inside `committed_cents`. Approving it changes reality (the platform starts
 * spending), not the committed figure; rejecting it releases the reservation.
 * The simulator therefore reports both "com esta solicitação" and "se for
 * recusada", because a screen showing only the current committed total would
 * look as if approving cost nothing.
 */

/** Exposure is reserved at request time, so these two totals differ. */
export interface PeriodContext {
  periodMonth: string;
  capCents: number;
  usableCents: number;
  spentCents: number;
  /** Committed as it stands now, already holding this request's reservation. */
  committedWithRequestCents: number;
  /** Committed if this request were rejected and its reservation released. */
  committedWithoutRequestCents: number;
}

export interface ExposureScenario {
  label: 'current' | 'requested' | 'simulated';
  /** Daily budget this scenario assumes, in cents. */
  dailyBudgetCents: number;
  /** What the campaign would put at risk for the rest of the month. */
  campaignExposureCents: number;
  /** Account commitment under this scenario. */
  committedCents: number;
  /** What would still be available to plan afterwards. */
  availableCents: number;
  /** Commitment as a share of the usable slice, percent (integer). */
  usedOfUsablePercent: number;
  /** Commitment plus real spend as a share of the hard cap, percent (integer). */
  usedOfCapPercent: number;
  withinUsable: boolean;
  withinCap: boolean;
  /** Days this daily budget could run before exhausting what is available. */
  runwayDays: number | null;
}

export interface ChangeSimulation {
  changeRequestId: string;
  kind: string;
  campaignName: string;
  campaignExternalId: string;
  budgetLevel: 'campaign' | 'ad_set' | 'none';
  /** Days left in the period, counting today, in the account's timezone. */
  daysLeftInPeriod: number;
  /** Overdelivery allowance folded into every exposure figure, x1000. */
  overdeliveryFactorMilli: number;
  period: PeriodContext;
  current: ExposureScenario;
  requested: ExposureScenario;
  /** Present only when an alternative daily budget was asked about. */
  simulated: ExposureScenario | null;
  /** True when trying other values makes sense: only a CBO budget change. */
  simulationAvailable: boolean;
  /**
   * Set when the mirrored platform state no longer matches what the request
   * was built from. The executor refuses in that case; saying so before the
   * decision saves an approval that could never be executed.
   */
  drift: { field: string; expectedCents: number; mirroredCents: number } | null;
  /** When the campaign figures were last mirrored from the platform. */
  campaignSyncedAt: string | null;
}

function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}

function scenario(
  label: ExposureScenario['label'],
  input: {
    dailyBudgetCents: number;
    campaignExposureCents: number;
    committedCents: number;
    capCents: number;
    usableCents: number;
    spentCents: number;
    daysLeft: number;
    /** meta | google: which overdelivery the platform promises. */
    platform: string;
  },
): ExposureScenario {
  const capHeadroom = Math.max(0, input.capCents - input.spentCents - input.committedCents);
  const usableHeadroom = Math.max(0, input.usableCents - input.committedCents);
  const availableCents = Math.min(capHeadroom, usableHeadroom);
  const dailyWithOverdelivery = input.dailyBudgetCents * dailyOverdeliveryFactor(input.platform);

  return {
    label,
    dailyBudgetCents: input.dailyBudgetCents,
    campaignExposureCents: input.campaignExposureCents,
    committedCents: input.committedCents,
    availableCents,
    usedOfUsablePercent: percent(input.committedCents, input.usableCents),
    usedOfCapPercent: percent(input.committedCents + input.spentCents, input.capCents),
    withinUsable: input.committedCents <= input.usableCents,
    withinCap: input.committedCents + input.spentCents <= input.capCents,
    runwayDays:
      dailyWithOverdelivery > 0 ? Math.floor(availableCents / dailyWithOverdelivery) : null,
  };
}

/**
 * Simulates one pending change, optionally against an alternative daily budget.
 *
 * `alternativeDailyBudgetCents` answers "what if we approved a smaller number
 * instead?" — it is exploration only. The decision still applies the value that
 * was requested; there is no path here that edits or approves anything.
 */
export async function simulateChange(
  db: Database,
  changeRequestId: string,
  options: { alternativeDailyBudgetCents?: number; now?: Date } = {},
): Promise<ChangeSimulation | null> {
  const now = options.now ?? new Date();

  const change = await db.query.adChangeRequests.findFirst({
    where: eq(adChangeRequests.id, changeRequestId),
  });
  // Nothing to simulate for a campaign that does not exist yet: its cost is on
  // the approval screen already, taken from the draft.
  if (!change || !change.campaignId) return null;

  const [account, campaign, period] = await Promise.all([
    db.query.adAccounts.findFirst({ where: eq(adAccounts.id, change.adAccountId) }),
    db.query.adCampaigns.findFirst({ where: eq(adCampaigns.id, change.campaignId) }),
    db.query.budgetPeriods.findFirst({ where: eq(budgetPeriods.id, change.budgetPeriodId) }),
  ]);
  if (!account || !campaign || !period) return null;

  const campaignAdSets = await db.query.adSets.findMany({
    where: eq(adSets.campaignId, campaign.id),
  });
  const daysLeft = remainingDays(now, account.timezone);

  // Exposure of the campaign exactly as mirrored today.
  const currentExposureCents = campaignExposure(
    {
      campaignStatus: campaign.status,
      campaignDailyBudgetCents: campaign.dailyBudgetCents,
      adSets: campaignAdSets,
    },
    daysLeft,
  );

  // The reservation is live while the request is pending, so back it out to
  // show what the month looks like without this request.
  const committedWithRequestCents = period.committedCents;
  const committedWithoutRequestCents = change.reservationActive
    ? period.committedCents - change.exposureDeltaCents
    : period.committedCents;

  const periodContext: PeriodContext = {
    periodMonth: period.periodMonth,
    capCents: period.capCents,
    usableCents: period.usableCents,
    spentCents: period.spentCents,
    committedWithRequestCents,
    committedWithoutRequestCents,
  };

  const common = {
    capCents: period.capCents,
    usableCents: period.usableCents,
    spentCents: period.spentCents,
    daysLeft,
    platform: account.platform,
  };

  const current = scenario('current', {
    ...common,
    dailyBudgetCents: change.fromValueCents ?? 0,
    campaignExposureCents: currentExposureCents,
    committedCents: committedWithoutRequestCents,
  });

  const requested = scenario('requested', {
    ...common,
    dailyBudgetCents: change.toValueCents ?? 0,
    campaignExposureCents: currentExposureCents + change.exposureDeltaCents,
    committedCents: committedWithRequestCents,
  });

  // Only a campaign-level budget change has a number worth varying: a pause is
  // a pause, and an ABO campaign holds no budget of its own.
  const simulationAvailable =
    change.kind === 'set_daily_budget' && campaign.budgetLevel !== 'ad_set';

  let simulated: ExposureScenario | null = null;
  if (simulationAvailable && options.alternativeDailyBudgetCents !== undefined) {
    const value = Math.max(0, Math.round(options.alternativeDailyBudgetCents));
    const exposure = Math.max(
      exposureOf(value, daysLeft, periodOverdeliveryFactor(account.platform)),
      value > 0 ? exposureOf(value, 1, dailyOverdeliveryFactor(account.platform)) : 0,
    );
    simulated = scenario('simulated', {
      ...common,
      dailyBudgetCents: value,
      campaignExposureCents: exposure,
      committedCents: committedWithoutRequestCents + (exposure - currentExposureCents),
    });
  }

  // The request was built from a budget that has since changed on the platform.
  const drift =
    change.kind === 'set_daily_budget' &&
    change.fromValueCents !== null &&
    campaign.status === 'ACTIVE' &&
    campaign.dailyBudgetCents !== change.fromValueCents
      ? {
          field: 'daily_budget',
          expectedCents: change.fromValueCents,
          mirroredCents: campaign.dailyBudgetCents,
        }
      : null;

  return {
    changeRequestId: change.id,
    kind: change.kind,
    campaignName: campaign.name,
    campaignExternalId: campaign.externalId,
    budgetLevel: campaign.budgetLevel,
    daysLeftInPeriod: daysLeft,
    overdeliveryFactorMilli: Math.round(periodOverdeliveryFactor(account.platform) * 1000),
    period: periodContext,
    current,
    requested,
    simulated,
    simulationAvailable,
    drift,
    campaignSyncedAt: campaign.lastSyncedAt ? campaign.lastSyncedAt.toISOString() : null,
  };
}
