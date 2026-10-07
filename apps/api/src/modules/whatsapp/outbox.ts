import type { WaMessageKind } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { waContacts, waConversations, waMessages } from '../../db/schema/index.js';
import {
  sendWhatsAppMessage,
  UNKNOWN_OUTCOME,
  type OutgoingPayload,
  type WhatsAppConfig,
} from './graph.js';

/**
 * The one way a message leaves: written first (`pending`), sent to Meta once
 * and never retried, then marked sent, failed or unknown (a send that may have
 * reached Meta). Used by a person on the screen and by Sofia alike, so both
 * leave the same trace. The caller checked the window and wrote the audit.
 */

export type Contact = typeof waContacts.$inferSelect;
export type MessageRow = typeof waMessages.$inferSelect;

export interface Delivery {
  contact: Contact;
  conversationId: string;
  leadId: string | null;
  author: 'employee' | 'sofia';
  employeeId: string | null;
  kind: WaMessageKind;
  /** What the screen shows (the body, a filled template). */
  shown: string;
  content: Record<string, unknown>;
  payload: OutgoingPayload;
  at: Date;
}

export interface Delivered {
  row: MessageRow;
  outcome: 'sent' | 'failed' | 'unknown';
  errorCode: number | null;
}

export async function deliverWhatsApp(
  db: Database,
  fetchImpl: typeof fetch,
  config: WhatsAppConfig,
  delivery: Delivery,
): Promise<Delivered> {
  const { contact, at } = delivery;
  const [row] = await db
    .insert(waMessages)
    .values({
      conversationId: delivery.conversationId,
      contactId: contact.id,
      leadId: delivery.leadId,
      direction: 'out',
      author: delivery.author,
      employeeId: delivery.employeeId,
      kind: delivery.kind,
      text: delivery.shown,
      content: delivery.content,
      status: 'pending',
    })
    .returning();

  const result = await sendWhatsAppMessage(
    fetchImpl,
    config,
    contact.waId ?? contact.phone,
    delivery.payload,
  );
  const [saved] = await db
    .update(waMessages)
    .set(
      result.ok
        ? { wamid: result.data.wamid, status: 'sent', sentAt: at, waTimestamp: at }
        : result.unknown
          ? { errorTitle: UNKNOWN_OUTCOME, waTimestamp: at }
          : {
              status: 'failed',
              errorCode: result.code,
              errorTitle: result.title,
              failedAt: at,
              waTimestamp: at,
            },
    )
    .where(eq(waMessages.id, row!.id))
    .returning();
  if (result.ok && result.data.waId && result.data.waId !== contact.waId)
    await db
      .update(waContacts)
      .set({ waId: result.data.waId, updatedAt: at })
      .where(eq(waContacts.id, contact.id));
  await db
    .update(waConversations)
    .set({ lastMessageAt: at })
    .where(eq(waConversations.id, delivery.conversationId));
  return {
    row: saved!,
    outcome: result.ok ? 'sent' : result.unknown ? 'unknown' : 'failed',
    errorCode: result.ok ? null : result.code,
  };
}
