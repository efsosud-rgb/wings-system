import type { JobType } from '@wings/shared';
import type { Pool } from './db/client.js';
import { JOB_HANDLERS, recoverDeliveredRender } from './jobs/index.js';
import type { JobContext } from './jobs/types.js';
import {
  HEARTBEAT_INTERVAL_MS,
  STALE_AFTER_MS,
  beatJob,
  claimNextJob,
  completeJob,
  failJob,
  findStaleJobs,
  maxAttemptsFor,
  settleStaleJob,
  type Job,
  type StaleOutcome,
} from './queue.js';

export interface WorkerConfig {
  jobTypes: readonly JobType[];
  concurrency: number;
  pollIntervalMs: number;
  maxAttempts: number;
  /** Tests only; production uses HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
  /** How often abandoned jobs are looked for. Tests only; default 60 s. */
  reclaimIntervalMs?: number;
}

const RECLAIM_INTERVAL_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Never a stack trace or the job's input in the stored error: both can carry
 * a client's name or a file path. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `work` while writing the job's heartbeat every `intervalMs`. A failed
 * beat (the database blinked) is skipped, not fatal: the stale limits in
 * `queue.ts` leave room for several missed beats.
 */
export async function withHeartbeat<T>(
  pool: Pool,
  job: Job,
  intervalMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    beatJob(pool, job).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** Finds a delivered result for a job whose worker died, per type. Only render
 * has one: its output is a whole object in storage, and must never be redone. */
const RECOVERERS: Partial<
  Record<JobType, (job: Job, ctx: Pick<JobContext, 'storage'>) => Promise<unknown>>
> = {
  render: recoverDeliveredRender,
};

/**
 * Settles every abandoned `running` job of `types`: recovered when its result
 * was already delivered, back to the queue below its attempt limit, failed
 * with `worker_lost` at it. Safe to run from every replica at once: each
 * settle is one conditional update on a still-stale claim.
 */
export async function reclaimStaleJobs(
  pool: Pool,
  ctx: Pick<JobContext, 'storage'>,
  types: readonly JobType[],
  workerMaxAttempts: number,
  staleAfterMs: Record<JobType, number> = STALE_AFTER_MS,
): Promise<{ job: Job; outcome: StaleOutcome }[]> {
  const settled: { job: Job; outcome: StaleOutcome }[] = [];
  for (const type of types) {
    for (const job of await findStaleJobs(pool, type, staleAfterMs[type])) {
      const recover = RECOVERERS[type];
      const output = recover ? await recover(job, ctx).catch(() => null) : null;
      const outcome = await settleStaleJob(
        pool,
        job,
        staleAfterMs[type],
        maxAttemptsFor(type, workerMaxAttempts),
        output ?? null,
      );
      if (outcome) settled.push({ job, outcome });
    }
  }
  return settled;
}

/**
 * Runs `config.concurrency` polling loops side by side, each claiming one job
 * at a time, plus one loop that reclaims abandoned jobs. Returns a function
 * that asks every loop to stop after its current job and waits for them to.
 */
export function runWorker(
  pool: Pool,
  context: Omit<JobContext, 'threads'> & { threadsPerJob: number },
  config: WorkerConfig,
): () => Promise<void> {
  let stopped = false;
  let wake: () => void = () => undefined;
  const stopping = new Promise<void>((resolve) => {
    wake = resolve;
  });

  async function loop(): Promise<void> {
    while (!stopped) {
      const job = await claimNextJob(pool, config.jobTypes);
      if (!job) {
        await sleep(config.pollIntervalMs);
        continue;
      }
      const handler = JOB_HANDLERS[job.type];
      let settled: boolean;
      try {
        const output = await withHeartbeat(
          pool,
          job,
          config.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
          () => handler(job, { ...context, threads: context.threadsPerJob }),
        );
        settled = await completeJob(pool, job, output);
      } catch (error) {
        settled = await failJob(
          pool,
          job,
          messageOf(error),
          maxAttemptsFor(job.type, config.maxAttempts),
        );
      }
      if (!settled) {
        console.warn(
          `wings-worker: job ${job.id} (${job.type}) was reclaimed while it ran; its result was dropped`,
        );
      }
    }
  }

  async function reclaimLoop(): Promise<void> {
    while (!stopped) {
      try {
        const settled = await reclaimStaleJobs(pool, context, config.jobTypes, config.maxAttempts);
        for (const { job, outcome } of settled) {
          console.warn(`wings-worker: abandoned job ${job.id} (${job.type}) ${outcome.kind}`);
        }
      } catch (error) {
        console.error('wings-worker: could not reclaim abandoned jobs:', messageOf(error));
      }
      const timer = new Promise<void>((resolve) =>
        setTimeout(resolve, config.reclaimIntervalMs ?? RECLAIM_INTERVAL_MS).unref(),
      );
      await Promise.race([timer, stopping]);
    }
  }

  const loops = [...Array.from({ length: config.concurrency }, () => loop()), reclaimLoop()];
  const done = Promise.all(loops);
  return async () => {
    stopped = true;
    wake();
    await done;
  };
}
