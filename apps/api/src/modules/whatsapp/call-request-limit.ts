import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { waMessages } from '../../db/schema/index.js';

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
  db: Database,
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
