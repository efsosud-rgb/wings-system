import {
  INSTAGRAM_DISCOVERY_REASONS as REASONS,
  normalizeInstagram,
  type InstagramDiscoveryInput,
  type InstagramDiscoveryItem,
  type InstagramDiscoveryResponse,
  type InstagramSnapshotStatus,
  type InstagramSnapshotView,
} from '@wings/shared';
import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { instagramBusinessSnapshots, instagramDiscoveryCalls } from '../../db/schema/index.js';
import { periodStarts } from '../media/providers/quota.js';
import { loadInstagramSettings } from '../prospect-ai/settings.js';
import {
  GRAPH_API_VERSION,
  readingOf,
  ticketValid,
  type BusinessDiscoveryClient,
  type DiscoveryLookup,
  type GraphUsage,
} from './instagram-graph.js';

/**
 * Business Discovery for the Google search (docs/prospeccao/instagram.md §1.3, §6.4): each @ that
 * came with a valid ticket is answered from the cache (`discovery.cacheDias`) or, within the daily
 * ceiling (`discovery.porDia`, each call written under a lock before it goes), by one call to Meta.
 * Meta's usage at 80% or a limit/permission error pauses every call until the hold ends.
 */

const SNAPSHOT_DAYS = 30;
const CALLS_DAYS = 30;
const DAY_MS = 86_400_000;
const USAGE_HOLD_PCT = 80;
const DEFAULT_HOLD_MINUTES = 60;

/** When the calls may go again. One per API process. */
export interface DiscoveryHold {
  until: Date | null;
  reason: string | null;
}

export interface DiscoveryDeps {
  db: Database;
  client: BusinessDiscoveryClient;
  ticketKey: Buffer;
  hold: DiscoveryHold;
  now: Date;
}

type SnapshotRow = typeof instagramBusinessSnapshots.$inferSelect;

export const toSnapshotView = (row: SnapshotRow): InstagramSnapshotView => ({
  username: row.username,
  status: row.status as InstagramSnapshotStatus,
  followers: row.followersCount,
  posts: row.mediaCount,
  recentMediaRead: row.recentMediaRead,
  avgLikesMilli: row.avgLikesMilli,
  avgCommentsMilli: row.avgCommentsMilli,
  postsLast30d: row.postsLast30d,
  lastPostAt: row.lastPostAt?.toISOString() ?? null,
  source: row.source,
  fetchedAt: row.fetchedAt.toISOString(),
});

const hhmm = (at: Date) =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);

async function callsToday(db: Pick<Database, 'select'>, now: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(instagramDiscoveryCalls)
    .where(
      and(
        eq(instagramDiscoveryCalls.tenantId, WINGS_TENANT_ID),
        gte(instagramDiscoveryCalls.createdAt, periodStarts(now).day),
      ),
    );
  return row?.total ?? 0;
}

/** One call reserved under a lock, before it goes; false when the day's ceiling is reached. */
export async function reserveDiscoveryCall(
  db: Database,
  employeeId: string,
  perDay: number,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('instagram_discovery_quota'))`);
    if ((await callsToday(tx, now)) >= perDay) return false;
    await tx.insert(instagramDiscoveryCalls).values({ employeeId, createdAt: now });
    return true;
  });
}

/** Meta asked us to slow down (or refused): no call goes until `until`. */
function holdFor(hold: DiscoveryHold, now: Date, usage: GraphUsage, reason: string) {
  const minutes = usage.regainMinutes && usage.regainMinutes > 0 ? usage.regainMinutes : null;
  const until = new Date(now.getTime() + (minutes ?? DEFAULT_HOLD_MINUTES) * 60_000);
  if (!hold.until || until > hold.until) {
    hold.until = until;
    hold.reason = reason;
  }
}

function rowOf(username: string, answer: DiscoveryLookup, now: Date) {
  const base = { username, apiVersion: GRAPH_API_VERSION, fetchedAt: now };
  const empty = {
    followersCount: null,
    mediaCount: null,
    recentMediaRead: null,
    avgLikesMilli: null,
    avgCommentsMilli: null,
    postsLast30d: null,
    lastPostAt: null,
  };
  if (answer.kind === 'found')
    return { ...base, status: 'encontrada', errorCode: null, ...readingOf(answer, now) };
  if (answer.kind === 'not_business')
    return { ...base, status: 'nao_comercial', errorCode: null, ...empty };
  return { ...base, status: 'erro', errorCode: answer.code, ...empty };
}

const reasonOf = (answer: DiscoveryLookup): string | null =>
  answer.kind === 'found'
    ? null
    : answer.kind === 'not_business'
      ? REASONS.notBusiness
      : answer.wait === 'permission'
        ? REASONS.refused
        : answer.wait === 'rate_limit'
          ? REASONS.waiting
          : REASONS.failed;

export async function discoverInstagram(
  deps: DiscoveryDeps,
  employeeId: string,
  input: InstagramDiscoveryInput,
): Promise<InstagramDiscoveryResponse> {
  const { db, now, hold } = deps;
  const settings = (await loadInstagramSettings(db)).discovery;
  const byName = new Map<string, InstagramDiscoveryItem>();
  const order: { asked: string; username: string | null }[] = [];
  const wanted: string[] = [];
  for (const item of input.items) {
    const username = normalizeInstagram(item.username);
    order.push({ asked: item.username, username });
    if (!username || byName.has(username)) continue;
    if (!ticketValid(deps.ticketKey, employeeId, username, item.ticket, now)) {
      byName.set(username, { username, snapshot: null, reason: REASONS.notFromSearch });
      continue;
    }
    wanted.push(username);
  }

  const fresh = wanted.length
    ? await db
        .select()
        .from(instagramBusinessSnapshots)
        .where(
          and(
            eq(instagramBusinessSnapshots.tenantId, WINGS_TENANT_ID),
            inArray(instagramBusinessSnapshots.username, wanted),
            ne(instagramBusinessSnapshots.status, 'erro'),
            gte(
              instagramBusinessSnapshots.fetchedAt,
              new Date(now.getTime() - settings.cacheDias * DAY_MS),
            ),
          ),
        )
    : [];
  for (const row of fresh)
    byName.set(row.username, {
      username: row.username,
      snapshot: toSnapshotView(row),
      reason: row.status === 'nao_comercial' ? REASONS.notBusiness : null,
    });

  let ceiling = false;
  for (const username of wanted) {
    if (byName.has(username)) continue;
    if (hold.until && hold.until > now) {
      byName.set(username, {
        username,
        snapshot: null,
        reason: `${hold.reason ?? REASONS.waiting} (até ${hhmm(hold.until)})`,
      });
      continue;
    }
    if (ceiling || !(await reserveDiscoveryCall(db, employeeId, settings.porDia, now))) {
      ceiling = true;
      byName.set(username, { username, snapshot: null, reason: REASONS.dailyLimit });
      continue;
    }
    const answer = await deps.client.lookup(username, settings.recentPosts);
    const values = rowOf(username, answer, now);
    const [row] = await db
      .insert(instagramBusinessSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: [instagramBusinessSnapshots.tenantId, instagramBusinessSnapshots.username],
        set: { ...values, source: 'meta_business_discovery' },
      })
      .returning();
    if (answer.kind === 'error' && answer.wait)
      holdFor(
        hold,
        now,
        answer.usage,
        answer.wait === 'permission' ? REASONS.refused : REASONS.waiting,
      );
    else if (answer.usage.pct !== null && answer.usage.pct >= USAGE_HOLD_PCT)
      holdFor(hold, now, answer.usage, REASONS.waiting);
    byName.set(username, {
      username,
      snapshot: row && row.status !== 'erro' ? toSnapshotView(row) : null,
      reason: reasonOf(answer),
    });
  }

  return {
    items: order.map(
      ({ asked, username }) =>
        (username ? byName.get(username) : undefined) ?? {
          username: asked,
          snapshot: null,
          reason: REASONS.invalid,
        },
    ),
    holdUntil: hold.until && hold.until > now ? hold.until.toISOString() : null,
    usage: { today: await callsToday(db, now), limit: settings.porDia },
  };
}

/** §8.4: a reading is deleted 30 days after it was made. */
export async function purgeInstagramSnapshots(
  db: Pick<Database, 'delete'>,
  now: Date,
): Promise<number> {
  const gone = await db
    .delete(instagramBusinessSnapshots)
    .where(
      lt(instagramBusinessSnapshots.fetchedAt, new Date(now.getTime() - SNAPSHOT_DAYS * DAY_MS)),
    )
    .returning({ id: instagramBusinessSnapshots.id });
  return gone.length;
}

/** §8.4: a call of the daily ceiling holds who asked (an employee id); deleted after 30 days. */
export async function purgeDiscoveryCalls(
  db: Pick<Database, 'delete'>,
  now: Date,
): Promise<number> {
  const gone = await db
    .delete(instagramDiscoveryCalls)
    .where(lt(instagramDiscoveryCalls.createdAt, new Date(now.getTime() - CALLS_DAYS * DAY_MS)))
    .returning({ id: instagramDiscoveryCalls.id });
  return gone.length;
}
