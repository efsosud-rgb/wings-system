import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';

/**
 * Wings' YouTube channel, as the daily ingestion reads it through the YouTube
 * Data API v3 (public data only, an API key, no account access). Dimensional
 * like the ads tables: one row per video, and one row per video per day with
 * the counters as read that day. No personal data: titles and public counts.
 */

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/** One public video of the channel. Kept when it leaves the channel, so its history stays. */
export const youtubeVideos = pgTable(
  'youtube_videos',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** The `UC…` id of the channel it was read from. */
    channelId: text('channel_id').notNull(),
    /** YouTube's 11-character video id. */
    videoId: text('video_id').notNull(),
    title: text('title').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    /** From contentDetails.duration; null when the API gave nothing usable. */
    durationSeconds: integer('duration_seconds'),
    thumbnailUrl: text('thumbnail_url'),
    /**
     * Whether youtube.com serves it as a Short: true or false only when the
     * Shorts page answered clearly, null otherwise. Never guessed from the
     * duration or the shape.
     */
    isShort: boolean('is_short'),
    shortCheckedAt: timestamp('short_checked_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** The start of the newest run that listed it; the screen shows the videos of the newest run. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('youtube_videos_video_uq').on(table.tenantId, table.videoId),
    index('youtube_videos_channel_seen_idx').on(table.channelId, table.lastSeenAt),
  ],
);

/**
 * A video's public counters on one São Paulo day. Upserted: a second run on
 * the same day replaces the first reading, like `ad_metrics_daily`. The
 * counters are lifetime totals as YouTube reports them; growth is the
 * difference between two days' rows, computed when read and never stored.
 */
export const youtubeVideoDaily = pgTable(
  'youtube_video_daily',
  {
    tenantId: tenantId(),
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    videoId: uuid('video_id')
      .notNull()
      .references(() => youtubeVideos.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    views: bigint('views', { mode: 'number' }).notNull(),
    /** Null when the channel hides the count. */
    likes: bigint('likes', { mode: 'number' }),
    /** Null when comments are off. */
    comments: bigint('comments', { mode: 'number' }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('youtube_video_daily_video_day_uq').on(table.videoId, table.day),
    index('youtube_video_daily_day_idx').on(table.day),
  ],
);
