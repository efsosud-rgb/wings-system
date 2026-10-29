import {
  can,
  isSectorSlug,
  SOFIA_CLOSE_LABELS,
  SOFIA_HANDOFF_LABELS,
  type Actor,
  type SofiaCloseReason,
  type SofiaFact,
  type SofiaHandoffReason,
  type WaAttendanceView,
  type WaConversationEventKind,
} from '@wings/shared';
import { desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import { employees, waConversationEvents } from '../../db/schema/index.js';
import { attendants, handsOf, isFull, nameOf, type ConversationRow } from './attendance.js';

const OTHER_REASONS: Record<string, string> = { mensagem_da_pessoa: 'A pessoa escreveu de novo' };

const reasonLabel = (reason: string | null) =>
  reason
    ? (SOFIA_HANDOFF_LABELS[reason as SofiaHandoffReason] ??
      SOFIA_CLOSE_LABELS[reason as SofiaCloseReason] ??
      OTHER_REASONS[reason] ??
      null)
    : null;

/** The Central's panel: who holds it, what each reader may do, the history and Sofia's context. */
export async function attendanceView(
  db: Database,
  input: { conversationId: string; actor: Actor; at: Date; sofiaOn: boolean },
  sofiaFacts: (row: ConversationRow) => SofiaFact[],
): Promise<WaAttendanceView | null> {
  const hands = await handsOf(db, input.conversationId);
  if (!hands) return null;
  const { row } = hands;
  const me = input.actor.employeeId;
  const full = isFull(input.actor);
  const holds = hands.holderId === me;
  const closed = row.attendance === 'closed';
  const official = row.numberId === null;
  const replying =
    row.replyingEmployeeId && row.replyingEmployeeId !== me && row.replyingUntil
      ? row.replyingUntil > input.at
        ? await nameOf(db, row.replyingEmployeeId)
        : null
      : null;
  const facts = official ? sofiaFacts(row) : [];
  const from = alias(employees, 'from_person');
  const to = alias(employees, 'to_person');
  const by = alias(employees, 'by_person');
  const events = await db
    .select({
      id: waConversationEvents.id,
      kind: waConversationEvents.kind,
      fromName: from.fullName,
      toName: to.fullName,
      queue: waConversationEvents.queue,
      reason: waConversationEvents.reason,
      actorName: by.fullName,
      at: waConversationEvents.createdAt,
    })
    .from(waConversationEvents)
    .leftJoin(from, eq(from.id, waConversationEvents.fromEmployeeId))
    .leftJoin(to, eq(to.id, waConversationEvents.toEmployeeId))
    .leftJoin(by, eq(by.id, waConversationEvents.actorEmployeeId))
    .where(eq(waConversationEvents.conversationId, row.id))
    .orderBy(desc(waConversationEvents.createdAt))
    .limit(50);
  // Passing it on: a full-scope reader to anyone or a queue; its holder only to a queue.
  const canTransfer = full || (holds && hands.naturalId === null);
  return {
    attendance: {
      conversationId: row.id,
      version: row.version,
      holderId: hands.holderId,
      holderName: await nameOf(db, hands.holderId),
      assigned: row.assigneeEmployeeId !== null,
      queue: row.queue && isSectorSlug(row.queue) ? row.queue : null,
      replyingName: replying,
      sofiaPaused: row.sofiaPaused,
      sofia:
        official && (facts.length > 0 || row.reason)
          ? { reason: reasonLabel(row.reason), facts }
          : null,
      can: {
        take: !closed && !(holds && row.attendance === 'with_person'),
        transfer: canTransfer,
        resolve: !closed && (holds || full),
        reopen: closed,
        pauseSofia: official && input.sofiaOn && !row.sofiaPaused,
        resumeSofia:
          official &&
          input.sofiaOn &&
          row.attendance !== 'sofia' &&
          can(input.actor, 'sofia.read').allowed,
      },
    },
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind as WaConversationEventKind,
      fromName: event.fromName,
      toName: event.toName,
      queue: event.queue && isSectorSlug(event.queue) ? event.queue : null,
      reason: reasonLabel(event.reason),
      actorName: event.actorName,
      at: event.at.toISOString(),
    })),
    people: full ? await attendants(db) : [],
  };
}
