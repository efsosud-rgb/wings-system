import {
  YOUTUBE_GROWTH_WINDOWS,
  youtubeVideoLink,
  type YoutubeChannelGap,
  type YoutubeChannelResponse,
  type YoutubeGrowth,
  type YoutubeGrowthWindow,
  type YoutubeVideoSummary,
} from '@wings/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { youtubeVideoDaily, youtubeVideos } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { nextCronRun } from '../../lib/cron.js';
import { addDays, dayIn, SAO_PAULO } from '../ads/dashboard/window.js';
import { ABANDONED_AFTER_MS, latestIngestRun } from '../ads/ingest-runs.js';
import { resolveYoutubeChannel } from './ingest.js';
import { youtubeCronOf } from './scheduler.js';

/**
 * Canais próprios → YouTube, and the builder's list of the channel's videos:
 * read from the tables the daily ingestion keeps. Calls no Google service.
 *
 * A growth figure is the newest reading minus the reading of exactly N days
 * before. When that reading does not exist the figure is null with the
 * reason; the one exception is a video published after that day, whose views
 * on it were zero by definition.
 */

interface RunYoutube {
  channelId?: string | null;
  channelTitle?: string | null;
  videos?: number;
}

/** End of a São Paulo calendar day, as an instant. */
const endOfDay = (day: string) => new Date(`${day}T23:59:59.999-03:00`);

export async function youtubeChannelView(
  db: Database,
  env: Env,
  now = new Date(),
): Promise<YoutubeChannelResponse> {
  const hasKey = Boolean(env.YOUTUBE_API_KEY);
  const [resolution, lastRun, lastOk] = await Promise.all([
    resolveYoutubeChannel(db, env.YOUTUBE_CHANNEL_ID),
    latestIngestRun(db, { kind: 'youtube' }),
    latestIngestRun(db, { kind: 'youtube', status: 'ok' }),
  ]);

  let gap: YoutubeChannelGap | null = null;
  if (!hasKey) gap = 'no_key';
  else if (!resolution.ref) gap = resolution.gap;
  else if (!lastOk) gap = 'never_ran';

  const abandoned =
    lastRun?.status === 'running' &&
    now.getTime() - lastRun.startedAt.getTime() > ABANDONED_AFTER_MS.youtube;
  const okRun = (lastOk?.youtube ?? null) as RunYoutube | null;
  const channelId = okRun?.channelId ?? null;

  const base: YoutubeChannelResponse = {
    configured: { key: hasKey, source: resolution.ref ? resolution.source : null },
    gap,
    channel: channelId ? { id: channelId, title: okRun?.channelTitle ?? null } : null,
    lastRun: lastRun
      ? {
          startedAt: lastRun.startedAt.toISOString(),
          status: abandoned ? 'failed' : (lastRun.status as 'running' | 'ok' | 'failed'),
          error: abandoned ? 'interrupted' : lastRun.error,
        }
      : null,
    nextRunAt: hasKey
      ? (nextCronRun(youtubeCronOf(env.YOUTUBE_INGEST_CRON), now, SAO_PAULO)?.toISOString() ?? null)
      : null,
    history: null,
    videos: [],
  };
  if (!lastOk || !channelId || okRun?.videos === 0) return base;

  // The videos of the newest complete reading: a run writes all its videos
  // at once, so they share its instant.
  const [seen] = await db
    .select({ at: sql<Date | null>`max(${youtubeVideos.lastSeenAt})` })
    .from(youtubeVideos)
    .where(eq(youtubeVideos.channelId, channelId));
  if (!seen?.at) return base;
  const seenAt = new Date(seen.at);
  const latestDay = dayIn(seenAt);

  const videos = await db
    .select()
    .from(youtubeVideos)
    .where(and(eq(youtubeVideos.channelId, channelId), eq(youtubeVideos.lastSeenAt, seenAt)));
  if (videos.length === 0) return base;
  const ids = videos.map((video) => video.id);

  const wanted = [latestDay, ...YOUTUBE_GROWTH_WINDOWS.map((days) => addDays(latestDay, -days))];
  const [rows, firsts, [span]] = await Promise.all([
    db
      .select()
      .from(youtubeVideoDaily)
      .where(and(inArray(youtubeVideoDaily.videoId, ids), inArray(youtubeVideoDaily.day, wanted))),
    db
      .select({
        videoId: youtubeVideoDaily.videoId,
        first: sql<string>`min(${youtubeVideoDaily.day})::text`,
      })
      .from(youtubeVideoDaily)
      .where(inArray(youtubeVideoDaily.videoId, ids))
      .groupBy(youtubeVideoDaily.videoId),
    db
      .select({
        first: sql<string | null>`min(${youtubeVideoDaily.day})::text`,
        days: sql<string>`count(distinct ${youtubeVideoDaily.day})`,
      })
      .from(youtubeVideoDaily)
      .where(inArray(youtubeVideoDaily.videoId, ids)),
  ]);
  const reading = new Map(rows.map((row) => [`${row.videoId}|${row.day}`, row]));
  const firstDay = new Map(firsts.map((row) => [row.videoId, row.first]));

  const summaries: YoutubeVideoSummary[] = [];
  for (const video of videos) {
    const latest = reading.get(`${video.id}|${latestDay}`);
    if (!latest) continue;
    const growth = {} as Record<YoutubeGrowthWindow, YoutubeGrowth>;
    for (const days of YOUTUBE_GROWTH_WINDOWS) {
      const fromDay = addDays(latestDay, -days);
      const then = reading.get(`${video.id}|${fromDay}`);
      if (then) growth[days] = { value: latest.views - then.views, fromDay };
      else if (video.publishedAt.getTime() > endOfDay(fromDay).getTime())
        growth[days] = { value: latest.views, fromDay };
      else
        growth[days] = {
          value: null,
          fromDay,
          gap: (firstDay.get(video.id) ?? latestDay) > fromDay ? 'history_short' : 'missing_day',
        };
    }
    summaries.push({
      id: video.videoId,
      title: video.title,
      publishedAt: video.publishedAt.toISOString(),
      durationSeconds: video.durationSeconds,
      thumbnailUrl: video.thumbnailUrl,
      isShort: video.isShort,
      views: latest.views,
      likes: latest.likes,
      comments: latest.comments,
      growth,
      link: youtubeVideoLink(video.videoId),
    });
  }
  summaries.sort((a, b) => b.views - a.views || b.publishedAt.localeCompare(a.publishedAt));

  return {
    ...base,
    history: span?.first
      ? { firstDay: span.first, lastDay: latestDay, days: Number(span.days) }
      : null,
    videos: summaries,
  };
}
