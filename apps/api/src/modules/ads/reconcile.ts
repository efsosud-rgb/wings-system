import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCampaigns,
  adGuardrailEvents,
  adSets,
  adSpendSnapshots,
  budgetPeriods,
} from '../../db/schema/index.js';
import {
  applyPlatformLimit,
  applyReportedSpend,
  campaignExposure,
  engageKillSwitch,
  remainingDays,
} from './budget-guard.js';
import { effectiveHeadroomCents, limitFrom } from './platform/limits.js';
import type { AdsPlatformClient } from './platform/types.js';

/**
 * Reconciliation: what the platform says, written down as fact.
 *
 * This is the loop that keeps the guardrail honest. It is also the dead-man
 * switch: if reconciliation stops succeeding, the system stops spending rather
 * than continuing blind. Not knowing what is being spent is treated as an
 * emergency, never as permission to carry on.
 */

export function periodMonthOf(now: Date, timezone = 'America/Sao_Paulo'): string {
  const month = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .slice(0, 7);
  return `${month}-01`;
}

export interface ReconcileResult {
  campaignsSynced: number;
  adSetsSynced: number;
  spendRowsRecorded: number;
  spentCents: number;
  committedCents: number;
  killSwitchEngaged: boolean;
  /** Set when platform budgets imply more exposure than the plan allows. */
  outOfBandChangeDetected: boolean;
  /** What the platform itself still allows; null when it sets no limit. */
  platformRemainingCents: number | null;
  /** True when the platform allows less than our own cap would. */
  platformIsBinding: boolean;
}

/**
 * Mirrors campaigns and their ad sets. Read-only against the platform.
 *
 * The budget level is recorded per campaign, because an account mixes CBO and
 * ABO campaigns and the exposure calculation must follow the money.
 */
export async function syncCampaigns(
  db: Database,
  client: AdsPlatformClient,
  adAccountId: string,
  now = new Date(),
): Promise<{ campaigns: number; adSets: number }> {
  const campaigns = await client.listCampaigns();
  const platformAdSets = await client.listAdSets();

  const adSetsByCampaign = new Map<string, typeof platformAdSets>();
  for (const adSet of platformAdSets) {
    const list = adSetsByCampaign.get(adSet.campaignId) ?? [];
    list.push(adSet);
    adSetsByCampaign.set(adSet.campaignId, list);
  }

  for (const campaign of campaigns) {
    await db
      .insert(adCampaigns)
      .values({
        adAccountId,
        externalId: campaign.id,
        name: campaign.name,
        status: campaign.status,
        dailyBudgetCents: campaign.dailyBudgetCents ?? 0,
        lifetimeBudgetCents: campaign.lifetimeBudgetCents,
        budgetLevel: budgetLevelOf(campaign, adSetsByCampaign.get(campaign.id) ?? []),
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [adCampaigns.adAccountId, adCampaigns.externalId],
        set: {
          name: campaign.name,
          status: campaign.status,
          dailyBudgetCents: campaign.dailyBudgetCents ?? 0,
          lifetimeBudgetCents: campaign.lifetimeBudgetCents,
          budgetLevel: budgetLevelOf(campaign, adSetsByCampaign.get(campaign.id) ?? []),
          lastSyncedAt: now,
          updatedAt: now,
        },
      });
  }

  // Ad sets are stored under the campaign row we just upserted.
  const stored = await db.query.adCampaigns.findMany({
    where: eq(adCampaigns.adAccountId, adAccountId),
  });
  const idByExternal = new Map(stored.map((campaign) => [campaign.externalId, campaign.id]));

  let adSetCount = 0;
  for (const adSet of platformAdSets) {
    const campaignId = idByExternal.get(adSet.campaignId);
    if (!campaignId) continue; // ad set of a campaign outside this account
    await db
      .insert(adSets)
      .values({
        campaignId,
        externalId: adSet.id,
        name: adSet.name,
        status: adSet.status,
        dailyBudgetCents: adSet.dailyBudgetCents ?? 0,
        lifetimeBudgetCents: adSet.lifetimeBudgetCents,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [adSets.campaignId, adSets.externalId],
        set: {
          name: adSet.name,
          status: adSet.status,
          dailyBudgetCents: adSet.dailyBudgetCents ?? 0,
          lifetimeBudgetCents: adSet.lifetimeBudgetCents,
          lastSyncedAt: now,
          updatedAt: now,
        },
      });
    adSetCount += 1;
  }

  return { campaigns: campaigns.length, adSets: adSetCount };
}

/** CBO when the campaign holds a budget, ABO when its ad sets do. */
function budgetLevelOf(
  campaign: { dailyBudgetCents: number | null; lifetimeBudgetCents: number | null },
  adSetsOfCampaign: { dailyBudgetCents: number | null; lifetimeBudgetCents: number | null }[],
): 'campaign' | 'ad_set' | 'none' {
  if ((campaign.dailyBudgetCents ?? 0) > 0 || (campaign.lifetimeBudgetCents ?? 0) > 0) {
    return 'campaign';
  }
  const adSetHasBudget = adSetsOfCampaign.some(
    (adSet) => (adSet.dailyBudgetCents ?? 0) > 0 || (adSet.lifetimeBudgetCents ?? 0) > 0,
  );
  return adSetHasBudget ? 'ad_set' : 'none';
}

/**
 * Pulls reported spend, records it append-only, and re-derives the period
 * totals from what is actually on the platform.
 */
export async function reconcileAccount(
  db: Database,
  client: AdsPlatformClient,
  adAccountId: string,
  now = new Date(),
): Promise<ReconcileResult> {
  const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, adAccountId) });
  if (!account) throw new Error('ad account not found');

  const periodMonth = periodMonthOf(now, account.timezone);
  const period = await db.query.budgetPeriods.findFirst({
    where: and(
      eq(budgetPeriods.adAccountId, adAccountId),
      eq(budgetPeriods.periodMonth, periodMonth),
    ),
  });
  if (!period) throw new Error(`no budget period open for ${periodMonth}`);

  const synced = await syncCampaigns(db, client, adAccountId, now);

  // What the platform itself allows, read from its own API rather than assumed.
  // Meta reports spend_cap and amount_spent on the account; a prepaid Google
  // account reports the same shape through its account budget.
  const platformAccount = await client.getAccount();
  const platformLimit = limitFrom(
    platformAccount.spendCapCents,
    platformAccount.amountSpentCents,
    `${client.platform}.spend_cap`,
  );
  const limitResult = await applyPlatformLimit(db, {
    adAccountId,
    periodMonth,
    limit: platformLimit,
    now,
  });

  const spendRows = await client.getSpend(periodMonth);

  const campaigns = await db.query.adCampaigns.findMany({
    where: eq(adCampaigns.adAccountId, adAccountId),
  });
  const byExternalId = new Map(campaigns.map((c) => [c.externalId, c]));

  for (const row of spendRows) {
    await db.insert(adSpendSnapshots).values({
      adAccountId,
      campaignId: byExternalId.get(row.campaignId)?.id ?? null,
      spendDate: row.date,
      spendCents: row.spendCents,
      asOf: now,
    });
  }

  // Latest snapshot per campaign per day wins: reported figures get revised.
  const totals = await db.execute<{ total: string } & Record<string, unknown>>(sql`
    select coalesce(sum(spend_cents), 0)::text as total
      from (
        select distinct on (campaign_id, spend_date) spend_cents
          from ad_spend_snapshots
         where ad_account_id = ${adAccountId}
           and spend_date >= ${periodMonth}
         order by campaign_id, spend_date, as_of desc
      ) latest
  `);
  const spentCents = Number(totals.rows[0]?.total ?? 0);

  const applied = await applyReportedSpend(db, { periodId: period.id, spentCents, now });

  // Re-derive commitment from what is really running on the platform. If
  // someone changed budgets directly in Ads Manager, this is where we find out.
  const daysLeft = remainingDays(now, account.timezone);
  const allAdSets = await db.query.adSets.findMany();
  const adSetsByCampaignId = new Map<string, typeof allAdSets>();
  for (const adSet of allAdSets) {
    const list = adSetsByCampaignId.get(adSet.campaignId) ?? [];
    list.push(adSet);
    adSetsByCampaignId.set(adSet.campaignId, list);
  }

  // Exposure follows the budget, whether it sits on the campaign (CBO) or on
  // its ad sets (ABO).
  const desiredCommitted = campaigns.reduce(
    (total, campaign) =>
      total +
      campaignExposure(
        {
          campaignStatus: campaign.status,
          campaignDailyBudgetCents: campaign.dailyBudgetCents,
          adSets: adSetsByCampaignId.get(campaign.id) ?? [],
        },
        daysLeft,
      ),
    0,
  );

  const internalAllowed = Math.min(period.usableCents, Math.max(0, period.capCents - spentCents));
  // Three ceilings, smallest wins: usable slice, hard cap, and what the
  // platform will actually let us spend.
  const allowed = effectiveHeadroomCents(internalAllowed, platformLimit.remainingCents);
  const outOfBandChangeDetected = desiredCommitted > allowed;
  const committedCents = Math.min(desiredCommitted, allowed);

  await db
    .update(budgetPeriods)
    .set({ committedCents, lastReconciledAt: now, updatedAt: now })
    .where(eq(budgetPeriods.id, period.id));

  if (outOfBandChangeDetected) {
    await db.insert(adGuardrailEvents).values({
      adAccountId,
      kind: 'usable_would_be_exceeded',
      detail: {
        note: 'Orçamentos na plataforma excedem o plano — alteração feita fora do sistema?',
        desiredCommittedCents: desiredCommitted,
        allowedCents: allowed,
        spentCents,
      },
    });
    await engageKillSwitch(
      db,
      adAccountId,
      'Orçamentos na plataforma excedem o limite planejado do mês',
    );
  }

  return {
    campaignsSynced: synced.campaigns,
    adSetsSynced: synced.adSets,
    spendRowsRecorded: spendRows.length,
    spentCents,
    committedCents,
    killSwitchEngaged: applied.killSwitchEngaged || outOfBandChangeDetected,
    outOfBandChangeDetected,
    platformRemainingCents: platformLimit.remainingCents,
    platformIsBinding: limitResult?.platformIsBinding ?? false,
  };
}

/**
 * Dead-man switch. If an account has not reconciled within the window, stop
 * spending: a stale reconciliation means we do not know the true spend.
 */
export async function enforceReconciliationFreshness(
  db: Database,
  options: { maxAgeMinutes?: number; now?: Date } = {},
): Promise<{ accountId: string; ageMinutes: number }[]> {
  const maxAgeMinutes = options.maxAgeMinutes ?? 120;
  const now = options.now ?? new Date();
  const stale: { accountId: string; ageMinutes: number }[] = [];

  const accounts = await db.query.adAccounts.findMany();
  for (const account of accounts) {
    if (account.killSwitchEngaged) continue;

    const periodMonth = periodMonthOf(now, account.timezone);
    const period = await db.query.budgetPeriods.findFirst({
      where: and(
        eq(budgetPeriods.adAccountId, account.id),
        eq(budgetPeriods.periodMonth, periodMonth),
      ),
    });
    if (!period) continue;

    const last = period.lastReconciledAt ?? period.createdAt;
    const ageMinutes = Math.floor((now.getTime() - last.getTime()) / 60_000);
    if (ageMinutes <= maxAgeMinutes) continue;

    await db.insert(adGuardrailEvents).values({
      adAccountId: account.id,
      kind: 'reconciliation_stale',
      detail: { ageMinutes, maxAgeMinutes, lastReconciledAt: last.toISOString() },
    });
    await engageKillSwitch(
      db,
      account.id,
      `Reconciliação parada há ${ageMinutes} min: gasto real desconhecido`,
    );
    stale.push({ accountId: account.id, ageMinutes });
  }
  return stale;
}
