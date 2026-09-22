import type { JobType } from '@wings/shared';
import type { Pool } from './db/client.js';
import { JOB_HANDLERS } from './jobs/index.js';
import type { JobContext } from './jobs/types.js';
import { claimNextJob, failJob, completeJob } from './queue.js';

export interface WorkerConfig {
  jobTypes: readonly JobType[];
  concurrency: number;
  pollIntervalMs: number;
  maxAttempts: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Never a stack trace or the job's input in the stored error: both can carry
 * a client's name or a file path. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `config.concurrency` polling loops side by side, each claiming one job
 * at a time. Returns a function that asks every loop to stop after its
 * current job and waits for them to.
 */
export function runWorker(
  pool: Pool,
  context: Omit<JobContext, 'threads'> & { threadsPerJob: number },
  config: WorkerConfig,
): () => Promise<void> {
  let stopped = false;

  async function loop(): Promise<void> {
    while (!stopped) {
      const job = await claimNextJob(pool, config.jobTypes);
      if (!job) {
        await sleep(config.pollIntervalMs);
        continue;
      }
      const handler = JOB_HANDLERS[job.type];
      try {
        const output = await handler(job, { ...context, threads: context.threadsPerJob });
        await completeJob(pool, job.id, output);
      } catch (error) {
        await failJob(pool, job, messageOf(error), config.maxAttempts);
      }
    }
  }

  const loops = Array.from({ length: config.concurrency }, () => loop());
  const done = Promise.all(loops);
  return async () => {
    stopped = true;
    await done;
  };
}
