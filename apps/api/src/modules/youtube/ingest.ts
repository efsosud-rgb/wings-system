import {
  isoDurationSeconds,
  parseYoutubeChannelRef,
  WINGS_CLIENT_ID,
  type YoutubeChannelRef,
  type YoutubeChannelSource,
} from '@wings/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clients, youtubeVideoDaily, youtubeVideos } from '../../db/schema/index.js';
import { YoutubeDataClient, YoutubeDataError, type YoutubeCalls } from '../../lib/youtube-data.js';
import { dayIn } from '../ads/dashboard/window.js';
import { finishIngestRun, INGEST_DEADLINE_MS, startIngestRun } from '../ads/ingest-runs.js';

/**
 * The daily reading of Wings' YouTube channel (docs/integracoes/youtube-data-api.md).
 *
 * Reads the channel's public uploads through the YouTube Data API and writes
 * one row per video and one row per video for today (São Paulo): views,
 * likes and comments as YouTube reports them now. Nothing is written until
 * every call of the run has answered, in one transaction, so a run that fails
 * halfway leaves the previous day's picture whole. Every run is a row in
 * `ingest_runs` (`scheduled_youtube` / `manual_youtube`), with the calls and
 * the quota units it spent.
 */

/** Pages of 50 uploads read at most: 1,000 videos, far above Wings' channel. */
export const YOUTUBE_MAX_PAGES = 20;
/** Shorts pages asked per run at most; the rest wait for the next day. */
export const YOUTUBE_SHORTS_CHECKS_PER_RUN = 50;
/** YouTube's ceiling for a Short (3 minutes since 15/10/2024): a longer video is never one. */
export const YOUTUBE_SHORT_MAX_SECONDS = 180;
/** A check that answered nothing clear is asked again after this long. */
const SHORTS_RECHECK_MS = 24 * 3600_000;

export type YoutubeChannelResolution =
  | { ref: YoutubeChannelRef; source: YoutubeChannelSource }
  | { gap: 'no_channel' | 'bad_link'; ref?: undefined };

/**
 * Which channel to read: the YouTube link in the Wings Company client record
 * (Clientes → redes sociais) first, then YOUTUBE_CHANNEL_ID. A record link
 * that names no channel is reported as such, not silently replaced: the
 * variable is used only when the record has no YouTube link at all.
 */
export async function resolveYoutubeChannel(
  db: Database,
  channelEnv: string | undefined,
): Promise<YoutubeChannelResolution> {
  const [row] = await db
    .select({ social: clients.social })
    .from(clients)
    .where(eq(clients.id, WINGS_CLIENT_ID))
    .limit(1);
  const link = row?.social?.youtube?.trim();
  if (link) {
    const ref = parseYoutubeChannelRef(link);
    return ref ? { ref, source: 'client_record' } : { gap: 'bad_link' };
  }
  const ref = parseYoutubeChannelRef(channelEnv);
  return ref ? { ref, source: 'env' } : { gap: 'no_channel' };
}

export interface YoutubeIngestDeps {
  db: Database;
  apiKey: string | undefined;
  channelEnv: string | undefined;
  trigger: 'scheduled_youtube' | 'manual_youtube';
  /** Injected in tests; production uses the global fetch. */
  fetchImpl?: typeof fetch;
  now?: Date;
}

export type YoutubeIngestResult =
  | { status: 'skipped'; reason: 'no_key' }
  | { status: 'ok'; runId: string; videos: number; units: number }
  | { status: 'failed'; runId: string; error: string; units: number };

/** What the run row keeps under `youtube`: codes, ids and numbers only. */
interface YoutubeRunRecord {
  source: YoutubeChannelSource | null;
  channelId: string | null;
  channelTitle: string | null;
  listed: number;
  videos: number;
  truncated: boolean;
  calls: YoutubeCalls;
  units: number;
  shorts: { asked: number; byDuration: number; known: number };
}

export async function runYoutubeIngestion(deps: YoutubeIngestDeps): Promise<YoutubeIngestResult> {
  if (!deps.apiKey) return { status: 'skipped', reason: 'no_key' };
  const { db } = deps;
  const now = deps.now ?? new Date();
  const day = dayIn(now);
  const runId = await startIngestRun(db, { trigger: deps.trigger, since: day, now });

  const client = new YoutubeDataClient({
    apiKey: deps.apiKey,
    fetchImpl: deps.fetchImpl,
    // The real clock, not `now` (which a test or a catch-up may set in the past).
    deadlineAt: Date.now() + INGEST_DEADLINE_MS.youtube,
  });
  const record: YoutubeRunRecord = {
    source: null,
    channelId: null,
    channelTitle: null,
    listed: 0,
    videos: 0,
    truncated: false,
    calls: client.calls,
    units: 0,
    shorts: { asked: 0, byDuration: 0, known: 0 },
  };
  const fail = async (error: string): Promise<YoutubeIngestResult> => {
    record.units = client.units;
    await finishIngestRun(db, runId, {
      status: 'failed',
      accounts: [],
      site: null,
      youtube: { ...record },
      error,
    });
    return { status: 'failed', runId, error, units: client.units };
  };

  try {
    const channel = await resolveYoutubeChannel(db, deps.channelEnv);
    if (!channel.ref) return await fail(channel.gap);
    record.source = channel.source;

    const info = await client.channel(channel.ref);
    if (!info) return await fail('channel_not_found');
    record.channelId = info.id;
    record.channelTitle = info.title;

    const uploads = await client.playlistVideoIds(info.uploadsPlaylistId, YOUTUBE_MAX_PAGES);
    record.listed = uploads.ids.length;
    record.truncated = uploads.truncated;
    // The key reads public data only, but the status is checked anyway: an
    // unlisted or private video never enters the tables.
    const videos = (await client.videos(uploads.ids)).filter(
      (video) => video.privacyStatus === 'public',
    );
    record.videos = videos.length;

    await db.transaction(async (tx) => {
      for (const video of videos) {
        const figures = {
          channelId: info.id,
          title: video.title.slice(0, 500),
          publishedAt: new Date(video.publishedAt),
          durationSeconds: isoDurationSeconds(video.duration),
          thumbnailUrl: video.thumbnailUrl,
          lastSeenAt: now,
        };
        const [row] = await tx
          .insert(youtubeVideos)
          .values({ videoId: video.id, firstSeenAt: now, ...figures })
          .onConflictDoUpdate({
            target: [youtubeVideos.tenantId, youtubeVideos.videoId],
            set: figures,
          })
          .returning({ id: youtubeVideos.id });
        if (!row) throw new Error('youtube video upsert returned nothing');
        const counters = {
          views: video.views,
          likes: video.likes,
          comments: video.comments,
          fetchedAt: now,
        };
        await tx
          .insert(youtubeVideoDaily)
          .values({ videoId: row.id, day, ...counters })
          .onConflictDoUpdate({
            target: [youtubeVideoDaily.videoId, youtubeVideoDaily.day],
            set: counters,
          });
      }
    });

    // Non-fatal: the day's figures are already in; an unclassified video stays null.
    record.shorts = await classifyShorts(db, client, info.id, now).catch(() => record.shorts);
    record.units = client.units;
    await finishIngestRun(db, runId, {
      status: 'ok',
      accounts: [],
      site: null,
      youtube: { ...record },
    });
    return { status: 'ok', runId, videos: videos.length, units: client.units };
  } catch (error) {
    if (error instanceof YoutubeDataError) return fail(error.code);
    return fail(error instanceof Error ? `unexpected:${error.name}`.slice(0, 80) : 'unexpected');
  }
}

/**
 * Tells the channel's Shorts apart, once per video. A video longer than
 * YouTube's ceiling for a Short is not one, by YouTube's own rule; the others
 * are asked of youtube.com, up to a limit per run. An unclear answer stays
 * null and is asked again the next day.
 */
async function classifyShorts(
  db: Database,
  client: YoutubeDataClient,
  channelId: string,
  now: Date,
): Promise<YoutubeRunRecord['shorts']> {
  const byDuration = await db
    .update(youtubeVideos)
    .set({ isShort: false, shortCheckedAt: now })
    .where(
      and(
        eq(youtubeVideos.channelId, channelId),
        isNull(youtubeVideos.isShort),
        sql`${youtubeVideos.durationSeconds} > ${YOUTUBE_SHORT_MAX_SECONDS}`,
      ),
    )
    .returning({ id: youtubeVideos.id });

  const pending = await db
    .select({ id: youtubeVideos.id, videoId: youtubeVideos.videoId })
    .from(youtubeVideos)
    .where(
      and(
        eq(youtubeVideos.channelId, channelId),
        isNull(youtubeVideos.isShort),
        eq(youtubeVideos.lastSeenAt, now),
        sql`(${youtubeVideos.shortCheckedAt} is null or ${youtubeVideos.shortCheckedAt} < ${new Date(now.getTime() - SHORTS_RECHECK_MS + 60_000)})`,
      ),
    )
    .orderBy(youtubeVideos.publishedAt)
    .limit(YOUTUBE_SHORTS_CHECKS_PER_RUN);

  let known = 0;
  let asked = 0;
  for (const video of pending) {
    // The run's deadline covers this step too; what is left waits for tomorrow.
    if (client.pastDeadline) break;
    const isShort = await client.isShort(video.videoId);
    asked += 1;
    if (isShort !== null) known += 1;
    await db
      .update(youtubeVideos)
      .set({ isShort, shortCheckedAt: now })
      .where(eq(youtubeVideos.id, video.id));
  }
  return { asked, byDuration: byDuration.length, known };
}
