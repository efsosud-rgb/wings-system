import { and, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { crmNotifications, employees, roles, waMessages } from '../../db/schema/index.js';
import { managersAndBoard } from '../leads/crm-alerts.js';
import { UNKNOWN_OUTCOME } from './graph.js';

/**
 * What the WhatsApp loops tell people (CRM Vendas → Avisos), so a failure never stays only in a
 * log: a webhook body the queue gave up on, and a message whose fate Meta never told us. Each
 * notice names the problem by its ids, never the person's data, and goes once (`dedupeKey`).
 */

/** The active Admin Masters: the webhook queue and the numbers are theirs (`integrations.manage`). */
export async function adminMasters(db: Database): Promise<string[]> {
  const rows = await db
    .select({ id: employees.id })
    .from(employees)
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .where(and(eq(roles.key, 'admin_master'), eq(employees.status, 'active')));
  return rows.map((row) => row.id);
}

export async function notify(
  db: Database,
  people: string[],
  notice: { kind: string; leadId?: string | null; message: string; key: string },
) {
  if (people.length === 0) return;
  await db
    .insert(crmNotifications)
    .values(
      [...new Set(people)].map((person) => ({
        recipientEmployeeId: person,
        leadId: notice.leadId ?? null,
        kind: notice.kind,
        message: notice.message,
        dedupeKey: `${notice.kind}:${notice.key}:${person}`,
      })),
    )
    .onConflictDoNothing();
}

/** A webhook body failed its last try: the Admin Masters hear, and see it on the Números screen. */
export async function alertWebhookFailed(db: Database, eventId: string) {
  await notify(db, await adminMasters(db), {
    kind: 'whatsapp_webhook_failed',
    message:
      'Um aviso da Meta (WhatsApp) falhou 5 vezes e parou. Veja em CRM Vendas › WhatsApp › Números, "Avisos da Meta com falha", e processe de novo.',
    key: eventId,
  });
}

/** A send still without Meta's answer after this long was cut short (a restart, a timeout). */
const STUCK_MS = 10 * 60_000;
/** Older than this, it was already told. */
const LOOK_BACK_MS = 24 * 3_600_000;

/**
 * Our messages Meta never answered: written (`pending`) and sent once, with no wamid back, either
 * because Meta did not answer (`unknown_outcome`) or because a restart cut the send short. They
 * may have reached the person or not, so nothing is ever sent again on its own: each one is marked
 * unknown (the bubble says "pode ter ido ou não") and whoever sent it hears, or the managers for
 * Sofia's and the system's. Returns how many were found.
 */
export async function sweepUnknownSends(db: Database, now: Date): Promise<number> {
  const rows = await db
    .select({
      id: waMessages.id,
      employeeId: waMessages.employeeId,
      leadId: waMessages.leadId,
      errorTitle: waMessages.errorTitle,
    })
    .from(waMessages)
    .where(
      and(
        eq(waMessages.direction, 'out'),
        eq(waMessages.status, 'pending'),
        isNull(waMessages.wamid),
        lt(waMessages.createdAt, new Date(now.getTime() - STUCK_MS)),
        gt(waMessages.createdAt, new Date(now.getTime() - LOOK_BACK_MS)),
      ),
    )
    .limit(200);
  if (rows.length === 0) return 0;
  const cut = rows.filter((row) => row.errorTitle === null).map((row) => row.id);
  if (cut.length > 0)
    await db
      .update(waMessages)
      .set({ errorTitle: UNKNOWN_OUTCOME })
      .where(and(inArray(waMessages.id, cut), isNull(waMessages.errorTitle)));
  const board = rows.some((row) => !row.employeeId) ? await managersAndBoard(db) : [];
  for (const row of rows)
    await notify(db, row.employeeId ? [row.employeeId] : board, {
      kind: 'whatsapp_send_unknown',
      leadId: row.leadId,
      message:
        'Uma mensagem do WhatsApp ficou sem resposta da Meta: pode ter chegado ou não. Confira na conversa antes de mandar de novo (o sistema não reenvia sozinho).',
      key: row.id,
    });
  return rows.length;
}
