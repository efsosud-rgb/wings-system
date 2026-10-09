import {
  firstOfNextMonth,
  PLATFORM_READING_STALE_MINUTES,
  SPEND_CAP_RESETS,
  type ActiveCampaignBudget,
  type PlatformAccountReading,
  type SpendCapReset,
} from '@wings/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adCampaigns, adSets } from '../../db/schema/index.js';
import { effectiveCampaignEnds } from './campaign-end.js';

/**
 * The platform's account figures as the screens may show them: current, or
 * absent with the reason. Never the last number dressed up as today's — a
 * failed or overdue read empties every figure, and says why.
 */
export function platformReadingOf(
  period: {
    platformLimitSyncedAt: Date | null;
    platformReadAttemptedAt: Date | null;
    platformReadError: string | null;
    platformSpendCapCents: number | null;
    platformAmountSpentCents: number | null;
    platformAmountDueCents: number | null;
    platformPrepaidBalanceCents: number | null;
    platformFundingKind: string | null;
  } | null,
  account: { spendCapReset: string | null },
  today: string,
  now: Date,
): PlatformAccountReading {
  const reset = spendCapResetOf(account.spendCapReset);
  const readAt = period?.platformLimitSyncedAt ?? null;
  const attemptedAt = period?.platformReadAttemptedAt ?? readAt;

  let status: PlatformAccountReading['status'];
  let reason: string | null = null;
  if (period?.platformReadError) {
    status = 'failed';
    reason = `a última leitura falhou: ${period.platformReadError}`;
  } else if (!readAt) {
    status = 'never';
    reason = 'a plataforma ainda não foi lida para esta conta';
  } else if (now.getTime() - readAt.getTime() > PLATFORM_READING_STALE_MINUTES * 60_000) {
    status = 'stale';
    reason = `sem leitura da plataforma há mais de ${PLATFORM_READING_STALE_MINUTES} min — a atualização automática parou`;
  } else {
    status = 'ok';
  }

  const current = status === 'ok' && period !== null;
  const spendCap = current ? period.platformSpendCapCents : null;
  const spent = current ? period.platformAmountSpentCents : null;
  return {
    status,
    reason,
    readAtIso: readAt?.toISOString() ?? null,
    attemptedAtIso: attemptedAt?.toISOString() ?? null,
    spendCapCents: spendCap,
    amountSpentCents: spent,
    spendCapRemainingCents:
      spendCap === null || spent === null ? null : Math.max(0, spendCap - spent),
    amountDueCents: current ? period.platformAmountDueCents : null,
    prepaidBalanceCents: current ? period.platformPrepaidBalanceCents : null,
    fundingKind: current ? period.platformFundingKind : null,
    spendCapReset: reset,
    spendCapResetsOn: reset === 'monthly' ? firstOfNextMonth(today) : null,
  };
}

export function spendCapResetOf(value: string | null): SpendCapReset | null {
  return (SPEND_CAP_RESETS as readonly string[]).includes(value ?? '')
    ? (value as SpendCapReset)
    : null;
}

/**
 * Budgets in force: an active CBO campaign's own budget, or the budgets of an
 * ABO campaign's active ad sets — the same rule as `recordAccountDay`. A
 * campaign whose end date has passed draws nothing.
 */
export async function activeBudgetsOf(
  db: Database,
  adAccountId: string,
  today: string,
): Promise<ActiveCampaignBudget[]> {
  const campaigns = await db.query.adCampaigns.findMany({
    where: and(eq(adCampaigns.adAccountId, adAccountId), eq(adCampaigns.status, 'ACTIVE')),
  });
  const adSetTotals = await db
    .select({
      campaignId: adSets.campaignId,
      total: sql<string>`coalesce(sum(${adSets.dailyBudgetCents}), 0)`,
    })
    .from(adSets)
    .innerJoin(adCampaigns, eq(adCampaigns.id, adSets.campaignId))
    .where(sql`${adCampaigns.adAccountId} = ${adAccountId} and ${adSets.status} = 'ACTIVE'`)
    .groupBy(adSets.campaignId);
  const byCampaign = new Map(adSetTotals.map((row) => [row.campaignId, Number(row.total)]));

  // The schedule may live on the ad sets (Meta): the campaign ends with the ones that are on.
  const endOf = await effectiveCampaignEnds(db, campaigns);
  return campaigns
    .filter((campaign) => {
      const end = endOf.get(campaign.id) ?? null;
      return end === null || end >= today;
    })
    .map((campaign) => ({
      campaignExternalId: campaign.externalId,
      name: campaign.name,
      dailyBudgetCents:
        campaign.budgetLevel === 'ad_set'
          ? (byCampaign.get(campaign.id) ?? 0)
          : campaign.dailyBudgetCents,
      startDate: campaign.startDate && campaign.startDate > today ? campaign.startDate : null,
      endDate: endOf.get(campaign.id) ?? null,
    }))
    .filter((budget) => budget.dailyBudgetCents > 0);
}
