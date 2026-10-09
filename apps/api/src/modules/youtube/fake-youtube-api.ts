/**
 * A scripted YouTube for the tests: the three Data API `list` endpoints the
 * ingestion uses and the Shorts page. Nothing here reaches the network; the
 * test network guard would refuse it anyway.
 */

export interface FakeYoutubeVideo {
  id: string;
  title: string;
  publishedAt: string;
  /** ISO 8601, as contentDetails.duration. */
  duration: string;
  privacy?: 'public' | 'unlisted' | 'private';
  views: number;
  /** Null: the channel hides it (the API leaves the field out). */
  likes?: number | null;
  comments?: number | null;
  /** How youtube.com answers /shorts/<id>: 200, a redirect to /watch, a consent page, or a network error. */
  short?: true | false | 'consent' | 'error';
}

export interface FakeYoutubeOptions {
  key: string;
  channelId: string;
  handle?: string;
  title?: string;
  /** Newest first, as the uploads playlist lists them. */
  videos: FakeYoutubeVideo[];
  /** Makes one endpoint answer an error, e.g. `{ resource: 'videos', status: 403, reason: 'quotaExceeded' }`. */
  failOn?: { resource: string; status: number; reason: string } | null;
}

export interface FakeYoutubeCall {
  resource: string;
  params: URLSearchParams;
}

const API = 'https://www.googleapis.com/youtube/v3/';
const SHORTS = 'https://www.youtube.com/shorts/';
const PAGE = 50;

export function fakeYoutube(options: FakeYoutubeOptions) {
  const calls: FakeYoutubeCall[] = [];
  const shortsAsked: string[] = [];
  const uploads = `UU${options.channelId.slice(2)}`;

  const error = (status: number, reason: string) =>
    Response.json(
      { error: { code: status, message: 'fake', errors: [{ reason, domain: 'youtube' }] } },
      { status },
    );

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(SHORTS)) {
      const id = decodeURIComponent(url.slice(SHORTS.length));
      shortsAsked.push(id);
      if (init?.method !== 'HEAD' || init.redirect !== 'manual')
        return new Response(null, { status: 400 });
      const video = options.videos.find((item) => item.id === id);
      if (video?.short === 'error') throw new TypeError('fetch failed');
      if (video?.short === true) return new Response(null, { status: 200 });
      if (video?.short === 'consent')
        return new Response(null, {
          status: 302,
          headers: { location: 'https://consent.youtube.com/m?continue=x' },
        });
      return new Response(null, {
        status: 303,
        headers: { location: `https://www.youtube.com/watch?v=${id}` },
      });
    }
    if (!url.startsWith(API)) throw new Error(`fake youtube: unexpected ${url}`);
    const parsed = new URL(url);
    const resource = parsed.pathname.split('/').pop() ?? '';
    const params = parsed.searchParams;
    calls.push({ resource, params });
    if ((init?.method ?? 'GET') !== 'GET') return error(400, 'badRequest');
    if (params.get('key') !== options.key) return error(400, 'keyInvalid');
    if (options.failOn?.resource === resource)
      return error(options.failOn.status, options.failOn.reason);

    if (resource === 'channels') {
      const matches =
        params.get('id') === options.channelId ||
        (options.handle !== undefined && params.get('forHandle') === options.handle);
      return Response.json({
        kind: 'youtube#channelListResponse',
        items: matches
          ? [
              {
                id: options.channelId,
                snippet: { title: options.title ?? 'Wings Company' },
                contentDetails: { relatedPlaylists: { likes: '', uploads } },
              },
            ]
          : [],
      });
    }
    if (resource === 'playlistItems') {
      if (params.get('playlistId') !== uploads) return error(404, 'playlistNotFound');
      const start = Number(params.get('pageToken') ?? 0);
      const page = options.videos.slice(start, start + PAGE);
      const next = start + PAGE < options.videos.length ? String(start + PAGE) : undefined;
      return Response.json({
        items: page.map((video) => ({ contentDetails: { videoId: video.id } })),
        ...(next ? { nextPageToken: next } : {}),
      });
    }
    if (resource === 'videos') {
      const ids = (params.get('id') ?? '').split(',');
      if (ids.length > PAGE) return error(400, 'tooManyIds');
      return Response.json({
        items: options.videos
          .filter((video) => ids.includes(video.id))
          .map((video) => ({
            id: video.id,
            snippet: {
              title: video.title,
              publishedAt: video.publishedAt,
              thumbnails: {
                default: { url: `https://i.ytimg.com/vi/${video.id}/default.jpg` },
                medium: { url: `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg` },
              },
            },
            contentDetails: { duration: video.duration },
            status: { privacyStatus: video.privacy ?? 'public' },
            statistics: {
              viewCount: String(video.views),
              ...(video.likes === null ? {} : { likeCount: String(video.likes ?? 0) }),
              ...(video.comments === null ? {} : { commentCount: String(video.comments ?? 0) }),
            },
          })),
      });
    }
    return error(404, 'notFound');
  }) as typeof fetch;

  return { fetch: fetchImpl, calls, shortsAsked };
}
