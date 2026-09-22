import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './test/db.js';
import { claimNextJob, completeJob, failJob } from './queue.js';

describe('the jobs queue', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(() => database.drop());

  async function insertJob(type: string, input: unknown = {}) {
    const result = await database.pool.query<{ id: string }>(
      `insert into jobs (type, input) values ($1, $2) returning id`,
      [type, JSON.stringify(input)],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('insert did not return an id');
    return id;
  }

  it('claims the oldest pending job of the types asked for, and only once', async () => {
    const ffprobeId = await insertJob('ffprobe', { storageKey: 'drive/a.mp4' });
    await insertJob('render', { storageKey: 'drive/b.mp4' });

    const claimed = await claimNextJob(database.pool, ['ffprobe', 'transcribe']);
    expect(claimed).toEqual({
      id: ffprobeId,
      type: 'ffprobe',
      input: { storageKey: 'drive/a.mp4' },
      attempts: 1,
    });

    // Gone: a second poll for the same types finds nothing else pending.
    expect(await claimNextJob(database.pool, ['ffprobe', 'transcribe'])).toBeNull();
    // The render job is untouched: nobody is claiming that type.
    const row = await database.pool.query('select state from jobs where type = $1', ['render']);
    expect(row.rows[0]?.state).toBe('pending');
  });

  it('finishes a job as done, with its output', async () => {
    const id = await insertJob('ffprobe');
    await claimNextJob(database.pool, ['ffprobe']);
    await completeJob(database.pool, id, { durationSeconds: 12.5 });

    const row = await database.pool.query(
      'select state, output, error, finished_at is not null as finished from jobs where id = $1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({
      state: 'done',
      output: { durationSeconds: 12.5 },
      error: null,
      finished: true,
    });
  });

  it('retries a failed job until it runs out of attempts', async () => {
    const id = await insertJob('transcribe');
    const first = await claimNextJob(database.pool, ['transcribe']);
    if (!first) throw new Error('expected a job');
    await failJob(database.pool, first, 'ffmpeg exited with code 1', 3);

    let row = await database.pool.query(
      'select state, error, finished_at is not null as finished from jobs where id = $1',
      [id],
    );
    // Back to pending: attempts (1) is still under the ceiling (3).
    expect(row.rows[0]).toMatchObject({ state: 'pending', error: 'ffmpeg exited with code 1', finished: false });

    // Claim and fail two more times to reach the ceiling.
    for (let i = 0; i < 2; i++) {
      const job = await claimNextJob(database.pool, ['transcribe']);
      if (!job) throw new Error('expected a job to retry');
      await failJob(database.pool, job, 'ffmpeg exited with code 1', 3);
    }

    row = await database.pool.query(
      'select state, finished_at is not null as finished from jobs where id = $1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ state: 'failed', finished: true });
    // No more claims: it is not pending any more.
    expect(await claimNextJob(database.pool, ['transcribe'])).toBeNull();
  });

  it('returns null rather than block when no job matches', async () => {
    // Drain the "render" row an earlier test left pending, so this checks an
    // empty result rather than an untouched one.
    const leftover = await claimNextJob(database.pool, ['render']);
    if (leftover) await completeJob(database.pool, leftover.id, null);

    expect(await claimNextJob(database.pool, ['render'])).toBeNull();
    expect(await claimNextJob(database.pool, [])).toBeNull();
  });
});
