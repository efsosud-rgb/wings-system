import { periodOverdeliveryFactor } from '@wings/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
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
import {
  effectiveHeadroomCents,
  limitFrom,
  prepaidLimitFrom,
  type PlatformSpendLimit,
} from './platform/limits.js';
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

/**
 * Refuses to mirror one account's data into another's row.
 *
 * A platform client is bound to a single ad account, but nothing in the type
 * system stopped a caller looping over accounts while reusing one client. The
 * result was silent and expensive: 84 campaigns from the live account were
 * filed under an account that had never run anything, along with its spend.
 * Loud failure is the only acceptable behaviour here.
 */
export function assertClientServesAccount(
  client: AdsPlatformClient,
  accountExternalId: string,
): void {
  // Only live clients can do real damage, and only they are bound to a real
  // account. A test double's binding is the test's own business.
  if (!client.isLive) return;

  if (client.accountExternalId !== accountExternalId) {
    throw new Error(
      `client is bound to ${client.accountExternalId} but was asked to mirror ` +
        `${accountExternalId} — refusing to file one account's data under another`,
    );
  }
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
        objective: campaign.objective ?? null,
        startDate: campaign.startDate ?? null,
        endDate: campaign.endDate ?? null,
        deliveryStatus: campaign.deliveryStatus ?? null,
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
          // A client that does not report the objective never erases a known one.
          ...(campaign.objective ? { objective: campaign.objective } : {}),
          // Same for the schedule: undefined means "not read", null means "no end".
          ...(campaign.startDate !== undefined ? { startDate: campaign.startDate } : {}),
          ...(campaign.endDate !== undefined ? { endDate: campaign.endDate } : {}),
          ...(campaign.deliveryStatus !== undefined
            ? { deliveryStatus: campaign.deliveryStatus }
            : {}),
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
 * What the platform itself allows, read from its own API rather than assumed,
 * and written down with the figures behind it. Meta reports spend_cap and
 * amount_spent on the account; a prepaid Google account reports the same
 * shape through its account budget. On a prepaid account (Google always,
 * Meta sometimes) the balance itself IS the headroom — spend_cap minus
 * amount_spent is a proxy that agrees with it only when the cap was never
 * touched mid-month.
 */
async function readAndApplyPlatformLimit(
  db: Database,
  client: AdsPlatformClient,
  adAccountId: string,
  periodMonth: string,
  now: Date,
) {
  const platformAccount = await client.getAccount();
  const platformLimit =
    platformAccount.fundingKind === 'prepaid'
      ? prepaidLimitFrom(
          platformAccount.prepaidBalanceCents ?? null,
          platformAccount.amountSpentCents,
          client.spendLimitSource ?? `${client.platform}.prepaid_balance`,
        )
      : limitFrom(
          platformAccount.spendCapCents,
          platformAccount.amountSpentCents,
          client.spendLimitSource ?? `${client.platform}.spend_cap`,
        );
  // The human reason a field came back empty, when the platform gave one —
  // the "motivo" the cockpit shows next to a figure it cannot compute.
  const platformLimitNote = platformAccount.warnings?.[0] ?? null;
  const limitResult = await applyPlatformLimit(db, {
    adAccountId,
    periodMonth,
    limit: platformLimit,
    note: platformLimitNote,
    figures: {
      spendCapCents: platformAccount.spendCapCents,
      amountSpentCents: platformAccount.amountSpentCents,
      amountDueCents: platformAccount.amountDueCents ?? null,
      prepaidBalanceCents: platformAccount.prepaidBalanceCents ?? null,
      fundingKind: platformAccount.fundingKind ?? null,
    },
    now,
  });
  return { platformLimit, limitResult };
}

/**
 * The platform's account figures alone — one read, no campaigns, no spend,
 * and never `committed_cents` (which only `reconcileAccount` and
 * `reserveChange` own). What the campaign builder asks for when it opens, so
 * the balance on screen is minutes old rather than up to a cycle old. It does
 * not move `last_reconciled_at`: the dead-man switch still answers only to a
 * full reconciliation.
 */
export async function refreshPlatformLimit(
  db: Database,
  client: AdsPlatformClient,
  adAccountId: string,
  now = new Date(),
): Promise<void> {
  const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, adAccountId) });
  if (!account) throw new Error('ad account not found');
  assertClientServesAccount(client, account.externalId);
  const periodMonth = periodMonthOf(now, account.timezone);
  const period = await db.query.budgetPeriods.findFirst({
    where: and(
      eq(budgetPeriods.adAccountId, adAccountId),
      eq(budgetPeriods.periodMonth, periodMonth),
    ),
  });
  if (!period) throw new Error(`no budget period open for ${periodMonth}`);
  try {
    await readAndApplyPlatformLimit(db, client, adAccountId, periodMonth, now);
  } catch (error) {
    await recordPlatformReadFailure(db, { periodId: period.id, error, now });
    throw error;
  }
}

/** Ids and codes only — platform and database errors carry no personal data. */
function describeReadError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const suffix = typeof code === 'number' || typeof code === 'string' ? ` (#${code})` : '';
  return `${text.slice(0, 280)}${suffix}`;
}

async function recordPlatformReadFailure(
  db: Database,
  input: { periodId: string; error: unknown; now: Date },
): Promise<void> {
  await db
    .update(budgetPeriods)
    .set({
      platformReadAttemptedAt: input.now,
      platformReadError: describeReadError(input.error),
      updatedAt: input.now,
    })
    .where(eq(budgetPeriods.id, input.periodId));
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
  assertClientServesAccount(client, account.externalId);

  const periodMonth = periodMonthOf(now, account.timezone);
  const period = await db.query.budgetPeriods.findFirst({
    where: and(
      eq(budgetPeriods.adAccountId, adAccountId),
      eq(budgetPeriods.periodMonth, periodMonth),
    ),
  });
  if (!period) throw new Error(`no budget period open for ${periodMonth}`);

  // A failure here, before the platform's own figures are in, is recorded on
  // the period: the screens then show "—" and the reason instead of the last
  // number as if it were current.
  let synced: { campaigns: number; adSets: number };
  let platformLimit: PlatformSpendLimit;
  let limitResult: Awaited<ReturnType<typeof applyPlatformLimit>>;
  try {
    synced = await syncCampaigns(db, client, adAccountId, now);
    ({ platformLimit, limitResult } = await readAndApplyPlatformLimit(
      db,
      client,
      adAccountId,
      periodMonth,
      now,
    ));
  } catch (error) {
    await recordPlatformReadFailure(db, { periodId: period.id, error, now });
    throw error;
  }

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
        // The period factor: on Google the rest of the month costs the budget
        // itself (1.0x); its 2.0x is a promise about a single day.
        periodOverdeliveryFactor(account.platform),
      ),
    0,
  );

  const internalAllowed = Math.min(period.usableCents, Math.max(0, period.capCents - spentCents));
  // Three ceilings, smallest wins: usable slice, hard cap, and what the
  // platform will actually let us spend.
  //
  // Except on a prepaid account (Google): there the platform's number is a
  // balance that drains and is topped up by Pix, so running below the month's
  // exposure is its normal state, not a sign that somebody raised budgets
  // behind our back. It still binds every new request (`ceilingRefusal`) and is
  // still recorded (`applyPlatformLimit`); it just does not freeze the account.
  const allowed =
    account.platform === 'google'
      ? internalAllowed
      : effectiveHeadroomCents(internalAllowed, platformLimit.remainingCents);
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

/** How old a reconciliation may be before the true spend counts as unknown. */
export const RECONCILIATION_MAX_AGE_MINUTES = 120;

export type ReconciliationFreshness =
  | { fresh: true; ageMinutes: number }
  | { fresh: false; ageMinutes: number | null; reason: 'never_reconciled' | 'stale' };

/**
 * Whether an account's spend is known recently enough to act on.
 *
 * The dead-man switch as seen from the write path. It reads state and changes
 * none, so the executor can ask before every write even when the scheduled job
 * that would normally notice staleness is itself the thing that died.
 *
 * A period that was opened but never reconciled counts as unknown, not as
 * fresh: `createdAt` says when we started caring, not what has been spent.
 */
export async function reconciliationFreshness(
  db: Database,
  adAccountId: string,
  options: { maxAgeMinutes?: number; now?: Date } = {},
): Promise<ReconciliationFreshness> {
  const maxAgeMinutes = options.maxAgeMinutes ?? RECONCILIATION_MAX_AGE_MINUTES;
  const now = options.now ?? new Date();

  const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, adAccountId) });
  if (!account) return { fresh: false, ageMinutes: null, reason: 'never_reconciled' };

  const period = await db.query.budgetPeriods.findFirst({
    where: and(
      eq(budgetPeriods.adAccountId, adAccountId),
      eq(budgetPeriods.periodMonth, periodMonthOf(now, account.timezone)),
    ),
  });
  if (!period?.lastReconciledAt) {
    return { fresh: false, ageMinutes: null, reason: 'never_reconciled' };
  }

  const ageMinutes = Math.floor((now.getTime() - period.lastReconciledAt.getTime()) / 60_000);
  return ageMinutes <= maxAgeMinutes
    ? { fresh: true, ageMinutes }
    : { fresh: false, ageMinutes, reason: 'stale' };
}

/**
 * Dead-man switch. If an account has not reconciled within the window, freeze
 * it: a stale reconciliation means we do not know the true spend.
 *
 * "Freeze" means this system will make no further change to the account. It
 * does not pause anything on the platform — campaigns already running keep
 * running, and the platform's own spend cap remains the outer wall.
 *
 * Archived accounts are left alone: they never reconcile, by design.
 */
export async function enforceReconciliationFreshness(
  db: Database,
  options: { maxAgeMinutes?: number; now?: Date } = {},
): Promise<{ accountId: string; ageMinutes: number }[]> {
  const maxAgeMinutes = options.maxAgeMinutes ?? RECONCILIATION_MAX_AGE_MINUTES;
  const now = options.now ?? new Date();
  const stale: { accountId: string; ageMinutes: number }[] = [];

  const accounts = await db.query.adAccounts.findMany({ where: isNull(adAccounts.archivedAt) });
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
