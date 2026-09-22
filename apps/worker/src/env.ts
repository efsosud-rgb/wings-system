import { JOB_TYPES, JOB_TYPES_IMPLEMENTED, type JobType } from '@wings/shared';
import { z } from 'zod';

const requiredString = z.string().trim().min(1);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),

  /**
   * The Drive's own storage. Unlike the API, the worker has no local-volume
   * fallback: it reads and writes only through R2, never through a mounted
   * volume, so all four are required here.
   */
  R2_ENDPOINT: requiredString,
  R2_BUCKET: requiredString,
  R2_ACCESS_KEY_ID: requiredString,
  R2_SECRET_ACCESS_KEY: requiredString,
  R2_REGION: requiredString.optional(),

  /**
   * How much of the host this worker may use, split across the jobs it runs
   * at once. Unset, `WORKER_CPU_LIMIT` defaults to half the container's cores
   * (at least 1) and `WORKER_MEMORY_LIMIT_MB` to 2048 — the defaults asked
   * for. Both are read at startup, not renegotiated while running.
   */
  WORKER_CPU_LIMIT: z.coerce.number().int().positive().optional(),
  WORKER_MEMORY_LIMIT_MB: z.coerce.number().int().positive().default(2048),
  /** Rough memory budget per concurrent job, used with the two limits above
   * to size how many jobs run at once. Not a hard cap: Node cannot enforce
   * one on a child process by itself. */
  WORKER_MEMORY_PER_JOB_MB: z.coerce.number().int().positive().default(1024),

  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /** Comma-separated job types this instance claims. Excludes `render` by
   * default: it has no handler yet (see docs/studio/jobs.md, pending). */
  WORKER_JOB_TYPES: requiredString.default(JOB_TYPES_IMPLEMENTED.join(',')),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

/** `WORKER_JOB_TYPES`, parsed and checked against the types the contract knows. */
export function jobTypesOf(env: Env): JobType[] {
  const names = env.WORKER_JOB_TYPES.split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !(JOB_TYPES as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`WORKER_JOB_TYPES has unknown type(s): ${unknown.join(', ')}`);
  if (names.length === 0) throw new Error('WORKER_JOB_TYPES must name at least one job type');
  return names as JobType[];
}
