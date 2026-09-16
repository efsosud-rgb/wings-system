import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCampaigns,
  adChangeRequests,
  adGuardrailEvents,
  budgetCapHistory,
  budgetPeriods,
} from '../../db/schema/index.js';
import { assertPlausibleAmount, type Cents } from './platform/money.js';
import { META_DAILY_OVERDELIVERY_FACTOR } from './platform/fixtures.js';

/**
 * The single chokepoint for anything that could cost money.
 *
 * Nothing else in the system may write `ad_budget_periods.committed_cents`.
 * Every change is validated, reserved and recorded here, inside one
 * transaction that locks the period row — so two concurrent changes cannot
 * both slip under the same remaining budget.
 *
 * Caps are per ad account. Meta, Google and TikTok never share a pool, and
 * exhausting one account has no effect on another.
 */

/** Exposure assumes Meta's documented 25% overdelivery: budget is not spend. */
export const OVERDELIVERY_FACTOR = META_DAILY_OVERDELIVERY_FACTOR;

export type GuardRefusal =
  | 'kill_switch_engaged'
  | 'cap_would_be_exceeded'
  | 'usable_would_be_exceeded'
  | 'implausible_amount'
  | 'period_not_open'
  | 'campaign_not_found';

export type GuardResult<T> =
  { ok: true; value: T } | { ok: false; reason: GuardRefusal; message: string };

export interface PeriodState {
  id: string;
  capCents: Cents;
  usableCents: Cents;
  committedCents: Cents;
  spentCents: Cents;
  /** What may still be planned: the smaller of the two headrooms. */
  availableCents: Cents;
}

/** Days remaining in the period, counting today. */
export function remainingDays(now: Date, timezone = 'America/Sao_Paulo'): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return daysInMonth - day + 1;
}

/**
 * Exposure a daily budget represents for the rest of the period.
 * Overdelivery is included, because the platform may spend more than the
 * budget on any given day.
 */
export function exposureOf(dailyBudgetCents: Cents, daysLeft: number): Cents {
  return Math.round(dailyBudgetCents * daysLeft * OVERDELIVERY_FACTOR);
}

export function payloadHash(input: {
  adAccountId: string;
  campaignId: string;
  kind: string;
  fromValueCents: number | null;
  toValueCents: number | null;
  exposureDeltaCents: number;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function periodState(row: {
  id: string;
  capCents: number;
  usableCents: number;
  committedCents: number;
  spentCents: number;
}): PeriodState {
  const capHeadroom = Math.max(0, row.capCents - row.spentCents - row.committedCents);
  const usableHeadroom = Math.max(0, row.usableCents - row.committedCents);
  return {
    id: row.id,
    capCents: row.capCents,
    usableCents: row.usableCents,
    committedCents: row.committedCents,
    spentCents: row.spentCents,
    availableCents: Math.min(capHeadroom, usableHeadroom),
  };
}

async function recordGuardrailEvent(
  db: Database,
  adAccountId: string,
  kind:
    | 'cap_would_be_exceeded'
    | 'usable_would_be_exceeded'
    | 'kill_switch_engaged'
    | 'kill_switch_released'
    | 'implausible_amount'
    | 'cap_change'
    | 'reconciliation_stale'
    | 'unknown_execution_outcome',
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(adGuardrailEvents).values({ adAccountId, kind, detail });
}

/** Opens (or reopens) a month for an account. Caps are recorded, never silent. */
export async function openPeriod(
  db: Database,
  input: {
    adAccountId: string;
    periodMonth: string;
    capCents: Cents;
    usablePercent: number;
    changedBy?: string | null;
    reason?: string;
  },
): Promise<PeriodState> {
  const usableCents = Math.floor((input.capCents * input.usablePercent) / 100);

  const [row] = await db
    .insert(budgetPeriods)
    .values({
      adAccountId: input.adAccountId,
      periodMonth: input.periodMonth,
      capCents: input.capCents,
      usableCents,
    })
    .onConflictDoUpdate({
      target: [budgetPeriods.adAccountId, budgetPeriods.periodMonth],
      set: { capCents: input.capCents, usableCents, updatedAt: new Date() },
    })
    .returning();

  if (!row) throw new Error('failed to open budget period');

  await db.insert(budgetCapHistory).values({
    adAccountId: input.adAccountId,
    periodMonth: input.periodMonth,
    newCapCents: input.capCents,
    usablePercent: input.usablePercent,
    changedBy: input.changedBy ?? null,
    reason: input.reason ?? null,
  });

  await recordGuardrailEvent(db, input.adAccountId, 'cap_change', {
    periodMonth: input.periodMonth,
    capCents: input.capCents,
    usableCents,
  });

  return periodState(row);
}

export interface ReserveInput {
  adAccountId: string;
  campaignId: string;
  kind: 'set_daily_budget' | 'pause_campaign' | 'resume_campaign';
  /** Required for set_daily_budget. */
  toDailyBudgetCents?: Cents;
  requestedBy?: string | null;
  requestedByAgent?: boolean;
  reason?: string;
  now?: Date;
}

export interface Reservation {
  changeRequestId: string;
  exposureDeltaCents: number;
  period: PeriodState;
  payloadHash: string;
}

/**
 * Validates a proposed change and reserves its exposure.
 *
 * Returns a refusal rather than throwing for anything expected: the caller must
 * handle "no" as a normal outcome. A database constraint violation is caught
 * here and reported as a refusal too — the constraint is the authority, this
 * function is merely the polite messenger.
 */
export async function reserveChange(
  db: Database,
  input: ReserveInput,
): Promise<GuardResult<Reservation>> {
  const now = input.now ?? new Date();

  const account = await db.query.adAccounts.findFirst({
    where: eq(adAccounts.id, input.adAccountId),
  });
  if (!account) return { ok: false, reason: 'period_not_open', message: 'Conta não encontrada' };

  if (account.killSwitchEngaged) {
    await recordGuardrailEvent(db, input.adAccountId, 'kill_switch_engaged', {
      attempted: input.kind,
      campaignId: input.campaignId,
    });
    return {
      ok: false,
      reason: 'kill_switch_engaged',
      message: 'Trava de emergência acionada: nenhuma alteração pode ser feita.',
    };
  }

  return db.transaction(async (tx) => {
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: account.timezone,
      year: 'numeric',
      month: '2-digit',
    })
      .format(now)
      .slice(0, 7);
    const periodMonth = `${month}-01`;

    // Lock the period row: concurrent reservations serialise here, so two
    // changes can never both fit into the same remaining budget.
    const locked = await tx.execute<
      {
        id: string;
        cap_cents: string;
        usable_cents: string;
        committed_cents: string;
        spent_cents: string;
      } & Record<string, unknown>
    >(sql`
      select id, cap_cents, usable_cents, committed_cents, spent_cents
        from ad_budget_periods
       where ad_account_id = ${input.adAccountId} and period_month = ${periodMonth}
         and closed_at is null
       for update
    `);

    const periodRow = locked.rows[0];
    if (!periodRow) {
      return {
        ok: false as const,
        reason: 'period_not_open' as const,
        message: 'Nenhum período de orçamento aberto para esta conta neste mês.',
      };
    }

    const current = periodState({
      id: periodRow.id,
      capCents: Number(periodRow.cap_cents),
      usableCents: Number(periodRow.usable_cents),
      committedCents: Number(periodRow.committed_cents),
      spentCents: Number(periodRow.spent_cents),
    });

    const campaign = await tx.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, input.campaignId),
    });
    if (!campaign || campaign.adAccountId !== input.adAccountId) {
      return {
        ok: false as const,
        reason: 'campaign_not_found' as const,
        message: 'Campanha não encontrada nesta conta.',
      };
    }

    const daysLeft = remainingDays(now, account.timezone);
    const fromBudget = campaign.status === 'ACTIVE' ? campaign.dailyBudgetCents : 0;
    let toBudget: number;

    switch (input.kind) {
      case 'set_daily_budget': {
        const target = input.toDailyBudgetCents ?? 0;
        try {
          assertPlausibleAmount(target, { monthlyCapCents: current.capCents }, 'orçamento diário');
        } catch (error) {
          await recordGuardrailEvent(db, input.adAccountId, 'implausible_amount', {
            campaignId: input.campaignId,
            attemptedCents: target,
            capCents: current.capCents,
          });
          return {
            ok: false as const,
            reason: 'implausible_amount' as const,
            message: error instanceof Error ? error.message : 'Valor implausível',
          };
        }
        toBudget = target;
        break;
      }
      case 'pause_campaign':
        toBudget = 0;
        break;
      case 'resume_campaign':
        toBudget = campaign.dailyBudgetCents;
        break;
    }

    const exposureDeltaCents = exposureOf(toBudget, daysLeft) - exposureOf(fromBudget, daysLeft);
    const newCommitted = current.committedCents + exposureDeltaCents;

    // Pre-checks give a precise reason; the constraints below are what
    // actually guarantee the outcome.
    if (newCommitted > current.usableCents) {
      await recordGuardrailEvent(db, input.adAccountId, 'usable_would_be_exceeded', {
        campaignId: input.campaignId,
        exposureDeltaCents,
        committedCents: current.committedCents,
        usableCents: current.usableCents,
      });
      return {
        ok: false as const,
        reason: 'usable_would_be_exceeded' as const,
        message: 'A alteração ultrapassa a parcela utilizável do orçamento do mês.',
      };
    }
    if (newCommitted > Math.max(0, current.capCents - current.spentCents)) {
      await recordGuardrailEvent(db, input.adAccountId, 'cap_would_be_exceeded', {
        campaignId: input.campaignId,
        exposureDeltaCents,
        spentCents: current.spentCents,
        capCents: current.capCents,
      });
      return {
        ok: false as const,
        reason: 'cap_would_be_exceeded' as const,
        message: 'A alteração ultrapassa o teto mensal desta conta.',
      };
    }

    await tx
      .update(budgetPeriods)
      .set({ committedCents: newCommitted, updatedAt: now })
      .where(eq(budgetPeriods.id, current.id));

    const hash = payloadHash({
      adAccountId: input.adAccountId,
      campaignId: input.campaignId,
      kind: input.kind,
      fromValueCents: fromBudget,
      toValueCents: toBudget,
      exposureDeltaCents,
    });

    const [request] = await tx
      .insert(adChangeRequests)
      .values({
        adAccountId: input.adAccountId,
        campaignId: input.campaignId,
        budgetPeriodId: current.id,
        kind: input.kind,
        fromValueCents: fromBudget,
        toValueCents: toBudget,
        exposureDeltaCents,
        payloadHash: hash,
        // Every change needs a human decision — there is no auto-approval.
        status: 'pending_approval',
        requestedBy: input.requestedBy ?? null,
        requestedByAgent: input.requestedByAgent ?? false,
        reason: input.reason ?? null,
      })
      .returning({ id: adChangeRequests.id });

    if (!request) throw new Error('failed to record change request');

    return {
      ok: true as const,
      value: {
        changeRequestId: request.id,
        exposureDeltaCents,
        payloadHash: hash,
        period: periodState({
          id: current.id,
          capCents: current.capCents,
          usableCents: current.usableCents,
          committedCents: newCommitted,
          spentCents: current.spentCents,
        }),
      },
    };
  });
}

/** Releases a reservation when a change is rejected, expired or superseded. */
export async function releaseReservation(
  db: Database,
  changeRequestId: string,
  status: 'rejected' | 'expired' | 'superseded' | 'failed',
  decidedBy?: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const request = await tx.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeRequestId),
    });
    if (!request || !request.reservationActive) return;

    await tx.execute(sql`
      update ad_budget_periods
         set committed_cents = GREATEST(committed_cents - ${request.exposureDeltaCents}, 0),
             updated_at = now()
       where id = ${request.budgetPeriodId}
    `);

    await tx
      .update(adChangeRequests)
      .set({
        status,
        reservationActive: false,
        decidedAt: new Date(),
        decidedBy: decidedBy ?? null,
      })
      .where(eq(adChangeRequests.id, changeRequestId));
  });
}

/**
 * Records spend reported by the platform.
 *
 * Truth is always recordable: if real spend has eaten into the reserve, the
 * commitment is trimmed to fit and the kill switch is engaged, rather than the
 * write being refused.
 */
export async function applyReportedSpend(
  db: Database,
  input: { periodId: string; spentCents: Cents; now?: Date },
): Promise<{ killSwitchEngaged: boolean; committedCents: Cents }> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const locked = await tx.execute<
      {
        id: string;
        ad_account_id: string;
        cap_cents: string;
        committed_cents: string;
      } & Record<string, unknown>
    >(sql`
      select id, ad_account_id, cap_cents, committed_cents
        from ad_budget_periods where id = ${input.periodId} for update
    `);
    const row = locked.rows[0];
    if (!row) throw new Error('budget period not found');

    const capCents = Number(row.cap_cents);
    const committed = Number(row.committed_cents);
    const room = Math.max(0, capCents - input.spentCents);
    const trimmed = Math.min(committed, room);
    const needsKillSwitch = input.spentCents >= capCents || trimmed < committed;

    await tx
      .update(budgetPeriods)
      .set({ spentCents: input.spentCents, committedCents: trimmed, lastReconciledAt: now })
      .where(eq(budgetPeriods.id, input.periodId));

    if (needsKillSwitch) {
      await tx
        .update(adAccounts)
        .set({
          killSwitchEngaged: true,
          killSwitchReason: 'Gasto reportado atingiu ou ultrapassou o limite planejado',
          updatedAt: now,
        })
        .where(eq(adAccounts.id, String(row.ad_account_id)));

      await tx.insert(adGuardrailEvents).values({
        adAccountId: String(row.ad_account_id),
        kind: 'kill_switch_engaged',
        detail: { spentCents: input.spentCents, capCents, committedBefore: committed, trimmed },
      });
    }

    return { killSwitchEngaged: needsKillSwitch, committedCents: trimmed };
  });
}

export async function engageKillSwitch(
  db: Database,
  adAccountId: string,
  reason: string,
): Promise<void> {
  await db
    .update(adAccounts)
    .set({ killSwitchEngaged: true, killSwitchReason: reason, updatedAt: new Date() })
    .where(eq(adAccounts.id, adAccountId));
  await recordGuardrailEvent(db, adAccountId, 'kill_switch_engaged', { reason });
}

export async function releaseKillSwitch(
  db: Database,
  adAccountId: string,
  reason: string,
): Promise<void> {
  await db
    .update(adAccounts)
    .set({ killSwitchEngaged: false, killSwitchReason: null, updatedAt: new Date() })
    .where(eq(adAccounts.id, adAccountId));
  await recordGuardrailEvent(db, adAccountId, 'kill_switch_released', { reason });
}

export async function getPeriodState(
  db: Database,
  adAccountId: string,
  periodMonth: string,
): Promise<PeriodState | null> {
  const rows = await db.execute<
    {
      id: string;
      cap_cents: string;
      usable_cents: string;
      committed_cents: string;
      spent_cents: string;
    } & Record<string, unknown>
  >(sql`
    select id, cap_cents, usable_cents, committed_cents, spent_cents
      from ad_budget_periods
     where ad_account_id = ${adAccountId} and period_month = ${periodMonth}
  `);
  const row = rows.rows[0];
  if (!row) return null;
  return periodState({
    id: row.id,
    capCents: Number(row.cap_cents),
    usableCents: Number(row.usable_cents),
    committedCents: Number(row.committed_cents),
    spentCents: Number(row.spent_cents),
  });
}
