import { describe, expect, it } from 'vitest';
import { fakeYoutube, type FakeYoutubeVideo } from '../modules/youtube/fake-youtube-api.js';
import { YoutubeDataClient, YoutubeDataError } from './youtube-data.js';

/**
 * The read-only YouTube Data API client against a scripted YouTube: quota is
 * counted per call, pages and batches of 50 are followed, errors come back as
 * codes and never carry the key or the URL.
 */

const KEY = 'test-youtube-key-never-printed';
const CHANNEL = 'UCabcdefghijklmnopqrstuv';

const many = (count: number): FakeYoutubeVideo[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `vid${String(index).padStart(8, '0')}`,
    title: `Vídeo ${index}`,
    publishedAt: '2026-09-01T12:00:00Z',
    duration: 'PT2M',
    views: index,
  }));

describe('YoutubeDataClient', () => {
  it('finds the channel by id or by handle, and returns null for an unknown one', async () => {
    const yt = fakeYoutube({ key: KEY, channelId: CHANNEL, handle: '@wingscompany', videos: [] });
    const client = new YoutubeDataClient({ apiKey: KEY, fetchImpl: yt.fetch });
    expect(await client.channel({ kind: 'id', id: CHANNEL })).toEqual({
      id: CHANNEL,
      title: 'Wings Company',
      uploadsPlaylistId: `UU${CHANNEL.slice(2)}`,
    });
    expect((await client.channel({ kind: 'handle', handle: '@wingscompany' }))?.id).toBe(CHANNEL);
    expect(await client.channel({ kind: 'handle', handle: '@other' })).toBeNull();
    expect(yt.calls.map((call) => call.params.get('part'))).toEqual([
      'snippet,contentDetails',
      'snippet,contentDetails',
      'snippet,contentDetails',
    ]);
    expect(client.units).toBe(3);
  });

  it('follows the uploads pages and batches the videos by 50, one unit per call', async () => {
    const yt = fakeYoutube({ key: KEY, channelId: CHANNEL, videos: many(120) });
    const client = new YoutubeDataClient({ apiKey: KEY, fetchImpl: yt.fetch });
    const uploads = await client.playlistVideoIds(`UU${CHANNEL.slice(2)}`, 20);
    expect(uploads.ids).toHaveLength(120);
    expect(uploads.truncated).toBe(false);
    const videos = await client.videos(uploads.ids);
    expect(videos).toHaveLength(120);
    expect(client.calls).toEqual({ channels: 0, playlistItems: 3, videos: 3 });
    expect(client.units).toBe(6);
    expect(
      yt.calls
        .filter((call) => call.resource === 'videos')
        .map((call) => call.params.get('id')?.split(',').length),
    ).toEqual([50, 50, 20]);
    expect(videos[7]).toMatchObject({
      id: 'vid00000007',
      title: 'Vídeo 7',
      duration: 'PT2M',
      thumbnailUrl: 'https://i.ytimg.com/vi/vid00000007/mqdefault.jpg',
      privacyStatus: 'public',
      views: 7,
      likes: 0,
      comments: 0,
    });
  });

  it('stops at the page ceiling and says the list was cut', async () => {
    const yt = fakeYoutube({ key: KEY, channelId: CHANNEL, videos: many(120) });
    const client = new YoutubeDataClient({ apiKey: KEY, fetchImpl: yt.fetch });
    const uploads = await client.playlistVideoIds(`UU${CHANNEL.slice(2)}`, 2);
    expect(uploads).toMatchObject({ truncated: true });
    expect(uploads.ids).toHaveLength(100);
  });

  it('reads hidden likes and disabled comments as null, not zero', async () => {
    const yt = fakeYoutube({
      key: KEY,
      channelId: CHANNEL,
      videos: [{ ...many(1)[0]!, likes: null, comments: null }],
    });
    const [video] = await new YoutubeDataClient({ apiKey: KEY, fetchImpl: yt.fetch }).videos([
      'vid00000000',
    ]);
    expect(video).toMatchObject({ likes: null, comments: null, views: 0 });
  });

  it('turns failures into codes that carry neither the key nor the address', async () => {
    const cases: [{ resource: string; status: number; reason: string } | null, string, string][] = [
      [{ resource: 'channels', status: 403, reason: 'quotaExceeded' }, KEY, 'quota_exceeded'],
      [
        { resource: 'channels', status: 403, reason: 'accessNotConfigured' },
        KEY,
        'api_not_enabled',
      ],
      [{ resource: 'channels', status: 403, reason: 'forbidden' }, KEY, 'forbidden'],
      [{ resource: 'channels', status: 500, reason: 'backendError' }, KEY, 'unavailable'],
      [null, 'wrong-key', 'key_invalid'],
    ];
    for (const [failOn, key, code] of cases) {
      const yt = fakeYoutube({ key: KEY, channelId: CHANNEL, videos: [], failOn });
      const client = new YoutubeDataClient({ apiKey: key, fetchImpl: yt.fetch });
      const error = await client.channel({ kind: 'id', id: CHANNEL }).catch((caught) => caught);
      expect(error).toBeInstanceOf(YoutubeDataError);
      expect((error as YoutubeDataError).code).toBe(code);
      expect(String((error as Error).message)).not.toContain(key);
      expect(String((error as Error).message)).not.toContain('googleapis');
    }
  });

  it('reports a timeout, a dropped connection and an unreadable answer as codes', async () => {
    const hang = (async (_input: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const slow = new YoutubeDataClient({ apiKey: KEY, fetchImpl: hang, timeoutMs: 20 });
    await expect(slow.channel({ kind: 'id', id: CHANNEL })).rejects.toMatchObject({
      code: 'timeout',
    });

    const dropped = new YoutubeDataClient({
      apiKey: KEY,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(dropped.channel({ kind: 'id', id: CHANNEL })).rejects.toMatchObject({
      code: 'unavailable',
    });

    const html = new YoutubeDataClient({
      apiKey: KEY,
      fetchImpl: (async () => new Response('<html>', { status: 200 })) as typeof fetch,
    });
    await expect(html.channel({ kind: 'id', id: CHANNEL })).rejects.toMatchObject({
      code: 'bad_response',
    });

    const odd = new YoutubeDataClient({
      apiKey: KEY,
      fetchImpl: (async () =>
        Response.json({
          items: [{ id: 'x', snippet: { title: 1 }, statistics: {} }],
        })) as typeof fetch,
    });
    await expect(odd.videos(['x'])).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('makes no call after the run deadline', async () => {
    const yt = fakeYoutube({ key: KEY, channelId: CHANNEL, videos: [] });
    const client = new YoutubeDataClient({
      apiKey: KEY,
      fetchImpl: yt.fetch,
      deadlineAt: Date.now() - 1,
    });
    await expect(client.channel({ kind: 'id', id: CHANNEL })).rejects.toMatchObject({
      code: 'deadline',
    });
    expect(yt.calls).toHaveLength(0);
  });

  it('tells a Short only from a clear answer of the Shorts page, without the key', async () => {
    const base = many(1)[0]!;
    const yt = fakeYoutube({
      key: KEY,
      channelId: CHANNEL,
      videos: [
        { ...base, id: 'short000001', short: true },
        { ...base, id: 'long0000001', short: false },
        { ...base, id: 'consent0001', short: 'consent' },
        { ...base, id: 'botcheck001', short: 'bot' },
        { ...base, id: 'error000001', short: 'error' },
      ],
    });
    const client = new YoutubeDataClient({ apiKey: KEY, fetchImpl: yt.fetch });
    expect(await client.isShort('short000001')).toBe(true);
    expect(await client.isShort('long0000001')).toBe(false);
    expect(await client.isShort('consent0001')).toBeNull();
    // A 200 that is not the Short's own page (consent, bot check) is not taken for one.
    expect(await client.isShort('botcheck001')).toBeNull();
    expect(await client.isShort('error000001')).toBeNull();
    expect(yt.shortsAsked).toHaveLength(5);
    expect(client.units).toBe(0);
  });
});
