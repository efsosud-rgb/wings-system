/**
 * Canais próprios on the marketing dashboard: what Wings publishes on its own
 * channels, read from a mirror the ingest job keeps. Opening the tab calls no
 * site. The blog (WordPress) is the first channel; social publishing arrives
 * later in the same shape, so the screen already has a place for it.
 */

export interface BlogPostSummary {
  /** WordPress post id. */
  id: number;
  title: string;
  /** ISO instant of publication, as the site reports it. */
  publishedAt: string;
  modifiedAt: string | null;
  /** Category names, resolved when mirrored. */
  categories: string[];
  link: string;
}

export interface OwnedChannelsResponse {
  /** Days back from today (São Paulo) the posts cover. */
  days: number;
  since: string;
  until: string;
  blog: {
    /** False when the server has no WordPress credentials. */
    configured: boolean;
    /** When the mirror was last refreshed; null when never. */
    syncedAt: string | null;
    posts: BlogPostSummary[];
    /** Posts in the mirror overall, so an empty period is not mistaken for an empty mirror. */
    mirrored: number;
  };
  /** Not there yet: the screen shows the placeholder. */
  social: null;
}

export const OWNED_CHANNEL_WINDOWS = [7, 14, 30, 90] as const;
