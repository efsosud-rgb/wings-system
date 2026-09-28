import type { IngestionStatus } from '@wings/shared';
import { inArray, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { adMetricsDaily } from '../../../db/schema/index.js';
import type { Env } from '../../../env.js';
import { nextCronRun, previousCronRun } from '../../../lib/cron.js';
import { ABANDONED_AFTER_MS, latestIngestRun, type IngestRunAccount } from '../ingest-runs.js';
import { SAO_PAULO } from './window.js';

/**
 * How an ingest job is doing, for the dashboard header: last run, next run by
 * the cron the API was told (ADS_INGEST_CRON for the full cycle,
 * ADS_RECONCILE_CRON for the fast one), and whether the scheduled one failed
 * to happen. The API schedules nothing itself; it only reads the job's own
 * record and the clock.
 */

/** A scheduled slot this much in the past with no run since it is overdue. */
const OVERDUE_GRACE_MS = 15 * 60_000;

export async function ingestionStatus(
  db: Database,
  env: Env,
  accountIds: string[],
  now = new Date(),
  options: { kind?: 'full' | 'reconcile' } = {},
): Promise<IngestionStatus> {
  const kind = options.kind ?? 'full';
  const run = await latestIngestRun(db, { kind });
  let lastRunAt: Date | null = run?.startedAt ?? null;
  let lastRunStatus: IngestionStatus['lastRunStatus'] = null;
  if (run) {
    // A `running` row past the abandon window belongs to a dead process (the
    // next run retires it); until then it must not read "em andamento".
    const abandoned =
      run.status === 'running' &&
      now.getTime() - run.startedAt.getTime() > ABANDONED_AFTER_MS[kind];
    lastRunStatus =
      run.status === 'ok' ? 'ok' : run.status === 'failed' || abandoned ? 'failed' : 'running';
  } else if (accountIds.length > 0 && kind === 'full') {
    // Before the first run recorded itself, the newest metrics row is the best witness.
    // The fast cycle touches no metrics table, so it has no such witness — it
    // just reads as "never run" until its own first `ingest_runs` row lands.
    const [row] = await db
      .select({ fetchedAt: sql<Date | null>`max(${adMetricsDaily.fetchedAt})` })
      .from(adMetricsDaily)
      .where(inArray(adMetricsDaily.adAccountId, accountIds));
    lastRunAt = row?.fetchedAt ? new Date(row.fetchedAt) : null;
  }

  const schedule = (kind === 'reconcile' ? env.ADS_RECONCILE_CRON : env.ADS_INGEST_CRON) ?? null;
  const nextRunAt = schedule ? nextCronRun(schedule, now, SAO_PAULO) : null;
  const previousDue = schedule ? previousCronRun(schedule, now, SAO_PAULO) : null;
  const overdue =
    previousDue !== null &&
    now.getTime() - previousDue.getTime() > OVERDUE_GRACE_MS &&
    (lastRunAt === null || lastRunAt.getTime() < previousDue.getTime() - OVERDUE_GRACE_MS);

  const accounts = ((run?.accounts as IngestRunAccount[] | undefined) ?? []).filter(
    (account) => account.status === 'failed',
  );
  return {
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastRunStatus,
    lastRunFailures: accounts.map((account) => ({
      platform: account.platform,
      step: account.step ?? 'desconhecido',
    })),
    schedule,
    nextRunAt: nextRunAt?.toISOString() ?? null,
    overdue,
  };
}
