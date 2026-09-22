import type { IngestionStatus } from '@wings/shared';
import { inArray, sql } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { adMetricsDaily } from '../../../db/schema/index.js';
import type { Env } from '../../../env.js';
import { nextCronRun, previousCronRun } from '../../../lib/cron.js';
import { latestIngestRun, type IngestRunAccount } from '../ingest-runs.js';
import { SAO_PAULO } from './window.js';

/**
 * How the ingest job is doing, for the dashboard header: last run, next run
 * by the cron the API was told (ADS_INGEST_CRON), and whether the scheduled
 * one failed to happen. The API schedules nothing itself; it only reads the
 * job's own record and the clock.
 */

/** A scheduled slot this much in the past with no run since it is overdue. */
const OVERDUE_GRACE_MS = 15 * 60_000;

export async function ingestionStatus(
  db: Database,
  env: Env,
  accountIds: string[],
  now = new Date(),
): Promise<IngestionStatus> {
  const run = await latestIngestRun(db);
  let lastRunAt: Date | null = run?.startedAt ?? null;
  let lastRunStatus: IngestionStatus['lastRunStatus'] = null;
  if (run) {
    lastRunStatus = run.status === 'ok' ? 'ok' : run.status === 'failed' ? 'failed' : 'running';
  } else if (accountIds.length > 0) {
    // Before the first run recorded itself, the newest metrics row is the best witness.
    const [row] = await db
      .select({ fetchedAt: sql<Date | null>`max(${adMetricsDaily.fetchedAt})` })
      .from(adMetricsDaily)
      .where(inArray(adMetricsDaily.adAccountId, accountIds));
    lastRunAt = row?.fetchedAt ? new Date(row.fetchedAt) : null;
  }

  const schedule = env.ADS_INGEST_CRON ?? null;
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
