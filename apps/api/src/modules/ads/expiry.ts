import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adApprovalRequests,
  adChangeRequests,
  budgetPeriods,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { releaseReservation } from './budget-guard.js';
import { periodMonthOf } from './reconcile.js';

/**
 * Old requests expire (T-8). A request nobody decided, or approved and never
 * executed, holds a reservation worked out for a moment that has passed:
 * reconciliation wipes it from the commitment anyway (T-1), a reduction keeps
 * handing out space it never freed (T-3), and the longer it waits the more
 * the platform drifts from what the approver was shown. So it expires, its
 * reservation is given back and a new request starts from today.
 *
 * Runs at the end of every ingestion cycle (the 15-minute task included), next
 * to the dead-man check. Expiring only ever takes money off the table; it
 * never approves, executes or calls a platform.
 */

/** How long a request may wait for a decision, or an approval for its click. */
export const CHANGE_REQUEST_MAX_AGE_HOURS = 24;

export interface ExpiredChange {
  changeRequestId: string;
  adAccountId: string;
  /** `age`: past the limit; `month_turned`: its budget period is not this month's. */
  why: 'age' | 'month_turned';
}

export interface ExpiryResult {
  expired: ExpiredChange[];
  /**
   * Requests that could not be expired. Each request is its own failure
   * domain, as each account is in the ingestion cycle: one that cannot be
   * released must not keep every other old request holding money.
   */
  failed: { changeRequestId: string; error: string }[];
}

export async function expireStaleChanges(
  db: Database,
  options: { now?: Date; maxAgeHours?: number } = {},
): Promise<ExpiryResult> {
  const now = options.now ?? new Date();
  const maxAgeMs = (options.maxAgeHours ?? CHANGE_REQUEST_MAX_AGE_HOURS) * 3_600_000;

  const open = await db
    .select({
      id: adChangeRequests.id,
      adAccountId: adChangeRequests.adAccountId,
      status: adChangeRequests.status,
      kind: adChangeRequests.kind,
      exposureDeltaCents: adChangeRequests.exposureDeltaCents,
      createdAt: adChangeRequests.createdAt,
      decidedAt: adChangeRequests.decidedAt,
      periodMonth: budgetPeriods.periodMonth,
      timezone: adAccounts.timezone,
    })
    .from(adChangeRequests)
    .innerJoin(budgetPeriods, eq(budgetPeriods.id, adChangeRequests.budgetPeriodId))
    .innerJoin(adAccounts, eq(adAccounts.id, adChangeRequests.adAccountId))
    .where(inArray(adChangeRequests.status, ['pending_approval', 'approved']));

  const result: ExpiryResult = { expired: [], failed: [] };
  for (const change of open) {
    // An approval's clock starts at the decision: approving in the last hour
    // of a request's day must still leave a day to click Executar.
    const since =
      change.status === 'approved' ? (change.decidedAt ?? change.createdAt) : change.createdAt;
    const why =
      String(change.periodMonth) !== periodMonthOf(now, change.timezone)
        ? 'month_turned'
        : now.getTime() - since.getTime() > maxAgeMs
          ? 'age'
          : null;
    if (!why) continue;

    // Only from the status it was read in: a decision or a click that got
    // there first wins, and this request is simply left alone.
    const moved = await db
      .transaction(async (tx) => {
        const released = await releaseReservation(tx, change.id, 'expired', null, {
          from: [change.status],
          now,
        });
        if (!released) return false;
        await tx
          .update(adApprovalRequests)
          .set({ status: 'expired', decidedAt: now })
          .where(
            and(
              eq(adApprovalRequests.changeRequestId, change.id),
              inArray(adApprovalRequests.status, ['pending', 'escalated']),
            ),
          );
        await writeAudit(tx, {
          action: 'ads.change_expired',
          entity: 'ad_change_request',
          entityId: change.id,
          metadata: {
            why,
            previousStatus: change.status,
            kind: change.kind,
            exposureDeltaCents: change.exposureDeltaCents,
            waitedHours: Math.floor((now.getTime() - since.getTime()) / 3_600_000),
          },
        });
        return true;
      })
      .catch((error: unknown) => {
        result.failed.push({
          changeRequestId: change.id,
          // drizzle wraps the database error with the whole query; the cause says why.
          error:
            error instanceof Error
              ? error.cause instanceof Error
                ? error.cause.message
                : error.message
              : String(error),
        });
        return false;
      });
    if (moved) {
      result.expired.push({ changeRequestId: change.id, adAccountId: change.adAccountId, why });
    }
  }
  return result;
}
