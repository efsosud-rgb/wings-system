import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { waMessages } from '../../db/schema/index.js';
import type { Executor } from '../leads/crm.js';

export const CALL_REQUEST_DAILY =
  'A Meta só deixa pedir a permissão para ligar 1 vez por dia a cada pessoa: já foi pedido nas últimas 24 h.';
export const CALL_REQUEST_WEEKLY =
  'A Meta só deixa pedir a permissão para ligar 2 vezes por semana a cada pessoa: já foram 2 nos últimos 7 dias.';

/**
 * Why a call-permission request cannot go to this person now, or null: Meta allows 1 a day and 2
 * a week. Counted from our own requests that left (free or by template, `callPermissionRequest`
 * in the message), a failed one not counting, by the database's clock (the rows' own).
 * shortcut: Meta also resets the count after a call connects; this does not, so it may refuse
 * where Meta would allow — upgrade if sellers hit it after talking to the person.
 */
export async function callRequestRefusal(
  db: Executor,
  contactId: string | null,
): Promise<string | null> {
  if (!contactId) return null;
  const [counted] = await db
    .select({
      day: sql<number>`count(*) filter (where ${waMessages.createdAt} > now() - interval '24 hours')::int`,
      week: sql<number>`count(*)::int`,
    })
    .from(waMessages)
    .where(
      and(
        eq(waMessages.contactId, contactId),
        eq(waMessages.direction, 'out'),
        sql`${waMessages.content}->>'callPermissionRequest' = 'true'`,
        or(isNull(waMessages.status), ne(waMessages.status, 'failed')),
        sql`${waMessages.createdAt} > now() - interval '7 days'`,
      ),
    );
  if ((counted?.day ?? 0) >= 1) return CALL_REQUEST_DAILY;
  if ((counted?.week ?? 0) >= 2) return CALL_REQUEST_WEEKLY;
  return null;
}

/** A request refused at the last moment, under the lock: another one of this person got there first. */
export class CallRequestLimited extends Error {
  constructor(readonly why: string) {
    super('call_request_limit');
  }
}

/**
 * The count again inside the transaction that writes the request, under one lock per person: two
 * clicks at once (or a click and the automatic "Prefiro uma ligação") cannot both pass the limit.
 * Throws `CallRequestLimited`; the caller's early `callRequestRefusal` answers the usual case.
 */
export async function lockCallRequests(tx: Executor, contactId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wa_call_request:${contactId}`}))`);
  const why = await callRequestRefusal(tx, contactId);
  if (why) throw new CallRequestLimited(why);
}
