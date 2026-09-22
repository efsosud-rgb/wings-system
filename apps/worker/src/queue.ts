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
       set state = 'running', attempts = attempts + 1, started_at = now(), updated_at = now()
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

export async function completeJob(pool: Pool, id: string, output: unknown): Promise<void> {
  await pool.query(
    `update jobs
       set state = 'done', output = $2, error = null, finished_at = now(), updated_at = now()
       where id = $1`,
    [id, JSON.stringify(output ?? null)],
  );
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
): Promise<void> {
  const giveUp = job.attempts >= maxAttempts;
  await pool.query(
    `update jobs
       set state = $2, error = $3, updated_at = now(), finished_at = case when $2 = 'failed' then now() else null end
       where id = $1`,
    [job.id, giveUp ? 'failed' : 'pending', error],
  );
}
