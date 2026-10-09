import { randomBytes } from 'node:crypto';
import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type YoutubeChannelResponse,
  type YoutubeVideoSummary,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { clients, ingestRuns, youtubeVideoDaily, youtubeVideos } from '../../db/schema/index.js';
import { loadEnv, type Env } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { latestIngestRun } from '../ads/ingest-runs.js';
import { fakeYoutube, type FakeYoutubeVideo } from './fake-youtube-api.js';
import { resolveYoutubeChannel, runYoutubeIngestion } from './ingest.js';
import { youtubeChannelView } from './view.js';

/**
 * The YouTube channel end to end against a scripted YouTube: the daily
 * reading writes one row per video and one per video per day, the screen
 * computes growth only from exact days, and nothing is guessed.
 */

const KEY = 'test-youtube-key-never-printed';
const CHANNEL = 'UCabcdefghijklmnopqrstuv';
const HANDLE = '@wingscompany';

/** São Paulo noon on a day. */
const at = (day: string) => new Date(`${day}T12:00:00-03:00`);

const videos: FakeYoutubeVideo[] = [
  // Newest first, as the uploads playlist lists them.
  {
    id: 'bbbbbbbbbbb',
    title: 'Short da cafeteria',
    publishedAt: '2026-10-05T15:00:00Z',
    duration: 'PT30S',
    views: 0,
    short: true,
  },
  {
    id: 'ccccccccccc',
    title: 'Como formatar uma franquia',
    publishedAt: '2026-09-20T15:00:00Z',
    duration: 'PT2M',
    views: 0,
    short: false,
  },
  {
    id: 'ddddddddddd',
    title: 'Vídeo não listado',
    publishedAt: '2026-07-01T15:00:00Z',
    duration: 'PT3M20S',
    views: 50,
    privacy: 'unlisted',
  },
  {
    id: 'eeeeeeeeeee',
    title: 'Antigo que voltou a ser público',
    publishedAt: '2026-06-01T15:00:00Z',
    duration: 'PT1M40S',
    views: 0,
    likes: null,
    comments: null,
    short: 'consent',
  },
  {
    id: 'aaaaaaaaaaa',
    title: 'Institucional Wings',
    publishedAt: '2026-08-01T15:00:00Z',
    duration: 'PT10M',
    views: 0,
    likes: 10,
    comments: 2,
  },
];
const byId = (id: string) => videos.find((video) => video.id === id)!;

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let env: Env;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: randomBytes(48).toString('base64'),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'https://staging.wingssystem.online',
    YOUTUBE_API_KEY: KEY,
  });
  app = await buildApp({ env, db, now: () => at('2026-10-09') });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function session(role: 'marketing' | 'vendedor_expansao') {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'marketing' ? 'marketing' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { [SESSION_COOKIE]: token };
}

const setLink = (youtube: string | null) =>
  db
    .update(clients)
    .set({ social: youtube === null ? {} : { youtube } })
    .where(eq(clients.id, WINGS_CLIENT_ID));

function ingest(
  day: string,
  options: { failOn?: Parameters<typeof fakeYoutube>[0]['failOn'] } = {},
) {
  const yt = fakeYoutube({
    key: KEY,
    channelId: CHANNEL,
    handle: HANDLE,
    videos: videos.filter((video) => video.publishedAt < `${day}T23:59:59-03:00`),
    failOn: options.failOn ?? null,
  });
  return {
    yt,
    run: runYoutubeIngestion({
      db,
      apiKey: KEY,
      channelEnv: undefined,
      trigger: 'manual_youtube',
      fetchImpl: yt.fetch,
      now: at(day),
    }),
  };
}

describe('which channel is read', () => {
  it('takes the client record link first, then YOUTUBE_CHANNEL_ID, and reports a bad link', async () => {
    await setLink(null);
    expect(await resolveYoutubeChannel(db, undefined)).toEqual({ gap: 'no_channel' });
    expect(await resolveYoutubeChannel(db, CHANNEL)).toEqual({
      ref: { kind: 'id', id: CHANNEL },
      source: 'env',
    });
    await setLink('https://www.youtube.com/watch?v=aaaaaaaaaaa');
    expect(await resolveYoutubeChannel(db, CHANNEL)).toEqual({ gap: 'bad_link' });
    await setLink(`https://www.youtube.com/${HANDLE}`);
    expect(await resolveYoutubeChannel(db, CHANNEL)).toEqual({
      ref: { kind: 'handle', handle: HANDLE },
      source: 'client_record',
    });
  });
});

describe('the daily reading', () => {
  it('does nothing at all without a key', async () => {
    const yt = fakeYoutube({ key: KEY, channelId: CHANNEL, videos });
    const result = await runYoutubeIngestion({
      db,
      apiKey: undefined,
      channelEnv: CHANNEL,
      trigger: 'manual_youtube',
      fetchImpl: yt.fetch,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'no_key' });
    expect(yt.calls).toHaveLength(0);
    expect(await db.select().from(ingestRuns)).toHaveLength(0);
  });

  it('records a failed run, and calls nothing, when no channel is configured', async () => {
    await setLink(null);
    const { yt, run } = ingest('2026-09-08');
    const result = await run;
    expect(result).toMatchObject({ status: 'failed', error: 'no_channel', units: 0 });
    expect(yt.calls).toHaveLength(0);
    const [row] = await db.select().from(ingestRuns);
    expect(row).toMatchObject({ trigger: 'manual_youtube', status: 'failed', error: 'no_channel' });
    await db.delete(ingestRuns);
  });

  it('reads the public uploads once, with the quota counted, and writes the day', async () => {
    await setLink(`https://www.youtube.com/${HANDLE}`);
    byId('aaaaaaaaaaa').views = 1000;
    byId('eeeeeeeeeee').privacy = 'private';
    const { yt, run } = ingest('2026-09-09');
    const result = await run;
    expect(result).toMatchObject({ status: 'ok', videos: 1, units: 3 });
    expect(yt.calls.map((call) => call.resource)).toEqual(['channels', 'playlistItems', 'videos']);
    expect(yt.calls[0]?.params.get('forHandle')).toBe(HANDLE);
    // Only the institutional video was public on 09/09: D is unlisted, E private.
    const rows = await db.select().from(youtubeVideos);
    expect(rows.map((row) => row.videoId)).toEqual(['aaaaaaaaaaa']);
    expect(rows[0]).toMatchObject({
      channelId: CHANNEL,
      title: 'Institucional Wings',
      durationSeconds: 600,
      thumbnailUrl: 'https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg',
      // Ten minutes: longer than any Short, so the Shorts page was not asked.
      isShort: false,
    });
    expect(yt.shortsAsked).toEqual([]);
    const [daily] = await db.select().from(youtubeVideoDaily);
    expect(daily).toMatchObject({ day: '2026-09-09', views: 1000, likes: 10, comments: 2 });

    const [runRow] = await db.select().from(ingestRuns);
    expect(runRow).toMatchObject({ trigger: 'manual_youtube', status: 'ok', since: '2026-09-09' });
    expect(runRow?.youtube).toMatchObject({
      source: 'client_record',
      channelId: CHANNEL,
      channelTitle: 'Wings Company',
      listed: 3,
      videos: 1,
      truncated: false,
      calls: { channels: 1, playlistItems: 1, videos: 1 },
      units: 3,
    });
    expect(JSON.stringify(runRow)).not.toContain(KEY);
  });

  it('writes nothing when a call fails halfway, and records the code', async () => {
    const before = await db.select().from(youtubeVideoDaily);
    byId('aaaaaaaaaaa').views = 999_999;
    const { run } = ingest('2026-09-10', {
      failOn: { resource: 'videos', status: 403, reason: 'quotaExceeded' },
    });
    expect(await run).toMatchObject({ status: 'failed', error: 'quota_exceeded', units: 3 });
    expect(await db.select().from(youtubeVideoDaily)).toEqual(before);
    const failed = await latestIngestRun(db, { kind: 'youtube' });
    expect(failed).toMatchObject({ status: 'failed', error: 'quota_exceeded' });
    await db.delete(ingestRuns).where(eq(ingestRuns.id, failed!.id));
  });

  it('keeps one row per video per day: a second reading the same day replaces the first', async () => {
    byId('aaaaaaaaaaa').views = 1500;
    byId('ccccccccccc').views = 400;
    byId('eeeeeeeeeee').privacy = 'public';
    byId('eeeeeeeeeee').views = 70;
    await ingest('2026-10-02').run;
    byId('aaaaaaaaaaa').views = 1510;
    const { yt, run } = ingest('2026-10-02');
    expect(await run).toMatchObject({ status: 'ok', videos: 3 });
    const rows = await db
      .select()
      .from(youtubeVideoDaily)
      .where(eq(youtubeVideoDaily.day, '2026-10-02'));
    expect(rows).toHaveLength(3);
    const [video] = await db
      .select()
      .from(youtubeVideos)
      .where(eq(youtubeVideos.videoId, 'aaaaaaaaaaa'));
    expect(rows.find((row) => row.videoId === video!.id)?.views).toBe(1510);
    // The same day's Shorts answers are not asked again.
    expect(yt.shortsAsked).toEqual([]);
  });

  it('asks the Shorts page once per video and keeps an unclear answer as unknown', async () => {
    const shorts = await db
      .select({ videoId: youtubeVideos.videoId, isShort: youtubeVideos.isShort })
      .from(youtubeVideos);
    expect(Object.fromEntries(shorts.map((row) => [row.videoId, row.isShort]))).toEqual({
      aaaaaaaaaaa: false,
      ccccccccccc: false,
      eeeeeeeeeee: null,
    });
  });
});

describe('the screen', () => {
  let body: YoutubeChannelResponse;
  const find = (id: string) => body.videos.find((video) => video.id === id) as YoutubeVideoSummary;

  beforeAll(async () => {
    byId('aaaaaaaaaaa').views = 2000;
    byId('bbbbbbbbbbb').views = 300;
    byId('ccccccccccc').views = 900;
    byId('eeeeeeeeeee').views = 100;
    const { yt, run } = ingest('2026-10-09');
    await run;
    // The new Short is asked; E's unclear answer is a week old, so it is asked again.
    expect(yt.shortsAsked.sort()).toEqual(['bbbbbbbbbbb', 'eeeeeeeeeee']);
    body = await youtubeChannelView(db, env, at('2026-10-09'));
  });

  it('lists the newest reading by views, with the Short flag and the counters', () => {
    expect(body.gap).toBeNull();
    expect(body.configured).toEqual({ key: true, source: 'client_record' });
    expect(body.channel).toEqual({ id: CHANNEL, title: 'Wings Company' });
    expect(body.history).toEqual({ firstDay: '2026-09-09', lastDay: '2026-10-09', days: 3 });
    expect(body.videos.map((video) => video.id)).toEqual([
      'aaaaaaaaaaa',
      'ccccccccccc',
      'bbbbbbbbbbb',
      'eeeeeeeeeee',
    ]);
    expect(find('bbbbbbbbbbb')).toMatchObject({ isShort: true, durationSeconds: 30, views: 300 });
    expect(find('eeeeeeeeeee')).toMatchObject({ isShort: null, likes: null, comments: null });
    expect(find('aaaaaaaaaaa').link).toBe('https://www.youtube.com/watch?v=aaaaaaaaaaa');
  });

  it('measures growth only against the exact day', () => {
    expect(find('aaaaaaaaaaa').growth).toEqual({
      7: { value: 490, fromDay: '2026-10-02' },
      30: { value: 1000, fromDay: '2026-09-09' },
    });
    // Published after 09/09: its views on that day were zero by definition.
    expect(find('ccccccccccc').growth).toEqual({
      7: { value: 500, fromDay: '2026-10-02' },
      30: { value: 900, fromDay: '2026-09-09' },
    });
    expect(find('bbbbbbbbbbb').growth).toEqual({
      7: { value: 300, fromDay: '2026-10-02' },
      30: { value: 300, fromDay: '2026-09-09' },
    });
    // Old, but public only since 02/10: nothing is known of 09/09.
    expect(find('eeeeeeeeeee').growth).toEqual({
      7: { value: 30, fromDay: '2026-10-02' },
      30: { value: null, gap: 'history_short', fromDay: '2026-09-09' },
    });
  });

  it('says a day is missing instead of measuring against another one', async () => {
    const [video] = await db
      .select()
      .from(youtubeVideos)
      .where(eq(youtubeVideos.videoId, 'aaaaaaaaaaa'));
    const [removed] = await db
      .delete(youtubeVideoDaily)
      .where(and(eq(youtubeVideoDaily.videoId, video!.id), eq(youtubeVideoDaily.day, '2026-10-02')))
      .returning();
    const view = await youtubeChannelView(db, env, at('2026-10-09'));
    expect(view.videos.find((item) => item.id === 'aaaaaaaaaaa')?.growth[7]).toEqual({
      value: null,
      gap: 'missing_day',
      fromDay: '2026-10-02',
    });
    await db.insert(youtubeVideoDaily).values(removed!);
  });

  it('keeps the YouTube runs out of the ads ingestion status', async () => {
    expect(await latestIngestRun(db, { kind: 'full' })).toBeNull();
    expect(await latestIngestRun(db, { kind: 'reconcile' })).toBeNull();
    expect((await latestIngestRun(db, { kind: 'youtube' }))?.status).toBe('ok');
  });

  it('says why there is nothing: no key, no channel, never ran', async () => {
    const noKey = await youtubeChannelView(db, { ...env, YOUTUBE_API_KEY: undefined });
    expect(noKey).toMatchObject({ gap: 'no_key', nextRunAt: null });
    // The data already read stays visible.
    expect(noKey.videos).toHaveLength(4);

    await setLink('https://www.youtube.com/c/Wings');
    expect((await youtubeChannelView(db, env)).gap).toBe('bad_link');
    await setLink(null);
    expect((await youtubeChannelView(db, env)).gap).toBe('no_channel');
    await setLink(`https://www.youtube.com/${HANDLE}`);

    const fresh = await createTestDatabase();
    try {
      const empty = await youtubeChannelView(fresh.db, { ...env, YOUTUBE_CHANNEL_ID: CHANNEL });
      expect(empty).toMatchObject({
        gap: 'never_ran',
        configured: { key: true, source: 'env' },
        lastRun: null,
        history: null,
        videos: [],
      });
      // 07:00 São Paulo by default.
      expect(new Date(empty.nextRunAt!).toISOString().slice(11, 16)).toBe('10:00');
    } finally {
      await fresh.drop();
    }
  });

  it('shows a failed newest run without losing the last good reading', async () => {
    await ingest('2026-10-10', {
      failOn: { resource: 'channels', status: 400, reason: 'keyInvalid' },
    }).run;
    const view = await youtubeChannelView(db, env, at('2026-10-10'));
    expect(view.lastRun).toMatchObject({ status: 'failed', error: 'key_invalid' });
    expect(view.history?.lastDay).toBe('2026-10-09');
    expect(view.videos).toHaveLength(4);
  });
});

describe('GET /marketing/youtube/videos', () => {
  it('serves the screen from the tables, never the key, to whoever reads ads', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/marketing/youtube/videos',
      cookies: await session('marketing'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(KEY);
    const body = response.json<YoutubeChannelResponse>();
    expect(body.videos[0]?.id).toBe('aaaaaaaaaaa');
    expect(body.configured.key).toBe(true);
  });

  it('keeps out who cannot read ads, and anyone without a session', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/marketing/youtube/videos',
      cookies: await session('vendedor_expansao'),
    });
    expect(denied.statusCode).toBe(403);
    const anonymous = await app.inject({ method: 'GET', url: '/marketing/youtube/videos' });
    expect(anonymous.statusCode).toBe(401);
  });
});
