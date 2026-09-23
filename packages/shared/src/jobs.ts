/**
 * The queue `apps/api` and `apps/worker` agree on: a `jobs` table in the same
 * Postgres database (migration owned by `apps/api`), which the worker polls
 * with `SELECT ... FOR UPDATE SKIP LOCKED`. Only the type names are a shared
 * contract; the table's columns and the worker's SQL are not (see
 * `apps/api/src/db/schema/jobs.ts` and `apps/worker/src/queue.ts`).
 */
export const JOB_TYPES = ['ffprobe', 'transcribe', 'render', 'enrich_lead'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** What a worker claims by default: every type it has a handler for. Kept
 * distinct from JOB_TYPES so a future type can land in the contract before
 * the worker is ready to claim it. */
export const JOB_TYPES_IMPLEMENTED = ['ffprobe', 'transcribe', 'render', 'enrich_lead'] as const satisfies readonly JobType[];

export type JobState = 'pending' | 'running' | 'done' | 'failed';
