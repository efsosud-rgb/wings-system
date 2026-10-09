import { WINGS_CLIENT_ID } from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { clients, ingestRuns } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { fakeYoutube } from './fake-youtube-api.js';
import {
  DEFAULT_YOUTUBE_CRON,
  nextCheckAt,
  runYoutubeLocked,
  startYoutubeScheduler,
  youtubeCronOf,
  youtubeRunDue,
  YOUTUBE_LOCK_KEY,
} from './scheduler.js';

/**
 * The YouTube reading's clock: due once per cron slot (07:00 São Paulo by
 * default), caught up after downtime, never twice within the minimum gap,
 * one at a time across replicas.
 */

const KEY = 'test-youtube-key-never-printed';
const CHANNEL = 'UCabcdefghijklmnopqrstuv';

let harness: TestDatabase;
let db: Database;

const yt = () =>
  fakeYoutube({
    key: KEY,
    channelId: CHANNEL,
    videos: [
      {
        id: 'aaaaaaaaaaa',
        title: 'Institucional',
        publishedAt: '2026-08-01T15:00:00Z',
        duration: 'PT10M',
        views: 10,
      },
    ],
  });

const runAt = (iso: string) =>
  db.insert(ingestRuns).values({
    trigger: 'scheduled_youtube',
    status: 'ok',
    startedAt: new Date(iso),
    finishedAt: new Date(iso),
  });

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  await db.update(clients).set({ social: {} }).where(eq(clients.id, WINGS_CLIENT_ID));
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

beforeEach(async () => {
  await db.delete(ingestRuns);
});

describe('youtubeCronOf', () => {
  it('uses the variable when it parses, else once a day at 07:00', () => {
    expect(youtubeCronOf(undefined)).toBe(DEFAULT_YOUTUBE_CRON);
    expect(DEFAULT_YOUTUBE_CRON).toBe('0 7 * * *');
    expect(youtubeCronOf('30 6 * * 1-5')).toBe('30 6 * * 1-5');
    expect(youtubeCronOf('every day')).toBe(DEFAULT_YOUTUBE_CRON);
  });
});

describe('nextCheckAt', () => {
  it('waits for the next slot after a run, and looks again soon when the slot was held back', () => {
    const now = new Date('2026-10-09T10:00:00Z'); // 07:00 São Paulo
    expect(new Date(nextCheckAt(DEFAULT_YOUTUBE_CRON, now, false)).toISOString()).toBe(
      '2026-10-10T10:00:00.000Z',
    );
    // A manual run at 06:30 holds the 07:00 slot back; the day's reading still happens.
    expect(new Date(nextCheckAt(DEFAULT_YOUTUBE_CRON, now, true)).toISOString()).toBe(
      '2026-10-09T10:10:00.000Z',
    );
  });
});

describe('youtubeRunDue', () => {
  const cron = DEFAULT_YOUTUBE_CRON;

  it('is due when nothing ever ran, as soon as a slot has passed', async () => {
    expect(await youtubeRunDue(db, cron, new Date('2026-10-09T12:00:00Z'))).toBe(true);
  });

  it('is not due again the same day, and is due after the next slot', async () => {
    // 07:05 São Paulo.
    await runAt('2026-10-09T10:05:00Z');
    expect(await youtubeRunDue(db, cron, new Date('2026-10-09T20:00:00Z'))).toBe(false);
    // 06:59 next day: the slot has not come yet.
    expect(await youtubeRunDue(db, cron, new Date('2026-10-10T09:59:00Z'))).toBe(false);
    expect(await youtubeRunDue(db, cron, new Date('2026-10-10T10:00:00Z'))).toBe(true);
  });

  it('catches up a slot missed while the API was down', async () => {
    await runAt('2026-10-07T10:01:00Z');
    expect(await youtubeRunDue(db, cron, new Date('2026-10-09T15:30:00Z'))).toBe(true);
  });

  it('counts a failed run too: the quota is not spent retrying before the next slot', async () => {
    await db.insert(ingestRuns).values({
      trigger: 'scheduled_youtube',
      status: 'failed',
      error: 'quota_exceeded',
      startedAt: new Date('2026-10-09T10:01:00Z'),
    });
    expect(await youtubeRunDue(db, cron, new Date('2026-10-09T18:00:00Z'))).toBe(false);
  });

  it('never runs twice within the minimum gap, whatever the cron says', async () => {
    await runAt('2026-10-09T10:05:00Z');
    expect(await youtubeRunDue(db, '*/5 * * * *', new Date('2026-10-09T10:30:00Z'))).toBe(false);
    expect(await youtubeRunDue(db, '*/5 * * * *', new Date('2026-10-09T11:05:00Z'))).toBe(true);
  });

  it('ignores the ads ingestion runs', async () => {
    await db.insert(ingestRuns).values({ trigger: 'scheduled', status: 'ok' });
    expect(await youtubeRunDue(db, cron, new Date())).toBe(true);
  });
});

describe('runYoutubeLocked', () => {
  it('leaves quietly when another replica holds the lock', async () => {
    const fake = yt();
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${YOUTUBE_LOCK_KEY})`);
      return runYoutubeLocked({
        db,
        apiKey: KEY,
        channelEnv: CHANNEL,
        cron: DEFAULT_YOUTUBE_CRON,
        trigger: 'scheduled_youtube',
        fetchImpl: fake.fetch,
      });
    });
    expect(result).toEqual({ ran: false, reason: 'busy' });
    expect(fake.calls).toHaveLength(0);
  });

  it('runs when due, and not again right after', async () => {
    const fake = yt();
    const deps = {
      db,
      apiKey: KEY,
      channelEnv: CHANNEL,
      cron: DEFAULT_YOUTUBE_CRON,
      trigger: 'scheduled_youtube' as const,
      fetchImpl: fake.fetch,
      now: new Date('2026-10-09T12:00:00Z'),
    };
    expect(await runYoutubeLocked(deps)).toMatchObject({ status: 'ok', videos: 1, units: 3 });
    expect(await runYoutubeLocked({ ...deps, now: new Date('2026-10-09T12:10:00Z') })).toEqual({
      ran: false,
      reason: 'not_due',
    });
    // A person's manual run is not held back by the schedule.
    expect(
      await runYoutubeLocked({
        ...deps,
        trigger: 'manual_youtube',
        force: true,
        now: new Date('2026-10-09T12:20:00Z'),
      }),
    ).toMatchObject({ status: 'ok' });
    expect(fake.calls).toHaveLength(6);
  });
});

describe('startYoutubeScheduler', () => {
  it('catches up once on start, logs counts only, and waits for the next slot', async () => {
    const fake = yt();
    const logged: Record<string, unknown>[] = [];
    const stop = startYoutubeScheduler({
      db,
      apiKey: KEY,
      channelEnv: CHANNEL,
      cron: undefined,
      fetchImpl: fake.fetch,
      log: (facts) => logged.push(facts),
      tickMs: 10,
    });
    try {
      await expect.poll(() => logged.length, { timeout: 5000 }).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      stop();
    }
    expect(logged).toEqual([{ job: 'youtube-ingest', status: 'ok', videos: 1, units: 3 }]);
    expect(JSON.stringify(logged)).not.toContain(KEY);
    const runs = await db.select().from(ingestRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'scheduled_youtube', status: 'ok' });
  });
});
