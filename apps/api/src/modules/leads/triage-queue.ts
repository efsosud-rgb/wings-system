/**
 * The waiting list of the Jev triage (docs/leads/triagem-jev.md): one row per lead born without a
 * funnel, or per WhatsApp conversation with no deal. The door writes it in the transaction that
 * makes the lead (or stores the first message), BEFORE the triage runs, so nothing that waits for
 * the Jev is kept only in the memory of a process that a restart or an error can lose. A run takes
 * the row (`claimTriage`) and closes it (`finishTriage`); a row left open is found again by
 * `openTriage`. Ids and times only.
 */
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leadTriageQueue } from '../../db/schema/index.js';
import type { Executor } from './crm.js';
import type { TriageTarget } from './triage-schedule.js';

/** Times a server may take a row; past this the usual notice goes out and the Jev is not asked again. */
export const TRIAGE_MAX_ATTEMPTS = 3;
/** A row taken longer ago than this was cut short (a restart): another pass may take it. */
export const TRIAGE_CLAIM_TIMEOUT_MS = 3 * 60_000;
/** A row younger than this still belongs to the run its door just started. */
export const TRIAGE_GRACE_MS = 30_000;

const targetWhere = (target: TriageTarget) =>
  'leadId' in target
    ? eq(leadTriageQueue.leadId, target.leadId)
    : eq(leadTriageQueue.conversationId, target.conversationId);

/** Writes the row of a target; one per lead and per conversation, so a repeat adds nothing. */
export async function enqueueTriage(db: Executor, target: TriageTarget): Promise<void> {
  await db
    .insert(leadTriageQueue)
    .values(
      'leadId' in target ? { leadId: target.leadId } : { conversationId: target.conversationId },
    )
    .onConflictDoNothing();
}

export interface ClaimedTriage {
  id: string;
  /** Counting this one: the first run is 1. */
  attempts: number;
}

/**
 * Takes the row of a target for this run: only an open row that nobody holds, or whose holder was
 * cut short. Null when it is done, absent or held by another run — then this run does nothing.
 */
export async function claimTriage(
  db: Database,
  target: TriageTarget,
  now: Date,
): Promise<ClaimedTriage | null> {
  const [row] = await db
    .update(leadTriageQueue)
    .set({ claimedAt: now, attempts: sql`${leadTriageQueue.attempts} + 1` })
    .where(
      and(
        targetWhere(target),
        isNull(leadTriageQueue.doneAt),
        or(
          isNull(leadTriageQueue.claimedAt),
          lt(leadTriageQueue.claimedAt, new Date(now.getTime() - TRIAGE_CLAIM_TIMEOUT_MS)),
        ),
      ),
    )
    .returning({ id: leadTriageQueue.id, attempts: leadTriageQueue.attempts });
  return row ?? null;
}

export type TriageOutcome = 'done' | 'fallback';

export async function finishTriage(
  db: Database,
  id: string,
  outcome: TriageOutcome,
  now: Date,
): Promise<void> {
  await db.update(leadTriageQueue).set({ doneAt: now, outcome }).where(eq(leadTriageQueue.id, id));
}

/** Rows still open that no run holds: older than the grace, not taken (or taken and cut short). */
export async function openTriage(db: Database, now: Date, limit = 20): Promise<TriageTarget[]> {
  const rows = await db
    .select({ leadId: leadTriageQueue.leadId, conversationId: leadTriageQueue.conversationId })
    .from(leadTriageQueue)
    .where(
      and(
        isNull(leadTriageQueue.doneAt),
        lt(leadTriageQueue.queuedAt, new Date(now.getTime() - TRIAGE_GRACE_MS)),
        or(
          isNull(leadTriageQueue.claimedAt),
          lt(leadTriageQueue.claimedAt, new Date(now.getTime() - TRIAGE_CLAIM_TIMEOUT_MS)),
        ),
      ),
    )
    .orderBy(asc(leadTriageQueue.queuedAt))
    .limit(limit);
  return rows.flatMap((row): TriageTarget[] =>
    row.leadId
      ? [{ leadId: row.leadId }]
      : row.conversationId
        ? [{ conversationId: row.conversationId }]
        : [],
  );
}
