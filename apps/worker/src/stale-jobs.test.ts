import { createHash } from 'node:crypto';
import { wingsDriveRef, type JobType } from '@wings/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './test/db.js';
import { createMemoryStorage } from './test/memory-storage.js';
import {
  beatJob,
  claimNextJob,
  completeJob,
  findStaleJobs,
  settleStaleJob,
  STALE_AFTER_MS,
} from './queue.js';
import { reclaimStaleJobs, withHeartbeat } from './worker.js';

const OUTPUT_KEY = 'drive/2026-09/render-out';
const VIDEO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const renderInput = {
  version: 1,
  project: {
    timeline: {
      tracks: [
        {
          clips: [{ start: 0, length: 4, asset: { type: 'video', src: wingsDriveRef(VIDEO_ID) } }],
        },
      ],
    },
  },
  assets: {
    [VIDEO_ID]: { storageKey: 'drive/2026-09/source', mimeType: 'video/mp4', byteSize: 10 },
  },
  output: {
    storageKey: OUTPUT_KEY,
    container: 'mp4',
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrate: 8_000_000,
    audioBitrate: 192_000,
  },
};

describe('abandoned jobs', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(() => database.drop());
  beforeEach(async () => {
    await database.pool.query('delete from jobs');
  });

  const insertJob = async (type: JobType, input: unknown = {}) => {
    await database.pool.query('insert into jobs (type, input) values ($1, $2)', [
      type,
      JSON.stringify(input),
    ]);
    const job = await claimNextJob(database.pool, [type]);
    if (!job) throw new Error('expected a job');
    return job;
  };
  /** Pretends the last heartbeat was `minutes` ago. */
  const silentFor = (id: string, minutes: number) =>
    database.pool.query(
      `update jobs set heartbeat_at = now() - $2 * interval '1 minute' where id = $1`,
      [id, minutes],
    );
  const rowOf = async (id: string) =>
    (
      await database.pool.query<{
        state: string;
        attempts: number;
        error: string | null;
        output: Record<string, unknown> | null;
        started: boolean;
        finished: boolean;
        heartbeat_at: Date | null;
      }>(
        `select state, attempts, error, output, heartbeat_at,
                started_at is not null as started, finished_at is not null as finished
           from jobs where id = $1`,
        [id],
      )
    ).rows[0]!;
  const reclaim = (types: JobType[]) =>
    reclaimStaleJobs(database.pool, { storage: createMemoryStorage() }, types, 3);

  it('writes a heartbeat on claim, and on every beat while the claim is its own', async () => {
    const job = await insertJob('transcribe');
    expect((await rowOf(job.id)).heartbeat_at).not.toBeNull();
    await silentFor(job.id, 3);
    expect(await beatJob(database.pool, job)).toBe(true);
    expect(await findStaleJobs(database.pool, 'transcribe', 60_000)).toEqual([]);
    // Another attempt number is not this claim.
    expect(await beatJob(database.pool, { ...job, attempts: job.attempts + 1 })).toBe(false);
  });

  it('beats while the work runs, and stops when it ends', async () => {
    const job = await insertJob('transcribe');
    await silentFor(job.id, 10);
    await withHeartbeat(
      database.pool,
      job,
      20,
      () => new Promise((resolve) => setTimeout(resolve, 120)),
    );
    expect(await findStaleJobs(database.pool, 'transcribe', 60_000)).toEqual([]);
  });

  it('puts a transcription whose worker went silent back in the queue, below the limit', async () => {
    const job = await insertJob('transcribe');
    await silentFor(job.id, 6);
    expect(await reclaim(['transcribe'])).toEqual([{ job, outcome: { kind: 'requeued' } }]);
    expect(await rowOf(job.id)).toMatchObject({
      state: 'pending',
      attempts: 1,
      started: false,
      heartbeat_at: null,
      error: 'worker_lost: o worker parou no meio do job; voltou para a fila (tentativa 1 de 3)',
    });
    // And it is claimable again, as attempt 2.
    expect((await claimNextJob(database.pool, ['transcribe']))?.attempts).toBe(2);
  });

  it('fails it with worker_lost once the attempts are used up', async () => {
    const job = await insertJob('transcribe');
    await database.pool.query('update jobs set attempts = 3 where id = $1', [job.id]);
    await silentFor(job.id, 6);
    const [settled] = await reclaim(['transcribe']);
    expect(settled?.outcome).toEqual({ kind: 'failed' });
    expect(await rowOf(job.id)).toMatchObject({
      state: 'failed',
      finished: true,
      error: 'worker_lost: o worker parou no meio do job e as tentativas acabaram (3 de 3)',
    });
  });

  it('waits a different time per type: 2 minutes for ffprobe, 5 for transcribe', async () => {
    expect(STALE_AFTER_MS).toMatchObject({
      ffprobe: 120_000,
      transcribe: 300_000,
      render: 300_000,
    });
    const probe = await insertJob('ffprobe');
    const captions = await insertJob('transcribe');
    await silentFor(probe.id, 3);
    await silentFor(captions.id, 3);
    const settled = await reclaim(['ffprobe', 'transcribe']);
    expect(settled.map((s) => s.job.id)).toEqual([probe.id]);
    expect((await rowOf(captions.id)).state).toBe('running');
  });

  it('only looks at the types this worker handles', async () => {
    const job = await insertJob('transcribe');
    await silentFor(job.id, 60);
    expect(await reclaim(['ffprobe'])).toEqual([]);
    expect((await rowOf(job.id)).state).toBe('running');
  });

  it('counts from started_at for a row claimed before heartbeats existed', async () => {
    const job = await insertJob('transcribe');
    await database.pool.query(
      `update jobs set heartbeat_at = null, started_at = now() - interval '10 minutes' where id = $1`,
      [job.id],
    );
    expect((await reclaim(['transcribe']))[0]?.outcome).toEqual({ kind: 'requeued' });
  });

  it('leaves a job alone when its worker beats between the look and the settle', async () => {
    const job = await insertJob('transcribe');
    await silentFor(job.id, 6);
    const [stale] = await findStaleJobs(database.pool, 'transcribe', STALE_AFTER_MS.transcribe);
    expect(stale?.id).toBe(job.id);
    await beatJob(database.pool, job);
    expect(await settleStaleJob(database.pool, stale!, STALE_AFTER_MS.transcribe, 3)).toBeNull();
    expect((await rowOf(job.id)).state).toBe('running');
  });

  it('drops the result of a worker that comes back after its job was taken over', async () => {
    const first = await insertJob('transcribe');
    await silentFor(first.id, 6);
    await reclaim(['transcribe']);
    const second = await claimNextJob(database.pool, ['transcribe']);
    expect(await completeJob(database.pool, first, { late: true })).toBe(false);
    expect(await completeJob(database.pool, second!, { onTime: true })).toBe(true);
    expect((await rowOf(first.id)).output).toEqual({ onTime: true });
  });

  it('never renders twice: a render already in storage is finished as done', async () => {
    const job = await insertJob('render', renderInput);
    await silentFor(job.id, 6);
    const bytes = Buffer.from('the delivered render');
    const storage = createMemoryStorage({ [OUTPUT_KEY]: bytes });

    const [settled] = await reclaimStaleJobs(database.pool, { storage }, ['render'], 3);
    expect(settled?.outcome.kind).toBe('recovered');
    const row = await rowOf(job.id);
    expect(row).toMatchObject({ state: 'done', attempts: 1, error: null, finished: true });
    expect(row.output).toEqual({
      storageKey: OUTPUT_KEY,
      byteSize: bytes.length,
      checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      mimeType: 'video/mp4',
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 4,
      unsupported: [],
      renderSeconds: null,
      recovered: true,
    });
  });

  it('fails a render that never reached storage, and never puts it back in the queue', async () => {
    const job = await insertJob('render', renderInput);
    await silentFor(job.id, 6);
    // Even with a generous worker limit, render gets one attempt.
    const [settled] = await reclaimStaleJobs(
      database.pool,
      { storage: createMemoryStorage() },
      ['render'],
      5,
    );
    expect(settled?.outcome).toEqual({ kind: 'failed' });
    expect(await rowOf(job.id)).toMatchObject({
      state: 'failed',
      error: 'worker_lost: o worker parou no meio do job e as tentativas acabaram (1 de 1)',
    });
    expect(await claimNextJob(database.pool, ['render'])).toBeNull();
  });
});
