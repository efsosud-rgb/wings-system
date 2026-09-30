import {
  EMPTY_TOTALS,
  objectiveKindOf,
  ratiosOf,
  verdictOf,
  type AdPlatform,
  type DashboardWindow,
  type MetricTotals,
  type ObjectiveKind,
  type VerdictResult,
} from '@wings/shared';
import { inArray } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { adCampaigns } from '../../../db/schema/index.js';
import { activeAccounts, sumsByEntity } from './queries.js';
import { confirmedAccountTargets, confirmedTargets } from './targets.js';
import { addDays, dayIn, windowOf } from './window.js';

/**
 * The verdict of every mirrored campaign, from our own tables.
 *
 * The rule is `verdictOf` in `packages/shared`; this file only gathers what
 * it needs: the window's sums, the last 7 days against the 7 before, the
 * account's median CTR over 90 days, the confirmed targets and the budget in
 * force. Used by the Campanhas tab and read by the insights generator.
 */

export interface CampaignVerdictRow {
  campaignId: string;
  campaignExternalId: string;
  adAccountId: string;
  name: string;
  platform: AdPlatform;
  status: string;
  objective: string | null;
  objectiveKind: ObjectiveKind;
  dailyBudgetCents: number | null;
  totals: MetricTotals;
  /** The CPL target the verdict used for a leads campaign; null otherwise or without one. */
  targetCplCents: number | null;
  verdict: VerdictResult;
}

const MEDIAN_DAYS = 90;
const MEDIAN_MIN_IMPRESSIONS = 500;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

export async function campaignVerdicts(
  db: Database,
  days: DashboardWindow,
  now = new Date(),
): Promise<CampaignVerdictRow[]> {
  const accounts = await activeAccounts(db);
  const ids = accounts.map((account) => account.id);
  if (ids.length === 0) return [];
  const window = windowOf(days, now);
  const today = dayIn(now);
  const last7Since = addDays(today, -6);
  const prev7Until = addDays(last7Since, -1);
  const prev7Since = addDays(prev7Until, -6);
  const medianSince = addDays(today, -(MEDIAN_DAYS - 1));

  const [campaigns, sums, last7, prev7, history, targets, accountTargets] = await Promise.all([
    db.query.adCampaigns.findMany({ where: inArray(adCampaigns.adAccountId, ids) }),
    sumsByEntity(db, ids, 'campaign', window.since, window.until),
    sumsByEntity(db, ids, 'campaign', last7Since, today),
    sumsByEntity(db, ids, 'campaign', prev7Since, prev7Until),
    sumsByEntity(db, ids, 'campaign', medianSince, today),
    confirmedTargets(db),
    confirmedAccountTargets(db),
  ]);
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  // The account's median CTR over 90 days, over campaigns that delivered enough to have one.
  const ctrsByAccount = new Map<string, number[]>();
  for (const campaign of campaigns) {
    const totals = history.get(campaign.externalId);
    if (!totals || totals.impressions < MEDIAN_MIN_IMPRESSIONS) continue;
    const ctr = ratiosOf(totals).ctrMilli;
    if (ctr === null) continue;
    ctrsByAccount.set(campaign.adAccountId, [
      ...(ctrsByAccount.get(campaign.adAccountId) ?? []),
      ctr,
    ]);
  }
  const medianByAccount = new Map(
    [...ctrsByAccount].map(([accountId, ctrs]) => [accountId, median(ctrs)]),
  );

  return campaigns.map((campaign) => {
    const account = accountById.get(campaign.adAccountId);
    const platform = (account?.platform ?? 'meta') as AdPlatform;
    const objectiveKind = objectiveKindOf(campaign.objective, platform);
    const totals = sums.get(campaign.externalId) ?? EMPTY_TOTALS;
    const ratios = ratiosOf(totals);
    const current = ratiosOf(last7.get(campaign.externalId) ?? EMPTY_TOTALS);
    const previous = ratiosOf(prev7.get(campaign.externalId) ?? EMPTY_TOTALS);
    const dailyBudgetCents =
      campaign.budgetLevel === 'campaign' ? campaign.dailyBudgetCents || null : null;
    const targetKind: ObjectiveKind | null =
      objectiveKind === 'leads' ? 'leads' : objectiveKind === 'traffic' ? 'traffic' : null;
    // The account's own CPL target wins over the company's: Meta and Google
    // leads do not cost the same.
    const targetCplCents = targetKind
      ? ((targetKind === 'leads' ? accountTargets.get(campaign.adAccountId) : undefined) ??
        targets.get(targetKind) ??
        null)
      : null;

    return {
      campaignId: campaign.id,
      campaignExternalId: campaign.externalId,
      adAccountId: campaign.adAccountId,
      name: campaign.name,
      platform,
      status: campaign.status,
      objective: campaign.objective,
      objectiveKind,
      dailyBudgetCents,
      totals,
      targetCplCents: targetKind === 'leads' ? targetCplCents : null,
      verdict: verdictOf({
        objectiveKind,
        spendCents: totals.spendCents,
        impressions: totals.impressions,
        conversions: totals.conversions,
        cplCents: ratios.costPerLeadCents,
        ctrMilli: ratios.ctrMilli,
        frequencyMilli: ratios.frequencyMilli,
        targetCplCents,
        accountMedianCtrMilli: medianByAccount.get(campaign.adAccountId) ?? null,
        trend: {
          currentCplCents: current.costPerLeadCents,
          previousCplCents: previous.costPerLeadCents,
          currentCtrMilli: current.ctrMilli,
          previousCtrMilli: previous.ctrMilli,
        },
        pacing: {
          last7SpendCents: (last7.get(campaign.externalId) ?? EMPTY_TOTALS).spendCents,
          dailyBudgetCents,
        },
      }),
    };
  });
}
