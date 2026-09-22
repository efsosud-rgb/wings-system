import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * A queue for work the API hands off to `apps/worker`, running outside the
 * request/response cycle: media the API cannot do inline (`ffprobe`,
 * `transcribe`, and later `render`). The worker claims one row at a time with
 * `SELECT ... FOR UPDATE SKIP LOCKED`, so several worker replicas never pick
 * the same job. It talks to this table with plain SQL, not this schema file —
 * see `apps/worker/src/queue.ts` — because it is a separate deployable that
 * must not depend on `@wings/api`. Keep the two in step by hand.
 *
 * `input` and `output` are JSON because each `type` shapes them differently;
 * what each one takes and returns lives in `apps/worker/src/jobs/*.ts`. A job
 * reads and writes files by the Drive's `storage_key`, never by a volume path.
 */
export const jobs = pgTable(
  'jobs',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** ffprobe | transcribe | render (render has no worker handler yet) */
    type: text('type').notNull(),
    input: jsonb('input').notNull().default({}),
    /** pending | running | done | failed */
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    output: jsonb('output'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // The worker polls for the oldest pending row of the types it handles.
    index('jobs_state_created_idx').on(table.state, table.createdAt),
  ],
);
