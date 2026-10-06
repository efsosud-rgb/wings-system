import type { JobType } from '@wings/shared';
import type { Pool } from './db/client.js';

export interface Job {
  id: string;
  type: JobType;
  input: unknown;
  attempts: number;
}

interface JobRow {
  id: string;
  type: string;
  input: unknown;
  attempts: number;
}

/**
 * Claims the oldest pending job of one of `types`, atomically: the `UPDATE`'s
 * subquery locks the row with `FOR UPDATE SKIP LOCKED`, so two worker
 * replicas polling at once never take the same job.
 */
export async function claimNextJob(pool: Pool, types: readonly JobType[]): Promise<Job | null> {
  if (types.length === 0) return null;
  const result = await pool.query<JobRow>(
    `update jobs
       set state = 'running', attempts = attempts + 1, started_at = now(), heartbeat_at = now(), updated_at = now()
       where id = (
         select id from jobs
         where state = 'pending' and type = any($1::text[])
         order by created_at asc
         for update skip locked
         limit 1
       )
       returning id, type, input, attempts`,
    [types],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, type: row.type as JobType, input: row.input, attempts: row.attempts };
}

/**
 * Every write that ends or extends a claim names the claim: the id, the
 * attempt number and `running`. When the job was reclaimed meanwhile (its
 * heartbeat stopped long enough), the write finds nothing and returns false,
 * so a worker that comes back late never overwrites what came after it.
 */
const OWN_CLAIM = `id = $1 and attempts = $2 and state = 'running'`;

export async function completeJob(pool: Pool, job: Job, output: unknown): Promise<boolean> {
  const result = await pool.query(
    `update jobs
       set state = 'done', output = $3, error = null, finished_at = now(), updated_at = now()
       where ${OWN_CLAIM}`,
    [job.id, job.attempts, JSON.stringify(output ?? null)],
  );
  return result.rowCount === 1;
}

/** How often a running job's `heartbeat_at` is written. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How long a `running` job may go without a heartbeat before it counts as
 * abandoned. The heartbeat is written by the Node process while the heavy
 * work runs in a child (ffmpeg, whisper), so these only have to outlast a
 * busy event loop and a slow database, not the job itself: ffprobe never
 * holds the loop, the others hash or read whole files in-process.
 */
export const STALE_AFTER_MS: Record<JobType, number> = {
  ffprobe: 2 * 60_000,
  transcribe: 5 * 60_000,
  render: 5 * 60_000,
  enrich_lead: 5 * 60_000,
  // Same child-process shape as the Studio's transcription.
  transcribe_meeting: 5 * 60_000,
};

/** Keeps the claim alive. False when the job is no longer this claim's. */
export async function beatJob(pool: Pool, job: Job): Promise<boolean> {
  const result = await pool.query(`update jobs set heartbeat_at = now() where ${OWN_CLAIM}`, [
    job.id,
    job.attempts,
  ]);
  return result.rowCount === 1;
}

/** A row claimed before `heartbeat_at` existed has none: its start counts. */
const LAST_SIGN_OF_LIFE = `coalesce(heartbeat_at, started_at, updated_at)`;

/** `running` jobs of `type` whose last heartbeat is older than `staleAfterMs`. */
export async function findStaleJobs(
  pool: Pool,
  type: JobType,
  staleAfterMs: number,
): Promise<Job[]> {
  const result = await pool.query<JobRow>(
    `select id, type, input, attempts from jobs
       where state = 'running' and type = $1
         and ${LAST_SIGN_OF_LIFE} < now() - $2 * interval '1 millisecond'
       order by created_at asc`,
    [type, staleAfterMs],
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type as JobType,
    input: row.input,
    attempts: row.attempts,
  }));
}

export type StaleOutcome =
  | { kind: 'requeued' }
  | { kind: 'failed' }
  /** The job's result was already delivered before the worker died. */
  | { kind: 'recovered'; output: unknown };

/**
 * Settles one abandoned job, but only if it is still the same stale claim:
 * the update re-checks the heartbeat, so a worker that was merely slow and
 * beat in between keeps its job. Below `maxAttempts` it goes back to the
 * queue; at the limit it fails with `worker_lost`; `recovered` finishes it as
 * done with the output found (a render already in storage is never redone).
 */
export async function settleStaleJob(
  pool: Pool,
  job: Job,
  staleAfterMs: number,
  maxAttempts: number,
  recoveredOutput: unknown = null,
): Promise<StaleOutcome | null> {
  const stillStale = `${OWN_CLAIM} and ${LAST_SIGN_OF_LIFE} < now() - $3 * interval '1 millisecond'`;
  if (recoveredOutput !== null) {
    const result = await pool.query(
      `update jobs
         set state = 'done', output = $4, error = null, heartbeat_at = null, finished_at = now(), updated_at = now()
         where ${stillStale}`,
      [job.id, job.attempts, staleAfterMs, JSON.stringify(recoveredOutput)],
    );
    return result.rowCount === 1 ? { kind: 'recovered', output: recoveredOutput } : null;
  }
  const giveUp = job.attempts >= maxAttempts;
  const error = giveUp
    ? `worker_lost: o worker parou no meio do job e as tentativas acabaram (${job.attempts} de ${maxAttempts})`
    : `worker_lost: o worker parou no meio do job; voltou para a fila (tentativa ${job.attempts} de ${maxAttempts})`;
  const result = await pool.query(
    giveUp
      ? `update jobs
           set state = 'failed', error = $4, heartbeat_at = null, finished_at = now(), updated_at = now()
           where ${stillStale}`
      : `update jobs
           set state = 'pending', error = $4, started_at = null, heartbeat_at = null, updated_at = now()
           where ${stillStale}`,
    [job.id, job.attempts, staleAfterMs, error],
  );
  if (result.rowCount !== 1) return null;
  return giveUp ? { kind: 'failed' } : { kind: 'requeued' };
}

/** `render` is one attempt, always (docs/studio/jobs.md: "a job is one
 * attempt"; render is too expensive to retry, and the person asks again from
 * the screen). `enrich_lead` too: its searches are paid, and a retry would
 * pay again (docs/leads/intake.md). Every other type uses the worker's own
 * `WORKER_MAX_ATTEMPTS`. */
export function maxAttemptsFor(type: JobType, workerMaxAttempts: number): number {
  return type === 'render' || type === 'enrich_lead' ? 1 : workerMaxAttempts;
}

/**
 * Below `maxAttempts`, the job goes back to `pending` for another try;
 * otherwise it is `failed` for good. `error` is a message, never a stack
 * trace or the job's input: those can carry a client's name or a file path.
 */
export async function failJob(
  pool: Pool,
  job: Job,
  error: string,
  maxAttempts: number,
): Promise<boolean> {
  const giveUp = job.attempts >= maxAttempts;
  const result = await pool.query(
    `update jobs
       set state = $3, error = $4, heartbeat_at = null, updated_at = now(),
           finished_at = case when $3 = 'failed' then now() else null end
       where ${OWN_CLAIM}`,
    [job.id, job.attempts, giveUp ? 'failed' : 'pending', error],
  );
  return result.rowCount === 1;
}
