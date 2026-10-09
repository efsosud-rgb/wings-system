import type { YoutubeChannelRef } from '@wings/shared';

/**
 * YouTube Data API v3 client for public data, with an API key.
 *
 * Read-only by construction: every method is a GET on a `list` endpoint, and
 * an API key cannot write to YouTube anyway. The key travels in the query
 * string, as Google documents it, so no URL built here ever reaches an error
 * message, a log or an answer: failures carry a code (`quota_exceeded`,
 * `key_invalid`…) and the HTTP status, nothing else.
 *
 * Quota (10,000 units a day by default): each `list` call costs 1 unit,
 * whatever the parts asked. A run spends 1 (channel) + 1 per 50 uploads
 * (playlistItems) + 1 per 50 videos (videos). The client counts them.
 *
 * The Shorts check is not the Data API: the API does not say whether a video
 * is a Short, so `isShort` asks youtube.com whether `/shorts/<id>` serves it
 * as a Short (its page, canonical on `/shorts/<id>`) or sends it to `/watch`
 * (3xx). Any other answer is "not known".
 */

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const SHORTS_BASE = 'https://www.youtube.com/shorts/';
const DEFAULT_TIMEOUT_MS = 15_000;
/** The Shorts page check is a courtesy request: short timeout, head of the page only. */
const SHORTS_TIMEOUT_MS = 8_000;
const SHORTS_PAGE_MAX_CHARS = 400_000;
/** YouTube's own page size ceiling for playlistItems and videos. */
export const YOUTUBE_PAGE_SIZE = 50;

export interface YoutubeDataConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Epoch ms after which no further call is made (`deadline`), so a run cannot hang on. */
  deadlineAt?: number;
}

export class YoutubeDataError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null,
  ) {
    super(`youtube_data_api: ${code}${status === null ? '' : ` (${status})`}`);
    this.name = 'YoutubeDataError';
  }
}

export interface YoutubeChannelInfo {
  id: string;
  title: string | null;
  /** The playlist holding every upload (`UU…`). */
  uploadsPlaylistId: string;
}

export interface YoutubeVideoInfo {
  id: string;
  title: string;
  publishedAt: string;
  /** contentDetails.duration, ISO 8601. */
  duration: string | null;
  thumbnailUrl: string | null;
  privacyStatus: string | null;
  views: number;
  likes: number | null;
  comments: number | null;
}

export interface YoutubeCalls {
  channels: number;
  playlistItems: number;
  videos: number;
}

/** Google's error reasons, as codes the screen knows. */
function codeOf(status: number, body: unknown): string {
  const error = (body as { error?: { errors?: { reason?: string }[]; details?: unknown[] } })
    ?.error;
  const reasons = [
    ...(error?.errors ?? []).map((item) => item.reason),
    ...((error?.details ?? []) as { reason?: string }[]).map((item) => item?.reason),
  ].filter((reason): reason is string => typeof reason === 'string');
  if (reasons.some((reason) => /quota|rateLimit/i.test(reason))) return 'quota_exceeded';
  if (reasons.some((reason) => /keyInvalid|API_KEY_INVALID|keyExpired/i.test(reason)))
    return 'key_invalid';
  if (reasons.some((reason) => /accessNotConfigured|SERVICE_DISABLED/i.test(reason)))
    return 'api_not_enabled';
  if (status === 400) return 'bad_request';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'channel_not_found';
  if (status === 429) return 'quota_exceeded';
  return 'unavailable';
}

const count = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

export class YoutubeDataClient {
  readonly calls: YoutubeCalls = { channels: 0, playlistItems: 0, videos: 0 };
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: YoutubeDataConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Quota units spent so far: one per call. */
  get units(): number {
    return this.calls.channels + this.calls.playlistItems + this.calls.videos;
  }

  private async get(
    resource: keyof YoutubeCalls,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    if (this.config.deadlineAt !== undefined && Date.now() > this.config.deadlineAt) {
      throw new YoutubeDataError('deadline', null);
    }
    const query = new URLSearchParams({ ...params, key: this.config.apiKey });
    this.calls[resource] += 1;
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}/${resource}?${query}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new YoutubeDataError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable',
        null,
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new YoutubeDataError(codeOf(response.status, body), response.status);
    if (!body || typeof body !== 'object') throw new YoutubeDataError('bad_response', null);
    return body as Record<string, unknown>;
  }

  /** The channel a ref names, with its uploads playlist; null when YouTube knows no such channel. */
  async channel(ref: YoutubeChannelRef): Promise<YoutubeChannelInfo | null> {
    const body = await this.get('channels', {
      part: 'snippet,contentDetails',
      ...(ref.kind === 'id' ? { id: ref.id } : { forHandle: ref.handle }),
    });
    const item = (body.items as Record<string, unknown>[] | undefined)?.[0];
    if (!item) return null;
    const id = typeof item.id === 'string' ? item.id : null;
    const uploads = (
      item.contentDetails as { relatedPlaylists?: { uploads?: unknown } } | undefined
    )?.relatedPlaylists?.uploads;
    if (!id || typeof uploads !== 'string') throw new YoutubeDataError('bad_response', null);
    const title = (item.snippet as { title?: unknown } | undefined)?.title;
    return { id, title: typeof title === 'string' ? title : null, uploadsPlaylistId: uploads };
  }

  /** Every video id in a playlist, newest first, up to `maxPages` pages of 50. */
  async playlistVideoIds(
    playlistId: string,
    maxPages: number,
  ): Promise<{ ids: string[]; truncated: boolean }> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const body = await this.get('playlistItems', {
        part: 'contentDetails',
        playlistId,
        maxResults: String(YOUTUBE_PAGE_SIZE),
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of (body.items as Record<string, unknown>[] | undefined) ?? []) {
        const id = (item.contentDetails as { videoId?: unknown } | undefined)?.videoId;
        if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
      }
      pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : undefined;
      if (!pageToken) return { ids, truncated: false };
    }
    return { ids, truncated: true };
  }

  /** Details and public counters of up to 50 videos at a time, in as many calls as needed. */
  async videos(ids: string[]): Promise<YoutubeVideoInfo[]> {
    const out: YoutubeVideoInfo[] = [];
    for (let start = 0; start < ids.length; start += YOUTUBE_PAGE_SIZE) {
      const batch = ids.slice(start, start + YOUTUBE_PAGE_SIZE);
      const body = await this.get('videos', {
        part: 'snippet,contentDetails,statistics,status',
        id: batch.join(','),
        maxResults: String(YOUTUBE_PAGE_SIZE),
      });
      for (const item of (body.items as Record<string, unknown>[] | undefined) ?? []) {
        const snippet = (item.snippet ?? {}) as {
          title?: unknown;
          publishedAt?: unknown;
          thumbnails?: Record<string, { url?: unknown } | undefined>;
        };
        const statistics = (item.statistics ?? {}) as Record<string, unknown>;
        const views = count(statistics.viewCount);
        if (
          typeof item.id !== 'string' ||
          typeof snippet.title !== 'string' ||
          typeof snippet.publishedAt !== 'string' ||
          Number.isNaN(Date.parse(snippet.publishedAt)) ||
          views === null
        ) {
          throw new YoutubeDataError('bad_response', null);
        }
        const thumbnail = ['medium', 'high', 'default']
          .map((size) => snippet.thumbnails?.[size]?.url)
          .find((url): url is string => typeof url === 'string' && url.startsWith('https://'));
        const duration = (item.contentDetails as { duration?: unknown } | undefined)?.duration;
        const privacy = (item.status as { privacyStatus?: unknown } | undefined)?.privacyStatus;
        out.push({
          id: item.id,
          title: snippet.title,
          publishedAt: snippet.publishedAt,
          duration: typeof duration === 'string' ? duration : null,
          thumbnailUrl: thumbnail ?? null,
          privacyStatus: typeof privacy === 'string' ? privacy : null,
          views,
          likes: count(statistics.likeCount),
          comments: count(statistics.commentCount),
        });
      }
    }
    return out;
  }

  /** Whether the run's deadline has passed: no further request of any kind should be made. */
  get pastDeadline(): boolean {
    return this.config.deadlineAt !== undefined && Date.now() > this.config.deadlineAt;
  }

  /**
   * Whether youtube.com serves the video as a Short. `/shorts/<id>` answers
   * a regular video with a redirect to `/watch` (false); it answers a Short
   * with its page, which is taken as true only when the page names itself as
   * that Short (`rel="canonical"` on `/shorts/<id>`), so a consent or
   * bot-check page answered with 200 is not mistaken for one. Anything else
   * is null. Not a Data API call (no quota, no key sent).
   */
  async isShort(videoId: string): Promise<boolean | null> {
    try {
      const response = await this.fetchImpl(`${SHORTS_BASE}${encodeURIComponent(videoId)}`, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html' },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, SHORTS_TIMEOUT_MS)),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location') ?? '';
        return /^(https:\/\/(www\.)?youtube\.com)?\/watch\?/.test(location) ? false : null;
      }
      if (response.status !== 200) return null;
      const page = (await response.text()).slice(0, SHORTS_PAGE_MAX_CHARS);
      const canonical = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(page)?.[1];
      return canonical === `https://www.youtube.com/shorts/${videoId}` ? true : null;
    } catch {
      return null;
    }
  }
}
