import { z } from 'zod';
import { normalizeInstagram } from './lead-fields.js';
import { PROSPECT_ENRICHMENT_SOURCE, type InstagramIcpMetrics } from './prospecting.js';

/**
 * Prospecção Instagram, parte 3 (docs/prospeccao/instagram.md §1.3, §6): a company found by the
 * Google search whose Instagram is known gets its business account's numbers from Meta's Business
 * Discovery, and they enter the 0-100 score. Only a company's @ from a Google search goes to Meta,
 * never a commenter's: the API proves it with a ticket it signed on the search's answer.
 */

/** Where the company's @ came from: its own site (saved), or Google's site field (live, not saved). */
export const INSTAGRAM_FROM_GOOGLE_SITE = 'site no Google';
export type ProspectInstagramSource =
  typeof PROSPECT_ENRICHMENT_SOURCE | typeof INSTAGRAM_FROM_GOOGLE_SITE;

/** A search result's known Instagram, with the ticket that lets the screen ask Meta about it. */
export interface ProspectInstagramRef {
  username: string;
  source: ProspectInstagramSource;
  /** When the company's site showed it; null for Google's site field (read now). */
  at: string | null;
  ticket: string;
}

/** Paths of instagram.com that are not a profile ("instagram.com/p/…" is a post). */
const NOT_PROFILE = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'explore',
  'stories',
  'accounts',
  'directory',
  'about',
  'legal',
  'developer',
]);

/** The profile's @ when a site address is `instagram.com/<@>`; null for anything else. */
export function instagramOfWebsite(url: string | null | undefined): string | null {
  const match = /^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(
    (url ?? '').trim(),
  );
  const first = match?.[1]?.toLowerCase();
  if (!first || NOT_PROFILE.has(first)) return null;
  return normalizeInstagram(first);
}

export const INSTAGRAM_DISCOVERY_MAX = 20;

export const instagramDiscoverySchema = z.object({
  items: z
    .array(z.object({ username: z.string().trim().min(1).max(60), ticket: z.string().max(200) }))
    .min(1)
    .max(INSTAGRAM_DISCOVERY_MAX, `No máximo ${INSTAGRAM_DISCOVERY_MAX} por vez`),
});
export type InstagramDiscoveryInput = z.infer<typeof instagramDiscoverySchema>;

/**
 * `encontrada`: a business or creator account. `nao_comercial`: personal, private, age-gated or
 * missing; Meta does not tell them apart (§6.5). `erro`: Meta refused or failed.
 */
export const INSTAGRAM_SNAPSHOT_STATUSES = ['encontrada', 'nao_comercial', 'erro'] as const;
export type InstagramSnapshotStatus = (typeof INSTAGRAM_SNAPSHOT_STATUSES)[number];

/** What the screen shows of one reading. Never a name, bio, site, caption or picture. */
export interface InstagramSnapshotView {
  username: string;
  status: InstagramSnapshotStatus;
  followers: number | null;
  posts: number | null;
  recentMediaRead: number | null;
  avgLikesMilli: number | null;
  avgCommentsMilli: number | null;
  postsLast30d: number | null;
  lastPostAt: string | null;
  source: string;
  fetchedAt: string;
}

export interface InstagramDiscoveryItem {
  username: string;
  /** The reading (from the cache or made now); null when Meta was not asked. */
  snapshot: InstagramSnapshotView | null;
  /** Why there are no numbers, as the screen says it after "—"; null with numbers. */
  reason: string | null;
}

export interface InstagramDiscoveryResponse {
  items: InstagramDiscoveryItem[];
  /** Calls are paused until then (Meta's usage at 80%, or a limit error); null when not paused. */
  holdUntil: string | null;
  usage: { today: number; limit: number };
}

/** "—" and why (§6.5). */
export const INSTAGRAM_DISCOVERY_REASONS = {
  notBusiness: 'a Meta só mostra conta comercial; esta é pessoal, privada ou não existe',
  refused: 'a Meta recusou a consulta',
  failed: 'a Meta não respondeu',
  waiting: 'Instagram em espera',
  dailyLimit: 'limite de consultas do dia',
  notFromSearch: 'este @ não veio da busca do Google',
  invalid: '@ inválido',
} as const;

/**
 * What a Graph error means for Business Discovery. The same codes as the site-form check
 * (worker/lib/instagram-check.ts): 110, 24, subcode 2207013 and 100 "invalid user id" are a
 * username Meta does not show; 10, 190, 200 a refused permission; 4, 17, 32, 613, 80002 a limit.
 */
export type GraphErrorKind = 'not_business' | 'permission' | 'rate_limit' | 'other';

export function graphErrorKindOf(
  error: { code?: unknown; error_subcode?: unknown; message?: unknown } | undefined,
): GraphErrorKind {
  const code = error?.code;
  if (
    code === 110 ||
    code === 24 ||
    error?.error_subcode === 2207013 ||
    (code === 100 && /invalid user id/i.test(String(error?.message ?? '')))
  )
    return 'not_business';
  if (code === 190 || code === 10 || code === 200) return 'permission';
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80002)
    return 'rate_limit';
  return 'other';
}

/** The score's view of a reading: only a business account found has numbers. */
export function instagramMetricsOf(
  snapshot: InstagramSnapshotView | null | undefined,
): InstagramIcpMetrics | null {
  if (!snapshot || snapshot.status !== 'encontrada') return null;
  return {
    followers: snapshot.followers,
    posts: snapshot.posts,
    postsLast30d: snapshot.postsLast30d,
    avgLikesMilli: snapshot.avgLikesMilli,
    avgCommentsMilli: snapshot.avgCommentsMilli,
  };
}
