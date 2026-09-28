import { and, desc, eq, inArray, lt, notInArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { ingestRuns } from '../../db/schema/index.js';
import type { AccountCycleResult, ReconcileCycleAccountResult } from './ingest-cycle.js';

/**
 * The ingest job's own record of itself: one row per run, written when it
 * starts and completed when it ends. The dashboard reads the newest row to
 * say when the last ingestion was, whether it finished, which account failed
 * in which step, and whether the scheduled one is overdue. Append-only: a run
 * that crashes leaves its `running` row behind, which is itself a finding.
 */

/**
 * `scheduled`/`manual` are the full cycle (campaigns, ads, metrics,
 * breakdowns, alerts) — hourly-or-slower. `scheduled_reconcile`/
 * `manual_reconcile` are the fast cycle added for the 15-min dead-man window:
 * balance, platform limit and campaign status only, nothing else.
 */
export type IngestTrigger = 'scheduled' | 'manual' | 'scheduled_reconcile' | 'manual_reconcile';

const RECONCILE_TRIGGERS: readonly IngestTrigger[] = ['scheduled_reconcile', 'manual_reconcile'];

/** One account as the run recorded it. Errors carry codes and ids, never personal data. */
export interface IngestRunAccount {
  platform: string;
  externalId: string;
  status: 'ok' | 'skipped' | 'failed';
  step?: string;
  error?: string;
}

export interface IngestRunSite {
  status: 'ok' | 'failed' | 'skipped';
  posts?: number;
  error?: string;
}

export type IngestKind = 'full' | 'reconcile';

export const kindOfTrigger = (trigger: IngestTrigger): IngestKind =>
  RECONCILE_TRIGGERS.includes(trigger) ? 'reconcile' : 'full';

/**
 * How long a run may say `running` before it is taken for dead. Above the
 * CLI's own deadline (INGEST_DEADLINE_MS), so a live run is never retired: a
 * row older than this belongs to a process that was killed — a redeploy
 * replacing the container mid-run, as on 28/09 at 09:00, or the scheduler's
 * timeout.
 */
export const ABANDONED_AFTER_MS: Record<IngestKind, number> = {
  full: 20 * 60_000,
  reconcile: 6 * 60_000,
};

/** The CLI stops itself and records the run as failed after this long. */
export const INGEST_DEADLINE_MS: Record<IngestKind, number> = {
  full: 14 * 60_000,
  reconcile: 4 * 60_000,
};

const triggersOf = (kind: IngestKind) =>
  kind === 'reconcile'
    ? inArray(ingestRuns.trigger, [...RECONCILE_TRIGGERS])
    : notInArray(ingestRuns.trigger, [...RECONCILE_TRIGGERS]);

/**
 * Closes the `running` rows a dead process left behind, as failed with
 * `interrupted`. The row stays (append-only in spirit: nothing is deleted),
 * and the dashboard stops saying "em andamento" about a run nobody is doing.
 */
export async function retireAbandonedRuns(
  db: Database,
  kind: IngestKind,
  now = new Date(),
): Promise<number> {
  const retired = await db
    .update(ingestRuns)
    .set({ status: 'failed', error: 'interrupted', finishedAt: now })
    .where(
      and(
        triggersOf(kind),
        eq(ingestRuns.status, 'running'),
        lt(ingestRuns.startedAt, new Date(now.getTime() - ABANDONED_AFTER_MS[kind])),
      ),
    )
    .returning({ id: ingestRuns.id });
  return retired.length;
}

export async function startIngestRun(
  db: Database,
  input: { trigger: IngestTrigger; since: string; now?: Date },
): Promise<string> {
  await retireAbandonedRuns(db, kindOfTrigger(input.trigger), input.now ?? new Date());
  const [row] = await db
    .insert(ingestRuns)
    .values({ trigger: input.trigger, since: input.since, startedAt: input.now ?? new Date() })
    .returning({ id: ingestRuns.id });
  if (!row) throw new Error('failed to record ingest run');
  return row.id;
}

export async function finishIngestRun(
  db: Database,
  id: string,
  input: {
    status: 'ok' | 'failed';
    accounts: IngestRunAccount[];
    site: IngestRunSite | null;
    error?: string | null;
    now?: Date;
  },
): Promise<void> {
  await db
    .update(ingestRuns)
    .set({
      status: input.status,
      accounts: input.accounts,
      site: input.site,
      error: input.error ?? null,
      finishedAt: input.now ?? new Date(),
    })
    .where(eq(ingestRuns.id, id));
}

/** The cycle's result as the run row keeps it. */
export function accountRecordOf(result: AccountCycleResult): IngestRunAccount {
  const base = { platform: result.account.platform, externalId: result.account.externalId };
  if (result.status === 'ok') return { ...base, status: 'ok' };
  if (result.status === 'skipped') return { ...base, status: 'skipped', error: result.reason };
  return { ...base, status: 'failed', step: result.step, error: result.error.slice(0, 500) };
}

/** The reconcile-only cycle's result as the run row keeps it — no `step`, it has one. */
export function reconcileRecordOf(result: ReconcileCycleAccountResult): IngestRunAccount {
  const base = { platform: result.account.platform, externalId: result.account.externalId };
  if (result.status === 'ok') return { ...base, status: 'ok' };
  if (result.status === 'skipped') return { ...base, status: 'skipped', error: result.reason };
  return { ...base, status: 'failed', error: result.error.slice(0, 500) };
}

/**
 * The newest run row. `kind: 'reconcile'` reads the fast cycle's own runs,
 * `'full'` (the default) reads the campaigns/metrics/breakdowns cycle — each
 * ignores the other's rows, since the dashboard tells the two apart.
 */
export async function latestIngestRun(db: Database, options: { kind?: 'full' | 'reconcile' } = {}) {
  const kind = options.kind ?? 'full';
  const [row] = await db
    .select()
    .from(ingestRuns)
    .where(triggersOf(kind))
    .orderBy(desc(ingestRuns.startedAt))
    .limit(1);
  return row ?? null;
}
