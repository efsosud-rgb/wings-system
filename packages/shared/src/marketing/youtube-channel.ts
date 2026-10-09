/**
 * Wings' YouTube channel, read through the YouTube Data API v3 by the daily
 * ingestion and kept in two tables: one row per video (title, publication,
 * duration, thumbnail, Short) and one row per video per day with the public
 * counters as read that day. Opening the screen calls no Google service.
 *
 * Nothing here is estimated: a growth figure exists only when the reading of
 * the exact day it starts from exists (or the video did not exist yet, when
 * its views were zero by definition); otherwise the screen says why not.
 */

/** Days back the growth columns measure, newest reading against the reading of that many days before. */
export const YOUTUBE_GROWTH_WINDOWS = [7, 30] as const;
export type YoutubeGrowthWindow = (typeof YOUTUBE_GROWTH_WINDOWS)[number];

/** Where the channel id came from. */
export type YoutubeChannelSource = 'client_record' | 'env';

/** A channel as a link names it: by id (`UC…`) or by handle (`@nome`). */
export type YoutubeChannelRef = { kind: 'id'; id: string } | { kind: 'handle'; handle: string };

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;

/**
 * The channel a link or a bare value names: `https://www.youtube.com/channel/UC…`,
 * `https://www.youtube.com/@nome`, `UC…` or `@nome`. Anything else (a video
 * link, `/c/…` or `/user/…`, which the API cannot resolve) is null.
 */
export function parseYoutubeChannelRef(value: string | null | undefined): YoutubeChannelRef | null {
  const text = value?.trim() ?? '';
  if (!text) return null;
  if (CHANNEL_ID.test(text)) return { kind: 'id', id: text };
  if (HANDLE.test(text)) return { kind: 'handle', handle: text };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/^(www\.|m\.)?youtube\.com$/i.test(url.hostname)) return null;
  const [first, second] = url.pathname.split('/').filter(Boolean);
  if (first === 'channel' && second && CHANNEL_ID.test(second)) return { kind: 'id', id: second };
  if (first && HANDLE.test(decodeURIComponent(first))) {
    return { kind: 'handle', handle: decodeURIComponent(first) };
  }
  return null;
}

/**
 * `PT1H2M3S` → 3723. Null for anything that is not a plain ISO 8601 duration
 * (a live broadcast reports `P0D`, which is 0).
 */
export function isoDurationSeconds(value: string | null | undefined): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value ?? '');
  if (!match || value === 'P' || value === 'PT') return null;
  const [, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0));
  return (days ?? 0) * 86_400 + (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0);
}

/** Why a growth figure is missing. */
export type YoutubeGrowthGap =
  /** The history starts after the day the window would start from. */
  | 'history_short'
  /** The history covers that day, but no reading was taken on it (a run failed or was skipped). */
  | 'missing_day';

export type YoutubeGrowth =
  { value: number; fromDay: string } | { value: null; gap: YoutubeGrowthGap; fromDay: string };

export interface YoutubeVideoSummary {
  /** The 11-character YouTube video id. */
  id: string;
  title: string;
  /** ISO instant. */
  publishedAt: string;
  /** Null when the API reported no usable duration. */
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  /** Null when it could not be told (see the docs); never guessed from the duration. */
  isShort: boolean | null;
  /** Counters of the newest reading. Likes or comments are null when the channel hides them. */
  views: number;
  likes: number | null;
  comments: number | null;
  /** Views gained, keyed by window: `{ 7: …, 30: … }`. */
  growth: Record<YoutubeGrowthWindow, YoutubeGrowth>;
  link: string;
}

/** Why the block has nothing to show, in order of precedence. */
export type YoutubeChannelGap =
  /** YOUTUBE_API_KEY is not set in this environment. */
  | 'no_key'
  /** Neither the client record's YouTube link nor YOUTUBE_CHANNEL_ID names a channel. */
  | 'no_channel'
  /** The client record has a YouTube link that names no channel. */
  | 'bad_link'
  /** Configured, but no run has finished yet. */
  | 'never_ran';

export interface YoutubeIngestRunSummary {
  startedAt: string;
  status: 'running' | 'ok' | 'failed';
  /** A code (`quota_exceeded`, `key_invalid`…), never a message from the platform. */
  error: string | null;
}

export interface YoutubeChannelResponse {
  configured: { key: boolean; source: YoutubeChannelSource | null };
  gap: YoutubeChannelGap | null;
  channel: { id: string; title: string | null } | null;
  /** The newest run of the YouTube ingestion, whatever its outcome. */
  lastRun: YoutubeIngestRunSummary | null;
  /** When the next scheduled run is due (YOUTUBE_INGEST_CRON); null without a key. */
  nextRunAt: string | null;
  /** The days the history covers (São Paulo calendar); null before the first reading. */
  history: { firstDay: string; lastDay: string; days: number } | null;
  /** The videos the newest reading saw, by views (most first). */
  videos: YoutubeVideoSummary[];
}

/** The screen's words for a run's error code. */
export const YOUTUBE_INGEST_ERROR_LABEL: Record<string, string> = {
  no_channel: 'nenhum canal configurado',
  bad_link: 'o link do YouTube na ficha da Wings Company não aponta para um canal',
  channel_not_found: 'o canal não foi encontrado no YouTube',
  key_invalid: 'a chave da YouTube Data API foi recusada',
  api_not_enabled: 'a YouTube Data API não está ativada no projeto da chave',
  quota_exceeded: 'a quota diária da YouTube Data API acabou',
  forbidden: 'o YouTube recusou o acesso',
  bad_request: 'o YouTube recusou o pedido',
  unavailable: 'o YouTube não respondeu',
  timeout: 'o YouTube demorou demais para responder',
  bad_response: 'o YouTube respondeu num formato inesperado',
  interrupted: 'a execução foi interrompida',
  deadline: 'a execução passou do tempo limite',
};

export const youtubeVideoLink = (id: string) => `https://www.youtube.com/watch?v=${id}`;
