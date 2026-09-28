import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { ingestRuns } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { ingestionStatus } from './dashboard/ingestion.js';
import { startIngestRun } from './ingest-runs.js';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

beforeEach(async () => {
  await db.delete(ingestRuns);
});

const NOW = new Date('2026-09-28T16:30:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const env = { ADS_INGEST_CRON: '0 * * * *', ADS_RECONCILE_CRON: '*/15 * * * *' } as Env;

async function running(trigger: string, startedAt: Date) {
  const [row] = await db
    .insert(ingestRuns)
    .values({ trigger, status: 'running', startedAt })
    .returning({ id: ingestRuns.id });
  return row!.id;
}

const statusOf = async (id: string) =>
  (await db.select().from(ingestRuns).where(eq(ingestRuns.id, id)))[0];

describe('a run left behind by a killed process', () => {
  it('is closed as interrupted when the next run of the same kind starts', async () => {
    // 28/09: the 09:00 full cycle died when a redeploy replaced the container.
    const dead = await running('scheduled', minutesAgo(210));
    const live = await running('scheduled', minutesAgo(2));
    const otherKind = await running('scheduled_reconcile', minutesAgo(210));

    await startIngestRun(db, { trigger: 'scheduled', since: '2026-09-21', now: NOW });

    expect(await statusOf(dead)).toMatchObject({ status: 'failed', error: 'interrupted' });
    expect((await statusOf(dead))?.finishedAt).toEqual(NOW);
    // A run that may still be alive is left alone, and so is the other cycle.
    expect(await statusOf(live)).toMatchObject({ status: 'running' });
    expect(await statusOf(otherKind)).toMatchObject({ status: 'running' });
  });

  it('the fast cycle retires its own dead runs sooner', async () => {
    const dead = await running('scheduled_reconcile', minutesAgo(10));
    await startIngestRun(db, { trigger: 'scheduled_reconcile', since: '2026-09-21', now: NOW });
    expect(await statusOf(dead)).toMatchObject({ status: 'failed', error: 'interrupted' });
  });

  it('does not read "em andamento" on the dashboard once it is past the abandon window', async () => {
    await running('scheduled', minutesAgo(210));
    const stuck = await ingestionStatus(db, env, [], NOW);
    expect(stuck.lastRunStatus).toBe('failed');
    // Hourly schedule, last start 3.5 h ago: overdue.
    expect(stuck.overdue).toBe(true);

    await db.delete(ingestRuns);
    await running('scheduled', minutesAgo(1));
    expect((await ingestionStatus(db, env, [], NOW)).lastRunStatus).toBe('running');
  });
});
