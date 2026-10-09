import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { nextCronRun, parseCron, previousCronRun } from '../../lib/cron.js';
import { SAO_PAULO } from '../ads/dashboard/window.js';
import { latestIngestRun } from '../ads/ingest-runs.js';
import { runYoutubeIngestion, type YoutubeIngestDeps, type YoutubeIngestResult } from './ingest.js';

/**
 * The YouTube ingestion's clock, run by the API process itself: once a day at
 * 07:00 São Paulo unless YOUTUBE_INGEST_CRON says otherwise. Nothing is
 * scheduled in Coolify.
 *
 * A run is due when the last slot of the cron is newer than the newest
 * YouTube run, so an API that was down at the slot catches up when it comes
 * back, and a restart does not run it again. One run at a time across
 * replicas (a transaction-level advisory lock, re-checking "due" inside it),
 * and never two within MIN_GAP_MS, whatever the cron says. A failed run is
 * not retried before the next slot: the quota is not spent on a loop. Never
 * started by `buildApp`, so no test starts it; it does not start at all
 * without a key.
 */

export const DEFAULT_YOUTUBE_CRON = '0 7 * * *';
/** Shared by the scheduler and the manual CLI. */
export const YOUTUBE_LOCK_KEY = 7_202_603;
export const MIN_GAP_MS = 55 * 60_000;
const TICK_MS = 60_000;

/** The cron in force: the variable when it parses, else the default. */
export function youtubeCronOf(cron: string | undefined): string {
  return cron && parseCron(cron) ? cron.trim() : DEFAULT_YOUTUBE_CRON;
}

/** Whether a scheduled run is due at `now`. */
export async function youtubeRunDue(db: Database, cron: string, now: Date): Promise<boolean> {
  const slot = previousCronRun(cron, now, SAO_PAULO);
  if (!slot) return false;
  const last = await latestIngestRun(db, { kind: 'youtube' });
  if (!last) return true;
  if (now.getTime() - last.startedAt.getTime() < MIN_GAP_MS) return false;
  return last.startedAt.getTime() < slot.getTime();
}

export type LockedRun = { ran: false; reason: 'busy' | 'not_due' } | YoutubeIngestResult;

/**
 * One run under the lock. `force` (the manual CLI) skips the "due" check but
 * not the lock nor the minimum gap's purpose: a person asking twice in a row
 * gets a second reading, which only replaces today's numbers.
 */
export async function runYoutubeLocked(
  deps: YoutubeIngestDeps & { cron: string; force?: boolean },
): Promise<LockedRun> {
  const now = deps.now ?? new Date();
  return deps.db.transaction(async (tx) => {
    const lock = await tx.execute<{ got: boolean }>(
      sql`select pg_try_advisory_xact_lock(${YOUTUBE_LOCK_KEY}) as got`,
    );
    if (!lock.rows[0]?.got) return { ran: false, reason: 'busy' } as const;
    if (!deps.force && !(await youtubeRunDue(deps.db, deps.cron, now))) {
      return { ran: false, reason: 'not_due' } as const;
    }
    return runYoutubeIngestion({ ...deps, now });
  });
}

export function startYoutubeScheduler(
  deps: Omit<YoutubeIngestDeps, 'trigger' | 'now'> & {
    cron: string | undefined;
    log: (facts: Record<string, unknown>) => void;
    tickMs?: number;
  },
): () => void {
  const cron = youtubeCronOf(deps.cron);
  let busy = false;
  // Checked at once on start (catch-up), then at each slot of the cron.
  let checkAt = 0;
  const tick = async () => {
    const now = new Date();
    if (busy || now.getTime() < checkAt) return;
    busy = true;
    try {
      const result = await runYoutubeLocked({ ...deps, cron, trigger: 'scheduled_youtube', now });
      if (!('ran' in result)) {
        deps.log({
          job: 'youtube-ingest',
          status: result.status,
          ...(result.status === 'ok' ? { videos: result.videos, units: result.units } : {}),
          ...(result.status === 'failed' ? { error: result.error, units: result.units } : {}),
        });
      }
    } catch (error) {
      deps.log({
        job: 'youtube-ingest',
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      checkAt = nextCronRun(cron, now, SAO_PAULO)?.getTime() ?? Number.POSITIVE_INFINITY;
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.tickMs ?? TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
