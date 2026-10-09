import {
  earliestEnd,
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
  const ownAdSets = await db
    .select({
      campaignId: adSets.campaignId,
      dailyBudgetCents: adSets.dailyBudgetCents,
      endDate: adSets.endDate,
    })
    .from(adSets)
    .innerJoin(adCampaigns, eq(adCampaigns.id, adSets.campaignId))
    .where(sql`${adCampaigns.adAccountId} = ${adAccountId} and ${adSets.status} = 'ACTIVE'`);

  // The schedule may live on the ad sets (Meta): a campaign that holds the budget ends with the
  // ones that are on; one whose ad sets hold it is one stream per ad set, each until its own end.
  const endOf = await effectiveCampaignEnds(db, campaigns);
  return campaigns.flatMap((campaign): ActiveCampaignBudget[] => {
    const startDate = campaign.startDate && campaign.startDate > today ? campaign.startDate : null;
    const streams =
      campaign.budgetLevel === 'ad_set'
        ? ownAdSets
            .filter((row) => row.campaignId === campaign.id)
            .map((row) => ({
              dailyBudgetCents: row.dailyBudgetCents,
              endDate: earliestEnd(campaign.endDate, row.endDate),
            }))
        : [
            {
              dailyBudgetCents: campaign.dailyBudgetCents,
              endDate: endOf.get(campaign.id) ?? null,
            },
          ];
    return streams
      .filter(
        (stream) =>
          stream.dailyBudgetCents > 0 && (stream.endDate === null || stream.endDate >= today),
      )
      .map((stream) => ({
        campaignExternalId: campaign.externalId,
        name: campaign.name,
        dailyBudgetCents: stream.dailyBudgetCents,
        startDate,
        endDate: stream.endDate,
      }));
  });
}
