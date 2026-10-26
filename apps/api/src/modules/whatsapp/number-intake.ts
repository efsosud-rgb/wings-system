import {
  brazilianPhoneVariants,
  canonicalWhatsAppPhone,
  normalizeBrazilianPhone,
  type WaMessageStatus,
} from '@wings/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  crmContacts,
  leadContacts,
  leadEvents,
  leads,
  waContacts,
  waConversations,
  waMessages,
} from '../../db/schema/index.js';
import { notifyInboxChanged } from './inbox-signal.js';
import { applyStatus, openConversation } from './intake.js';
import { numberWamid } from './outbox.js';
import type { WaChange, WaInboundMessage } from './webhook-parse.js';

/**
 * A work number's own traffic in the CRM (docs/whatsapp/central.md): the person's messages, what
 * the owner sent from the phone (`smb_message_echoes`), the history Meta sends once in the first
 * 24 hours and the phone's contacts. Each goes to the number's chat with that person (one per
 * number and person, as on the phone), never to Sofia, the triage or the official 24-hour window:
 * `wa_contacts.last_inbound_at` and `opt_out_at` are the official number's and are not touched.
 * A chat joins a deal only when exactly one open deal has that phone; otherwise a person chooses.
 * Formats NOT verified live: the shapes follow Meta's reference.
 */

/** The one open deal of a phone (its own number or a contact's), or null when none or several. */
export async function soleOpenLead(db: Database, phone: string): Promise<string | null> {
  const variants = brazilianPhoneVariants(phone);
  const own = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(inArray(leads.phone, variants), isNull(leads.won)));
  const viaContact = await db
    .select({ id: leads.id })
    .from(leads)
    .innerJoin(leadContacts, eq(leadContacts.leadId, leads.id))
    .innerJoin(crmContacts, eq(crmContacts.id, leadContacts.contactId))
    .where(
      and(
        inArray(crmContacts.phone, variants),
        isNull(crmContacts.mergedIntoId),
        isNull(leads.won),
      ),
    );
  const ids = new Set([...own, ...viaContact].map((row) => row.id));
  return ids.size === 1 ? [...ids][0]! : null;
}

/** The chat joins the deal: its messages go with it, and the deal's history says so. */
export async function linkNumberChat(
  db: Database,
  conversationId: string,
  leadId: string,
  detail: { via: 'auto' | 'manual'; numberId: string; employeeId?: string },
) {
  await db.transaction(async (tx) => {
    await tx.update(waConversations).set({ leadId }).where(eq(waConversations.id, conversationId));
    await tx
      .update(waMessages)
      .set({ leadId })
      .where(eq(waMessages.conversationId, conversationId));
    await tx.insert(leadEvents).values({
      leadId,
      kind: 'lead.whatsapp_linked',
      detail: { via: detail.via, numberId: detail.numberId, conversationId },
      actorEmployeeId: detail.employeeId ?? null,
    });
  });
}

/** The person's contact row (by phone) and this number's chat with them. */
async function chatOf(db: Database, numberId: string, from: string, profileName: string | null) {
  const phone = canonicalWhatsAppPhone(normalizeBrazilianPhone(from) ?? from);
  const [contact] = await db
    .insert(waContacts)
    .values({ phone, waId: from, profileName })
    .onConflictDoUpdate({
      target: [waContacts.tenantId, waContacts.phone],
      set: {
        profileName: sql`coalesce(excluded.profile_name, ${waContacts.profileName})`,
        updatedAt: new Date(),
      },
    })
    .returning();
  let { conversation } = await openConversation(
    db,
    contact!.id,
    null,
    { referral: null, originCode: null },
    numberId,
  );
  if (!conversation.leadId) {
    const leadId = await soleOpenLead(db, phone);
    if (leadId) {
      await linkNumberChat(db, conversation.id, leadId, { via: 'auto', numberId });
      conversation = { ...conversation, leadId };
    }
  }
  return { contact: contact!, conversation };
}

type Traffic = WaInboundMessage & {
  direction: 'in' | 'out';
  status: WaMessageStatus | null;
  history: boolean;
};

async function storeMessage(db: Database, numberId: string, message: Traffic, now: Date) {
  const wamid = numberWamid(numberId, message.wamid);
  const known = await db.query.waMessages.findFirst({
    where: eq(waMessages.wamid, wamid),
    columns: { id: true },
  });
  if (known) return false;
  const { contact, conversation } = await chatOf(
    db,
    numberId,
    message.from,
    message.direction === 'in' ? message.profileName : null,
  );
  const content = { ...message.content };
  for (const key of ['replyTo', 'reactionTo'] as const)
    if (typeof content[key] === 'string') content[key] = numberWamid(numberId, content[key]);
  // History keeps its own days and is never "unread" (`unreadMessageOf`).
  if (message.history) content.history = true;
  const at = message.at ?? now;
  const [stored] = await db
    .insert(waMessages)
    .values({
      wamid,
      conversationId: conversation.id,
      contactId: contact.id,
      leadId: conversation.leadId,
      direction: message.direction,
      // `app`: written on the phone (or a linked device), not by the system.
      author: message.direction === 'in' ? 'contact' : 'app',
      kind: message.kind,
      text: message.text,
      content,
      status: message.direction === 'out' ? (message.status ?? 'sent') : null,
      waTimestamp: at,
      ...(message.history ? { createdAt: at } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: waMessages.id });
  if (!stored) return false;
  await db
    .update(waConversations)
    .set({
      lastMessageAt: sql`greatest(${waConversations.lastMessageAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(eq(waConversations.id, conversation.id));
  return true;
}

/** The phone's contact list: the name the owner saved, on that number's chat with the person. */
async function storeAppContact(db: Database, numberId: string, item: WaChange['appContacts'][0]) {
  const { conversation } = await chatOf(db, numberId, item.phone, null);
  await db
    .update(waConversations)
    .set({ phoneContactName: item.removed ? null : item.name })
    .where(eq(waConversations.id, conversation.id));
}

export async function applyWorkNumberChange(
  db: Database,
  numberId: string,
  change: WaChange,
  now: Date,
) {
  const traffic: Traffic[] = [
    ...change.messages.map((m) => ({
      ...m,
      direction: 'in' as const,
      status: null,
      history: false,
    })),
    ...change.echoes.map((m) => ({
      ...m,
      direction: 'out' as const,
      status: 'sent' as const,
      history: false,
    })),
    ...change.history.map(({ out, ...m }) => ({
      ...m,
      direction: out ? ('out' as const) : ('in' as const),
      history: true,
    })),
  ];
  let stored = 0;
  for (const message of traffic) if (await storeMessage(db, numberId, message, now)) stored++;
  for (const item of change.appContacts) await storeAppContact(db, numberId, item);
  // Our own sends through the number (sent, delivered, read).
  for (const status of change.statuses)
    await applyStatus(db, { ...status, wamid: numberWamid(numberId, status.wamid) });
  if (stored > 0 || change.statuses.length > 0) notifyInboxChanged();
}
