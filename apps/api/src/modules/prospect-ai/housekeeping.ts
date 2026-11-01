import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import {
  igPeople,
  prospectClassifierCache,
  prospectEvidence,
  prospectOpportunities,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { purgeInstagramPayloads } from '../instagram/intake.js';
import { purgeInstagramSnapshots } from '../prospecting/instagram-discovery.js';
import { loadInstagramSettings } from './settings.js';

/**
 * Prospecção Instagram's purge (docs/prospeccao/instagram-meta-lgpd.md §8.4), run by the API
 * every hour: a prospect that did not become a lead within `retention.instagramSemLeadDias` of its
 * last change (creation, "Abordei", transfer) is deleted with every comment of it (the @, the
 * excerpt, the link) and its classifications; only the count stays, in the audit log. The
 * classifier's cache (a hash and the justifying phrase) goes after 30 days, and so does a Business
 * Discovery reading of a company (parte 3), counted from its `fetched_at`. Parte 1 the same: its
 * opportunities, the person of Instagram not seen for as long and not a lead, and the webhook's raw
 * events (emptied); an opportunity whose 7 days (or 24 h of the Direct) passed with no answer
 * becomes `prazo_vencido`. "Não contatar" is in `contact_opt_outs` and is never purged. One run at
 * a time across replicas.
 */

const LOCK_KEY = 'prospect-ai:housekeeping';
export const HOUSEKEEPING_TICK_MS = 60 * 60_000;
const CACHE_DAYS = 30;

export type HousekeepingResult =
  | { ran: false }
  | {
      ran: true;
      purged: number;
      cache: number;
      snapshots: number;
      people: number;
      payloads: number;
      expired: number;
    };

const INSTAGRAM_SOURCES = ['instagram_colagem', 'instagram_comment', 'instagram_ad_comment'];

export async function runInstagramHousekeeping(
  db: Database,
  now = new Date(),
): Promise<HousekeepingResult> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ got: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as got`,
    );
    if (!lock.rows[0]?.got) return { ran: false };
    const days = (await loadInstagramSettings(tx)).retention.instagramSemLeadDias;
    // The evidence goes with its opportunity (on delete cascade), the classifications too.
    const purged = await tx
      .delete(prospectOpportunities)
      .where(
        and(
          eq(prospectOpportunities.tenantId, WINGS_TENANT_ID),
          inArray(prospectOpportunities.source, INSTAGRAM_SOURCES),
          isNull(prospectOpportunities.leadId),
          sql`(select max(${prospectEvidence.retentionUntil}) from ${prospectEvidence} where ${prospectEvidence.opportunityId} = ${prospectOpportunities.id}) < ${now.toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: prospectOpportunities.id });
    const cache = await tx
      .delete(prospectClassifierCache)
      .where(
        lt(prospectClassifierCache.createdAt, new Date(now.getTime() - CACHE_DAYS * 86_400_000)),
      )
      .returning({ key: prospectClassifierCache.keyHash });
    const snapshots = await purgeInstagramSnapshots(tx, now);
    const people = await tx
      .delete(igPeople)
      .where(
        and(
          isNull(igPeople.leadId),
          lt(igPeople.lastSeenAt, new Date(now.getTime() - days * 86_400_000)),
        ),
      )
      .returning({ id: igPeople.id });
    const payloads = await purgeInstagramPayloads(tx, now);
    const expired = await tx
      .update(prospectOpportunities)
      .set({ state: 'prazo_vencido', updatedAt: now })
      .where(
        and(
          inArray(prospectOpportunities.source, ['instagram_comment', 'instagram_ad_comment']),
          inArray(prospectOpportunities.state, ['nova', 'em_revisao']),
          isNull(prospectOpportunities.respondedAt),
          lt(prospectOpportunities.respondBy, now),
        ),
      )
      .returning({ id: prospectOpportunities.id });
    if (purged.length)
      await writeAudit(tx, {
        action: 'prospect_ai.instagram_purged',
        entity: 'prospect_ai_settings',
        metadata: { count: purged.length, people: people.length, days },
      });
    return {
      ran: true,
      purged: purged.length,
      cache: cache.length,
      snapshots,
      people: people.length,
      payloads,
      expired: expired.length,
    };
  });
}

/** Never started by `buildApp`, so no test starts it. */
export function startInstagramHousekeeping(deps: {
  db: Database;
  log: (facts: Record<string, unknown>) => void;
}): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await runInstagramHousekeeping(deps.db);
      if (
        result.ran &&
        (result.purged ||
          result.cache ||
          result.snapshots ||
          result.people ||
          result.payloads ||
          result.expired)
      )
        deps.log({ job: 'prospect-ai-housekeeping', ...result });
    } catch (error) {
      deps.log({
        job: 'prospect-ai-housekeeping',
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), HOUSEKEEPING_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
