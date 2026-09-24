import { createHash } from 'node:crypto';
import {
  AD_ACCOUNT_PLATFORM,
  campaignDaysInMonth,
  estimateCostCents,
  periodOverdeliveryFactor,
  type CampaignDraft,
} from '@wings/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCampaignDrafts,
  adCampaigns,
  adChangeRequests,
  adGuardrailEvents,
  adSets,
  budgetCapHistory,
  budgetPeriods,
} from '../../db/schema/index.js';
import { effectiveHeadroomCents, type PlatformSpendLimit } from './platform/limits.js';
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
  | 'platform_limit_would_be_exceeded'
  | 'budget_not_at_campaign_level'
  | 'kill_switch_engaged'
  | 'cap_would_be_exceeded'
  | 'usable_would_be_exceeded'
  | 'implausible_amount'
  | 'period_not_open'
  | 'campaign_not_found'
  | 'start_in_past'
  | 'duplicate_name'
  | 'platform_mismatch'
  | 'not_supported_on_platform';

export type GuardResult<T> =
  { ok: true; value: T } | { ok: false; reason: GuardRefusal; message: string };

export interface PeriodState {
  id: string;
  capCents: Cents;
  usableCents: Cents;
  committedCents: Cents;
  spentCents: Cents;
  /**
   * What the platform itself still allows, as last read from its API. Null
   * when never synced or when the platform sets no limit.
   */
  platformRemainingCents: Cents | null;
  platformLimitSource: string | null;
  /** When the platform limit was last synced by reconciliation; null when never. */
  platformLimitSyncedAt: Date | null;
  /** Why the platform would not answer, in the API's own words; null when it did. */
  platformLimitNote: string | null;
  /** What may still be planned: the smallest of the headrooms, platform included. */
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
 * budget on any given day. `factor` is the platform's PERIOD factor: Google's
 * 2x is a promise about one day, and over the days that remain it charges no
 * more than the budget itself (`periodOverdeliveryFactor`).
 */
export function exposureOf(
  dailyBudgetCents: Cents,
  daysLeft: number,
  factor: number = OVERDELIVERY_FACTOR,
): Cents {
  return Math.round(dailyBudgetCents * daysLeft * factor);
}

export interface ExposureInput {
  campaignStatus: string;
  campaignDailyBudgetCents: number;
  adSets: { status: string; dailyBudgetCents: number; lifetimeBudgetCents?: number | null }[];
}

/**
 * Exposure of one campaign for the rest of the period.
 *
 * Meta accounts mix two budget models, and the money follows whichever one the
 * campaign uses:
 *   - CBO: the campaign carries the budget;
 *   - ABO: the campaign carries none and its ad sets do.
 *
 * An ad set only delivers while its campaign is active, so a paused campaign
 * contributes nothing no matter how many active ad sets sit beneath it. Reading
 * only the campaign budget — as the first version did — would report an ABO
 * campaign as free while it spent real money.
 */
export function campaignExposure(
  input: ExposureInput,
  daysLeft: number,
  factor: number = OVERDELIVERY_FACTOR,
): Cents {
  if (input.campaignStatus !== 'ACTIVE') return 0;

  if (input.campaignDailyBudgetCents > 0) {
    return exposureOf(input.campaignDailyBudgetCents, daysLeft, factor);
  }

  return input.adSets
    .filter((adSet) => adSet.status === 'ACTIVE')
    .reduce((total, adSet) => {
      if (adSet.dailyBudgetCents > 0) {
        return total + exposureOf(adSet.dailyBudgetCents, daysLeft, factor);
      }
      // A lifetime budget is counted in full: the worst case is that all of it
      // is spent before the period ends.
      return total + (adSet.lifetimeBudgetCents ?? 0);
    }, 0);
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
  platformRemainingCents?: number | null;
  platformLimitSource?: string | null;
  platformLimitSyncedAt?: Date | null;
  platformLimitNote?: string | null;
}): PeriodState {
  const capHeadroom = Math.max(0, row.capCents - row.spentCents - row.committedCents);
  const usableHeadroom = Math.max(0, row.usableCents - row.committedCents);
  const platformRemainingCents = row.platformRemainingCents ?? null;

  // Three ceilings now: our cap, our usable slice, and what the platform will
  // actually allow. The smallest wins — a cap above the platform's own limit
  // is a number with no power behind it.
  const internalHeadroom = Math.min(capHeadroom, usableHeadroom);

  // The platform's remaining allowance is a TOTAL for what is still to be
  // spent, and exposure already committed will eat into it. So the headroom
  // for new plans is what is left after the existing commitment, not the raw
  // figure — otherwise a balance of R$20 would look plannable while R$325 of
  // exposure was already queued against it.
  const platformHeadroom =
    platformRemainingCents === null ? null : platformRemainingCents - row.committedCents;

  return {
    id: row.id,
    capCents: row.capCents,
    usableCents: row.usableCents,
    committedCents: row.committedCents,
    spentCents: row.spentCents,
    platformRemainingCents,
    platformLimitSource: row.platformLimitSource ?? null,
    platformLimitSyncedAt: row.platformLimitSyncedAt ?? null,
    platformLimitNote: row.platformLimitNote ?? null,
    availableCents: effectiveHeadroomCents(internalHeadroom, platformHeadroom),
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

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** First day of the month `now` falls in, in the account's timezone. */
function periodMonthOf(now: Date, timezone: string): string {
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
 * Locks the open period row. Concurrent reservations serialise here, so two
 * changes can never both fit into the same remaining budget.
 */
async function lockOpenPeriod(
  tx: Transaction,
  adAccountId: string,
  periodMonth: string,
): Promise<PeriodState | null> {
  const locked = await tx.execute<
    {
      id: string;
      cap_cents: string;
      usable_cents: string;
      committed_cents: string;
      spent_cents: string;
      platform_remaining_cents: string | null;
      platform_limit_source: string | null;
    } & Record<string, unknown>
  >(sql`
    select id, cap_cents, usable_cents, committed_cents, spent_cents,
           platform_remaining_cents, platform_limit_source
      from ad_budget_periods
     where ad_account_id = ${adAccountId} and period_month = ${periodMonth}
       and closed_at is null
     for update
  `);

  const row = locked.rows[0];
  if (!row) return null;
  return periodState({
    id: row.id,
    capCents: Number(row.cap_cents),
    usableCents: Number(row.usable_cents),
    committedCents: Number(row.committed_cents),
    spentCents: Number(row.spent_cents),
    platformRemainingCents:
      row.platform_remaining_cents === null ? null : Number(row.platform_remaining_cents),
    platformLimitSource: row.platform_limit_source,
  });
}

/**
 * The three ceilings every new commitment is judged against — our usable
 * slice, what the platform itself still allows, and the monthly cap — in one
 * place, so a change to an existing campaign and the creation of a new one can
 * never be held to different rules. Returns null when the commitment fits.
 */
async function ceilingRefusal(
  db: Database,
  adAccountId: string,
  current: PeriodState,
  exposureDeltaCents: number,
  subject: Record<string, unknown>,
): Promise<{ ok: false; reason: GuardRefusal; message: string } | null> {
  const newCommitted = Math.max(0, current.committedCents + exposureDeltaCents);

  if (newCommitted > current.usableCents) {
    await recordGuardrailEvent(db, adAccountId, 'usable_would_be_exceeded', {
      ...subject,
      exposureDeltaCents,
      committedCents: current.committedCents,
      usableCents: current.usableCents,
    });
    return {
      ok: false,
      reason: 'usable_would_be_exceeded',
      message: 'A alteração ultrapassa a parcela utilizável do orçamento do mês.',
    };
  }
  // The platform's own ceiling. Checked here rather than by a database
  // constraint because this number moves on its own: Meta raises a cap,
  // Google's prepaid balance drains. A CHECK would refuse to record a limit
  // that had already dropped below what is committed, which is exactly when
  // knowing about it matters most.
  if (
    current.platformRemainingCents !== null &&
    exposureDeltaCents > 0 &&
    newCommitted > current.platformRemainingCents
  ) {
    await recordGuardrailEvent(db, adAccountId, 'usable_would_be_exceeded', {
      ...subject,
      exposureDeltaCents,
      newCommittedCents: newCommitted,
      platformRemainingCents: current.platformRemainingCents,
      platformLimitSource: current.platformLimitSource,
      note: 'bloqueado pelo limite da própria plataforma, não pelo teto interno',
    });
    return {
      ok: false,
      reason: 'platform_limit_would_be_exceeded',
      message:
        `A alteração ultrapassa o que a própria plataforma ainda permite gastar ` +
        `(${current.platformRemainingCents} centavos restantes, fonte ${current.platformLimitSource ?? 'desconhecida'}).`,
    };
  }

  if (newCommitted > Math.max(0, current.capCents - current.spentCents)) {
    await recordGuardrailEvent(db, adAccountId, 'cap_would_be_exceeded', {
      ...subject,
      exposureDeltaCents,
      spentCents: current.spentCents,
      capCents: current.capCents,
    });
    return {
      ok: false,
      reason: 'cap_would_be_exceeded',
      message: 'A alteração ultrapassa o teto mensal desta conta.',
    };
  }
  return null;
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
  /**
   * The person asked from a card the traffic agent proposed. It marks the
   * request and changes nothing else: same guard, same gate, same approver.
   */
  suggestedByAgent?: boolean;
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

  // On Google this system creates campaigns and nothing else: there is no
  // request to make about one that already exists.
  if (account.platform !== 'meta') {
    return {
      ok: false,
      reason: 'not_supported_on_platform',
      message:
        'Nesta plataforma o sistema só cria campanhas novas; as existentes não são alteradas.',
    };
  }

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
    const periodMonth = periodMonthOf(now, account.timezone);
    const current = await lockOpenPeriod(tx, input.adAccountId, periodMonth);
    if (!current) {
      return {
        ok: false as const,
        reason: 'period_not_open' as const,
        message: 'Nenhum período de orçamento aberto para esta conta neste mês.',
      };
    }

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
    const campaignAdSets = await tx.query.adSets.findMany({
      where: eq(adSets.campaignId, campaign.id),
    });

    const currentExposure = campaignExposure(
      {
        campaignStatus: campaign.status,
        campaignDailyBudgetCents: campaign.dailyBudgetCents,
        adSets: campaignAdSets,
      },
      daysLeft,
    );

    // ABO campaigns hold no budget of their own, so a campaign-level change
    // would silently do nothing on the platform. Refuse it plainly until
    // ad-set targeting exists.
    if (input.kind === 'set_daily_budget' && campaign.budgetLevel === 'ad_set') {
      await recordGuardrailEvent(db, input.adAccountId, 'implausible_amount', {
        campaignId: input.campaignId,
        note: 'campanha ABO: o orçamento fica no conjunto de anúncios',
      });
      return {
        ok: false as const,
        reason: 'budget_not_at_campaign_level' as const,
        message:
          'Esta campanha usa orçamento por conjunto de anúncios (ABO). Alterar o orçamento da campanha não teria efeito.',
      };
    }

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

    // The "after" exposure: a pause zeroes the campaign, including its ad sets.
    const nextExposure =
      input.kind === 'pause_campaign'
        ? 0
        : campaignExposure(
            {
              campaignStatus: 'ACTIVE',
              campaignDailyBudgetCents: toBudget,
              adSets: campaignAdSets,
            },
            daysLeft,
          );
    const exposureDeltaCents = nextExposure - currentExposure;
    // Floored at zero, as releaseReservation already does. A pause hands back
    // the campaign's whole exposure, but the period may never have counted it:
    // a campaign created since the last reconciliation, or a commitment that
    // reconciliation clipped to the allowance. Without the floor, the request
    // to *reduce* spend died on the non-negative constraint. The next
    // reconciliation re-derives the true figure from the platform either way.
    const newCommitted = Math.max(0, current.committedCents + exposureDeltaCents);

    // Pre-checks give a precise reason; the database constraints are what
    // actually guarantee the outcome.
    const refusal = await ceilingRefusal(db, input.adAccountId, current, exposureDeltaCents, {
      campaignId: input.campaignId,
    });
    if (refusal) return refusal;

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
        suggestedByAgent: input.suggestedByAgent ?? false,
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

/** JSON with keys sorted at every level: jsonb does not keep insertion order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash an approval of a `create_campaign` is bound to. It covers the whole
 * draft, so what gets created is exactly what the approver was shown.
 */
export function draftPayloadHash(input: {
  adAccountId: string;
  payload: unknown;
  exposureDeltaCents: number;
}): string {
  return createHash('sha256')
    .update(canonicalJson({ kind: 'create_campaign', ...input }))
    .digest('hex');
}

/**
 * Exposure a campaign adds to the current month when it is created.
 *
 * Born paused it adds nothing, by the same rule as every other paused
 * campaign; resuming it later is its own request and reserves then. Born
 * active it counts from its start (or today) to its end or the month's,
 * whichever comes first — later months are judged when their period opens.
 */
export function creationExposure(
  draft: Pick<CampaignDraft, 'startPaused' | 'dailyBudgetCents' | 'startDate' | 'endDate'>,
  today: string,
  factor: number = OVERDELIVERY_FACTOR,
): Cents {
  if (draft.startPaused) return 0;
  const from = draft.startDate > today ? draft.startDate : today;
  return exposureOf(
    draft.dailyBudgetCents,
    campaignDaysInMonth(from, draft.endDate, today),
    factor,
  );
}

export interface CreationReservation extends Reservation {
  draftId: string;
}

/**
 * Validates a campaign somebody wants created and reserves its exposure.
 *
 * The counterpart of `reserveChange` for a campaign that does not exist yet:
 * same kill switch, same locked period, same three ceilings. It stores the
 * draft and the change request together, so there is never a draft nobody
 * asked for or a request with nothing behind it.
 */
export async function reserveCampaignCreation(
  db: Database,
  input: {
    adAccountId: string;
    draft: CampaignDraft;
    requestedBy?: string | null;
    reason?: string;
    now?: Date;
  },
): Promise<GuardResult<CreationReservation>> {
  const now = input.now ?? new Date();
  const { draft } = input;

  const account = await db.query.adAccounts.findFirst({
    where: eq(adAccounts.id, input.adAccountId),
  });
  if (!account) return { ok: false, reason: 'period_not_open', message: 'Conta não encontrada' };

  if (AD_ACCOUNT_PLATFORM[draft.platform] !== account.platform) {
    return {
      ok: false,
      reason: 'platform_mismatch',
      message: 'A plataforma do rascunho não é a desta conta de anúncios.',
    };
  }

  if (account.killSwitchEngaged) {
    await recordGuardrailEvent(db, input.adAccountId, 'kill_switch_engaged', {
      attempted: 'create_campaign',
    });
    return {
      ok: false,
      reason: 'kill_switch_engaged',
      message: 'Trava de emergência acionada: nenhuma alteração pode ser feita.',
    };
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: account.timezone }).format(now);
  if (draft.startDate < today) {
    return { ok: false, reason: 'start_in_past', message: 'O início da campanha já passou.' };
  }

  return db.transaction(async (tx) => {
    const current = await lockOpenPeriod(
      tx,
      input.adAccountId,
      periodMonthOf(now, account.timezone),
    );
    if (!current) {
      return {
        ok: false as const,
        reason: 'period_not_open' as const,
        message: 'Nenhum período de orçamento aberto para esta conta neste mês.',
      };
    }

    // A name is how a person — and resolve-unknown — finds this campaign on
    // the platform, which hands back no id when a create times out. Checked
    // under the period lock, so two identical requests cannot both pass.
    const sameNameOnPlatform = await tx.query.adCampaigns.findFirst({
      where: and(eq(adCampaigns.adAccountId, input.adAccountId), eq(adCampaigns.name, draft.name)),
    });
    const sameNameRequested = await tx
      .select({ id: adChangeRequests.id })
      .from(adChangeRequests)
      .innerJoin(adCampaignDrafts, eq(adCampaignDrafts.id, adChangeRequests.draftId))
      .where(
        and(
          eq(adChangeRequests.adAccountId, input.adAccountId),
          eq(adCampaignDrafts.name, draft.name),
          inArray(adChangeRequests.status, [
            'pending_approval',
            'approved',
            'executing',
            'unknown',
          ]),
        ),
      );
    if (sameNameOnPlatform || sameNameRequested.length > 0) {
      return {
        ok: false as const,
        reason: 'duplicate_name' as const,
        message: 'Já existe uma campanha ou um pedido com este nome nesta conta.',
      };
    }

    try {
      assertPlausibleAmount(
        draft.dailyBudgetCents,
        { monthlyCapCents: current.capCents },
        'orçamento diário',
      );
    } catch (error) {
      await recordGuardrailEvent(db, input.adAccountId, 'implausible_amount', {
        attempted: 'create_campaign',
        attemptedCents: draft.dailyBudgetCents,
        capCents: current.capCents,
      });
      return {
        ok: false as const,
        reason: 'implausible_amount' as const,
        message: error instanceof Error ? error.message : 'Valor implausível',
      };
    }

    const exposureDeltaCents = creationExposure(
      draft,
      today,
      periodOverdeliveryFactor(account.platform),
    );

    // Everything is born paused, so it reserves nothing — but anyone with access
    // to the platform can switch it on, outside this system, and since ad sets
    // and ads are created too, one click is all it takes. It is therefore
    // judged as if it were running: the three ceilings, the platform's own
    // included, must have room for it today.
    //
    // Judged by the period factor, and never by less than one worst day: on
    // Google a single day may cost twice the budget, which is what decides a
    // request with one day left in the month. The builder shows this same
    // figure (`estimateCostCents`), so the two cannot drift.
    const judgedFrom = draft.startDate > today ? draft.startDate : today;
    const judgedCents = estimateCostCents(
      draft.dailyBudgetCents,
      campaignDaysInMonth(judgedFrom, draft.endDate, today),
      account.platform,
    );
    const refusal = await ceilingRefusal(db, input.adAccountId, current, judgedCents, {
      attempted: 'create_campaign',
      ...(judgedCents !== exposureDeltaCents
        ? { note: 'casca pausada julgada como se ativa' }
        : {}),
    });
    if (refusal) return refusal;

    const newCommitted = current.committedCents + exposureDeltaCents;
    await tx
      .update(budgetPeriods)
      .set({ committedCents: newCommitted, updatedAt: now })
      .where(eq(budgetPeriods.id, current.id));

    const [stored] = await tx
      .insert(adCampaignDrafts)
      .values({
        adAccountId: input.adAccountId,
        name: draft.name,
        objective: draft.objective,
        dailyBudgetCents: draft.dailyBudgetCents,
        startDate: draft.startDate,
        endDate: draft.endDate,
        startPaused: draft.startPaused,
        payload: draft,
        createdBy: input.requestedBy ?? null,
      })
      .returning({ id: adCampaignDrafts.id });
    if (!stored) throw new Error('failed to record campaign draft');

    const hash = draftPayloadHash({
      adAccountId: input.adAccountId,
      payload: draft,
      exposureDeltaCents,
    });

    const [request] = await tx
      .insert(adChangeRequests)
      .values({
        adAccountId: input.adAccountId,
        draftId: stored.id,
        budgetPeriodId: current.id,
        kind: 'create_campaign',
        fromValueCents: null,
        toValueCents: draft.dailyBudgetCents,
        exposureDeltaCents,
        payloadHash: hash,
        // Every change needs a human decision — there is no auto-approval.
        status: 'pending_approval',
        requestedBy: input.requestedBy ?? null,
        // Only ever a person: see the automation blocker in docs/ads/travas.md.
        requestedByAgent: false,
        reason: input.reason ?? null,
      })
      .returning({ id: adChangeRequests.id });
    if (!request) throw new Error('failed to record change request');

    return {
      ok: true as const,
      value: {
        changeRequestId: request.id,
        draftId: stored.id,
        exposureDeltaCents,
        payloadHash: hash,
        period: periodState({ ...current, committedCents: newCommitted }),
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
      platform_remaining_cents: string | null;
      platform_limit_source: string | null;
      platform_limit_synced_at: Date | string | null;
      platform_limit_note: string | null;
    } & Record<string, unknown>
  >(sql`
    select id, cap_cents, usable_cents, committed_cents, spent_cents,
           platform_remaining_cents, platform_limit_source, platform_limit_synced_at,
           platform_limit_note
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
    platformRemainingCents:
      row.platform_remaining_cents === null ? null : Number(row.platform_remaining_cents),
    platformLimitSource: row.platform_limit_source,
    // node-postgres parses timestamptz to a Date normally, but drizzle's raw
    // `execute` does not always get that parser wired in — accept either.
    platformLimitSyncedAt:
      row.platform_limit_synced_at === null ? null : new Date(row.platform_limit_synced_at),
    platformLimitNote: row.platform_limit_note,
  });
}

export interface PlatformLimitResult {
  periodId: string;
  platformRemainingCents: Cents | null;
  /** True when the platform allows less than our own cap would. */
  platformIsBinding: boolean;
  /** True when what is already committed exceeds what the platform allows. */
  committedExceedsPlatform: boolean;
}

/**
 * Records what the platform itself still allows for a period.
 *
 * Deliberately never rejects and never mutates committed exposure. Reading a
 * lower limit than expected is information, not an emergency: existing
 * reservations stay as they are and a person decides what to do. What it does
 * guarantee is that the next reservation is judged against the real number,
 * and that a binding platform limit leaves a guardrail event behind.
 */
export async function applyPlatformLimit(
  db: Database,
  input: {
    adAccountId: string;
    periodMonth: string;
    limit: PlatformSpendLimit;
    /** Why the platform would not answer, in its own words; null when it did. */
    note?: string | null;
    now?: Date;
  },
): Promise<PlatformLimitResult | null> {
  const now = input.now ?? new Date();

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
     where ad_account_id = ${input.adAccountId} and period_month = ${input.periodMonth}
  `);

  const row = rows.rows[0];
  if (!row) return null;

  const remaining = input.limit.remainingCents;
  const committed = Number(row.committed_cents);
  const usableHeadroom = Math.max(0, Number(row.usable_cents) - committed);

  await db
    .update(budgetPeriods)
    .set({
      platformRemainingCents: remaining,
      platformLimitSource: input.limit.source,
      platformLimitSyncedAt: now,
      platformLimitNote: input.note ?? null,
      updatedAt: now,
    })
    .where(eq(budgetPeriods.id, row.id));

  const platformIsBinding = remaining !== null && remaining < usableHeadroom;
  const committedExceedsPlatform = remaining !== null && committed > remaining;

  if (platformIsBinding) {
    await recordGuardrailEvent(db, input.adAccountId, 'cap_change', {
      periodMonth: input.periodMonth,
      platformRemainingCents: remaining,
      platformLimitCents: input.limit.limitCents,
      platformSpentCents: input.limit.spentCents,
      internalUsableHeadroomCents: usableHeadroom,
      committedCents: committed,
      source: input.limit.source,
      note: committedExceedsPlatform
        ? 'a plataforma permite menos do que já está comprometido'
        : 'o limite da plataforma é menor que o teto interno',
    });
  }

  return {
    periodId: row.id,
    platformRemainingCents: remaining,
    platformIsBinding,
    committedExceedsPlatform,
  };
}
