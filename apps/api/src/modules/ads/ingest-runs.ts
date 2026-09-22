import { desc } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { ingestRuns } from '../../db/schema/index.js';
import type { AccountCycleResult } from './ingest-cycle.js';

/**
 * The ingest job's own record of itself: one row per run, written when it
 * starts and completed when it ends. The dashboard reads the newest row to
 * say when the last ingestion was, whether it finished, which account failed
 * in which step, and whether the scheduled one is overdue. Append-only: a run
 * that crashes leaves its `running` row behind, which is itself a finding.
 */

export type IngestTrigger = 'scheduled' | 'manual';

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

export async function startIngestRun(
  db: Database,
  input: { trigger: IngestTrigger; since: string; now?: Date },
): Promise<string> {
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

export async function latestIngestRun(db: Database) {
  const [row] = await db.select().from(ingestRuns).orderBy(desc(ingestRuns.startedAt)).limit(1);
  return row ?? null;
}
