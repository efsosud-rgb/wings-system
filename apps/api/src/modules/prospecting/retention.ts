import type { ProspectStatus } from '@wings/shared';
import { and, eq, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { prospects } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { dayOf } from './service.js';
import { loadProspectingSettings } from './settings.js';

/**
 * Prospecção's clean-up (docs/crm/prospeccao.md), run by the API process every
 * 6 hours: a reservation nobody touched for `reservedDays` (a contact for
 * `contactedDays`) goes back to free as `descartado`, row and notes kept, one
 * audit entry each; then the enrichment (what the company's site showed) of a
 * prospect that did not become a lead and was not updated for
 * `enrichmentDays` is cleared, audited as a count. One run at a time across
 * replicas (a transaction-level advisory lock: a replica that does not get it
 * skips the tick). Never started by `buildApp`, so no test starts it.
 */

const LOCK_KEY = 'prospecting:retention';
export const RETENTION_TICK_MS = 6 * 60 * 60_000;
const DAY_MS = 86_400_000;

export type RetentionResult =
  { ran: false } | { ran: true; expired: number; enrichmentCleared: number };

export async function runProspectingRetention(
  db: Database,
  now = new Date(),
): Promise<RetentionResult> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ got: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as got`,
    );
    if (!lock.rows[0]?.got) return { ran: false };
    const { retention } = await loadProspectingSettings(tx);
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);

    let expired = 0;
    const holds: [ProspectStatus, number][] = [
      ['reservado', retention.reservedDays],
      ['contatado', retention.contactedDays],
    ];
    for (const [status, days] of holds) {
      const rows = await tx
        .update(prospects)
        .set({ status: 'descartado', reason: `Reserva expirada em ${dayOf(now)}`, updatedAt: now })
        .where(
          and(
            eq(prospects.tenantId, WINGS_TENANT_ID),
            eq(prospects.status, status),
            lt(prospects.updatedAt, before(days)),
          ),
        )
        .returning({ id: prospects.id });
      for (const row of rows)
        await writeAudit(tx, {
          action: 'prospect.reservation_expired',
          entity: 'prospect',
          entityId: row.id,
          metadata: { previousStatus: status, status: 'descartado', days },
        });
      expired += rows.length;
    }

    const cleared = await tx
      .update(prospects)
      .set({ enrichment: {} })
      .where(
        and(
          eq(prospects.tenantId, WINGS_TENANT_ID),
          ne(prospects.status, 'virou_lead'),
          ne(prospects.enrichment, sql`'{}'::jsonb`),
          lt(prospects.updatedAt, before(retention.enrichmentDays)),
        ),
      )
      .returning({ id: prospects.id });
    if (cleared.length)
      await writeAudit(tx, {
        action: 'prospecting.enrichment_cleared',
        entity: 'prospecting_settings',
        metadata: { count: cleared.length, days: retention.enrichmentDays },
      });
    return { ran: true, expired, enrichmentCleared: cleared.length };
  });
}

export function startProspectingRetentionScheduler(deps: {
  db: Database;
  log: (facts: Record<string, unknown>) => void;
  tickMs?: number;
}): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await runProspectingRetention(deps.db);
      if (result.ran && (result.expired || result.enrichmentCleared))
        deps.log({ job: 'prospecting-retention', ...result });
    } catch (error) {
      deps.log({
        job: 'prospecting-retention',
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      busy = false;
    }
  };
  // Once on start too: deploys more often than every 6 hours would otherwise never run it.
  void tick();
  const timer = setInterval(() => void tick(), deps.tickMs ?? RETENTION_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
