/**
 * The queue `apps/api` and `apps/worker` agree on: a `jobs` table in the same
 * Postgres database (migration owned by `apps/api`), which the worker polls
 * with `SELECT ... FOR UPDATE SKIP LOCKED`. Only the type names are a shared
 * contract; the table's columns and the worker's SQL are not (see
 * `apps/api/src/db/schema/jobs.ts` and `apps/worker/src/queue.ts`).
 */
export const JOB_TYPES = ['ffprobe', 'transcribe', 'render'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** `render` has no handler in the worker yet: see docs/studio/jobs.md (pending). */
export const JOB_TYPES_IMPLEMENTED = ['ffprobe', 'transcribe'] as const satisfies readonly JobType[];

export type JobState = 'pending' | 'running' | 'done' | 'failed';
