import { createHmac, timingSafeEqual } from 'node:crypto';
import { graphErrorKindOf } from '@wings/shared';
import { shapeOf } from '../media/kairogen-adapter.js';

/**
 * Meta's Business Discovery for Prospecção Instagram, parte 3 (docs/prospeccao/instagram.md §6.1):
 * numbers of a company's business account and of its recent posts, through Wings' own Instagram
 * business account. It never asks for the name, bio, site, picture, captions or links. The token
 * goes in a header, never in a URL or a log; the log carries the answer's shape only.
 *
 * NOT verified live: the `media` edge's fields and the usage headers follow Meta's reference
 * (§0); the shape log shows the real answer on the first call.
 */

export const GRAPH_API_VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface RecentPost {
  likes: number | null;
  comments: number | null;
  timestamp: string | null;
}

/** How much of Meta's quota is used (0-100, the highest header) and when it comes back. */
export interface GraphUsage {
  pct: number | null;
  regainMinutes: number | null;
}

export type DiscoveryLookup =
  | {
      kind: 'found';
      followers: number | null;
      posts: number | null;
      /** Null when the `media` field did not come at all. */
      media: RecentPost[] | null;
      usage: GraphUsage;
    }
  | { kind: 'not_business'; code: number | null; usage: GraphUsage }
  | {
      kind: 'error';
      wait: 'rate_limit' | 'permission' | null;
      code: number | null;
      usage: GraphUsage;
    };

export interface BusinessDiscoveryClient {
  /** One call, never retried: it counts against Meta's quota even when it fails. */
  lookup(username: string, recentPosts: number): Promise<DiscoveryLookup>;
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

function numbersOf(header: string | null): number[] {
  if (!header) return [];
  try {
    const out: number[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object')
        for (const [key, inner] of Object.entries(value)) {
          if (key === 'type') continue;
          if (key === 'estimated_time_to_regain_access') continue;
          if (typeof inner === 'number') out.push(inner);
          else walk(inner);
        }
    };
    walk(JSON.parse(header));
    return out;
  } catch {
    return [];
  }
}

function regainOf(header: string | null): number | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(header) as Record<string, unknown>;
    const minutes = Object.values(parsed)
      .flatMap((entries) => (Array.isArray(entries) ? entries : []))
      .map((entry) => count((entry as Record<string, unknown>).estimated_time_to_regain_access))
      .filter((m): m is number => m !== null);
    return minutes.length ? Math.max(...minutes) : null;
  } catch {
    return null;
  }
}

/** `X-App-Usage` and `X-Business-Use-Case-Usage`: the highest percentage of either. */
export function usageOfHeaders(headers: { get(name: string): string | null }): GraphUsage {
  const business = headers.get('x-business-use-case-usage');
  const numbers = [...numbersOf(headers.get('x-app-usage')), ...numbersOf(business)];
  return {
    pct: numbers.length ? Math.max(...numbers) : null,
    regainMinutes: regainOf(business),
  };
}

function postsOf(media: unknown): RecentPost[] | null {
  const data = (media as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return null;
  return data.map((post: Record<string, unknown>) => ({
    likes: count(post.like_count),
    comments: count(post.comments_count),
    timestamp:
      typeof post.timestamp === 'string' && !Number.isNaN(Date.parse(post.timestamp))
        ? post.timestamp
        : null,
  }));
}

export function createBusinessDiscoveryClient(config: {
  accountId: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (facts: Record<string, unknown>) => void;
}): BusinessDiscoveryClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    async lookup(username, recentPosts) {
      const fields = `business_discovery.username(${username}){username,followers_count,media_count,media.limit(${recentPosts}){like_count,comments_count,timestamp}}`;
      const url = `${GRAPH}/${encodeURIComponent(config.accountId)}?fields=${encodeURIComponent(fields)}`;
      let status: number;
      let body: Record<string, unknown>;
      let usage: GraphUsage;
      try {
        const response = await fetchImpl(url, {
          headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
          signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
        });
        status = response.status;
        usage = usageOfHeaders(response.headers);
        body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      } catch {
        return { kind: 'error', wait: null, code: null, usage: { pct: null, regainMinutes: null } };
      }
      config.log?.({ status, usagePct: usage.pct, shape: shapeOf(body) });
      const found = body.business_discovery as Record<string, unknown> | undefined;
      if (status === 200 && found && typeof found.username === 'string') {
        return {
          kind: 'found',
          followers: count(found.followers_count),
          posts: count(found.media_count),
          media: postsOf(found.media),
          usage,
        };
      }
      const error = body.error as { code?: unknown } | undefined;
      const code = count(error?.code);
      const kind = graphErrorKindOf(error);
      if (kind === 'not_business') return { kind: 'not_business', code, usage };
      return {
        kind: 'error',
        wait: kind === 'other' ? null : kind,
        code: code ?? status,
        usage,
      };
    },
  };
}

// --- what is kept of an answer ------------------------------------------------------------------

const DAY_MS = 86_400_000;

const averageMilli = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length
    ? Math.round((present.reduce((sum, v) => sum + v, 0) * 1000) / present.length)
    : null;
};

/**
 * The numbers kept of a business account found (§2.2, §6.2): averages × 1000 over the posts that
 * brought the field (null when none did), posts of the last 30 days among those read (null when no
 * timestamp came), never a zero for something Meta did not send.
 */
export function readingOf(
  answer: Extract<DiscoveryLookup, { kind: 'found' }>,
  now: Date,
): {
  followersCount: number | null;
  mediaCount: number | null;
  recentMediaRead: number | null;
  avgLikesMilli: number | null;
  avgCommentsMilli: number | null;
  postsLast30d: number | null;
  lastPostAt: Date | null;
} {
  const media = answer.media;
  const times = (media ?? [])
    .map((post) => (post.timestamp ? Date.parse(post.timestamp) : null))
    .filter((t): t is number => t !== null);
  // An account with no post at all has none in 30 days; posts without a date are no data.
  const noPosts = media !== null && media.length === 0 && answer.posts === 0;
  return {
    followersCount: answer.followers,
    mediaCount: answer.posts,
    recentMediaRead: media ? media.length : null,
    avgLikesMilli: averageMilli((media ?? []).map((post) => post.likes)),
    avgCommentsMilli: averageMilli((media ?? []).map((post) => post.comments)),
    postsLast30d: times.length
      ? times.filter((t) => t >= now.getTime() - 30 * DAY_MS).length
      : noPosts
        ? 0
        : null,
    lastPostAt: times.length ? new Date(Math.max(...times)) : null,
  };
}

// --- the ticket: only a company's @ from a Google search goes to Meta --------------------------

const TICKET_TTL_MS = 12 * 60 * 60_000;

/** A key of its own, derived: the session secret itself never signs anything else. */
export const ticketKeyOf = (sessionSecret: string): Buffer =>
  createHmac('sha256', sessionSecret).update('wings-instagram-discovery-ticket').digest();

const mac = (key: Buffer, employeeId: string, username: string, expires: number) =>
  createHmac('sha256', key).update(`${employeeId}\n${username}\n${expires}`).digest('base64url');

/**
 * Signed on the search's answer for this seller and this @: the discovery route takes no @
 * without it, so a commenter's @ (partes 1 e 2) can never be sent to Business Discovery.
 */
export function issueTicket(key: Buffer, employeeId: string, username: string, now: Date): string {
  const expires = now.getTime() + TICKET_TTL_MS;
  return `${expires}.${mac(key, employeeId, username, expires)}`;
}

export function ticketValid(
  key: Buffer,
  employeeId: string,
  username: string,
  ticket: string,
  now: Date,
): boolean {
  const [expiresText, signature] = ticket.split('.');
  const expires = Number(expiresText);
  if (!signature || !Number.isSafeInteger(expires) || expires < now.getTime()) return false;
  const expected = Buffer.from(mac(key, employeeId, username, expires));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
