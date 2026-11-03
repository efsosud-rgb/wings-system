import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import {
  prospectClassifierCache,
  prospectEvidence,
  prospectOpportunities,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import {
  purgeDiscoveryCalls,
  purgeInstagramSnapshots,
} from '../prospecting/instagram-discovery.js';
import { loadInstagramSettings } from './settings.js';

/**
 * Prospecção Instagram's purge (docs/prospeccao/instagram-meta-lgpd.md §8.4), run by the API
 * every hour: a prospect that did not become a lead within `retention.instagramSemLeadDias` of its
 * last change (creation, "Abordei", transfer) is deleted with every comment of it (the @, the
 * excerpt, the link) and its classifications; only the count stays, in the audit log. The
 * classifier's cache (a hash and the justifying phrase) goes after 30 days, and so do a Business
 * Discovery reading of a company (parte 3), counted from its `fetched_at`, and a row of its daily
 * ceiling (who asked, never the @). "Não contatar" is in
 * `contact_opt_outs` and is never purged. One run at a time across replicas.
 */

const LOCK_KEY = 'prospect-ai:housekeeping';
export const HOUSEKEEPING_TICK_MS = 60 * 60_000;
const CACHE_DAYS = 30;

export type HousekeepingResult =
  { ran: false } | { ran: true; purged: number; cache: number; snapshots: number; calls: number };

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
          eq(prospectOpportunities.source, 'instagram_colagem'),
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
    const calls = await purgeDiscoveryCalls(tx, now);
    if (purged.length)
      await writeAudit(tx, {
        action: 'prospect_ai.instagram_purged',
        entity: 'prospect_ai_settings',
        metadata: { count: purged.length, days },
      });
    return { ran: true, purged: purged.length, cache: cache.length, snapshots, calls };
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
      if (result.ran && (result.purged || result.cache || result.snapshots || result.calls))
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
