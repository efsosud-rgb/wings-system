import {
  brazilianPhoneVariants,
  WINGS_CLIENT_ID,
  WA_MEDIA_KINDS,
  WA_WINDOW_HOURS,
  type DealWhatsApp,
  type SofiaState,
  type WaCallPermission,
  type WaCallPermissionState,
  type WaMessage,
  type WaMessageKind,
  type WaMessageStatus,
} from '@wings/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  clients,
  employees,
  leads,
  waContacts,
  waConversations,
  waMessages,
} from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { callingOn } from './calling.js';
import { errorText, whatsappConfigOf } from './graph.js';
import type { Contact, MessageRow } from './outbox.js';

/**
 * A conversation as the screens show it (the deal's WhatsApp tab and Sofia's
 * screen): messages, the 24-hour window, opt-out, call permission and who
 * has the conversation now. The caller checked access.
 */

const MESSAGES_SHOWN = 500;

/** The stored permission, with a temporary one that ran out read as none. */
export function permissionOf(
  contact:
    | {
        callPermission: string | null;
        callPermissionExpiresAt: Date | null;
        callPermissionRequestedAt: Date | null;
      }
    | null
    | undefined,
  now: Date,
): WaCallPermissionState {
  if (!contact) return { status: null, expiresAt: null, requestedAt: null };
  const expired =
    contact.callPermission === 'temporary' &&
    contact.callPermissionExpiresAt !== null &&
    contact.callPermissionExpiresAt <= now;
  return {
    status: expired
      ? 'no_permission'
      : ((contact.callPermission as WaCallPermission | null) ?? null),
    expiresAt: expired ? null : (contact.callPermissionExpiresAt?.toISOString() ?? null),
    requestedAt: contact.callPermissionRequestedAt?.toISOString() ?? null,
  };
}

export const windowOf = (contact: Contact | null | undefined, now: Date) => {
  const expires = contact?.lastInboundAt
    ? new Date(contact.lastInboundAt.getTime() + WA_WINDOW_HOURS * 3_600_000)
    : null;
  return { open: expires !== null && expires > now, expiresAt: expires?.toISOString() ?? null };
};

export function toMessage(row: MessageRow, authors: Map<string, string>): WaMessage {
  const content = (row.content ?? {}) as Record<string, unknown>;
  const media = content.media as { mimeType?: string | null; filename?: string | null } | undefined;
  const template = content.template as { name?: string; language?: string } | undefined;
  return {
    id: row.id,
    direction: row.direction === 'out' ? 'out' : 'in',
    kind: row.kind as WaMessageKind,
    text: row.text,
    media:
      media && WA_MEDIA_KINDS.includes(row.kind as WaMessageKind)
        ? { mimeType: media.mimeType ?? null, filename: media.filename ?? null }
        : null,
    template:
      template?.name && template.language
        ? { name: template.name, language: template.language }
        : null,
    status: row.direction === 'out' ? ((row.status ?? 'pending') as WaMessageStatus) : null,
    error: row.direction === 'out' ? errorText(row.errorCode, row.errorTitle) : null,
    authorName: row.employeeId ? (authors.get(row.employeeId) ?? null) : null,
    bySofia: row.author === 'sofia',
    at: (row.waTimestamp ?? row.createdAt).toISOString(),
  };
}

export async function authorsOf(db: Database, rows: MessageRow[]) {
  const ids = [...new Set(rows.map((r) => r.employeeId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map<string, string>();
  const found = await db
    .select({ id: employees.id, name: employees.fullName })
    .from(employees)
    .where(inArray(employees.id, ids));
  return new Map(found.map((e) => [e.id, e.name]));
}

export async function contactOfPhone(db: Database, phone: string | null) {
  if (!phone) return null;
  const found = await db
    .select()
    .from(waContacts)
    .where(inArray(waContacts.phone, brazilianPhoneVariants(phone)))
    .limit(1);
  return found[0] ?? null;
}

/**
 * The brand a conversation speaks for (Eric, 07/10): an Expansão deal of a
 * brand client, or Sofia's Expansão conversation once she knows the brand.
 * Null means Wings Company.
 */
export async function brandVoiceOf(
  db: Database,
  leadId: string | null,
  conversationId: string | null,
): Promise<string | null> {
  if (leadId) {
    const [row] = await db
      .select({ pipeline: leads.pipeline, clientId: leads.clientId, name: clients.name })
      .from(leads)
      .innerJoin(clients, eq(clients.id, leads.clientId))
      .where(eq(leads.id, leadId));
    if (row)
      return row.pipeline === 'expansao' && row.clientId !== WINGS_CLIENT_ID ? row.name : null;
  }
  if (!conversationId) return null;
  const [row] = await db
    .select({ segment: waConversations.segment, name: clients.name })
    .from(waConversations)
    .innerJoin(clients, eq(clients.id, waConversations.brandClientId))
    .where(eq(waConversations.id, conversationId));
  return row?.segment === 'expansao' ? row.name : null;
}

export interface ThreadDeps {
  db: Database;
  env: Env;
  fetchImpl: typeof fetch;
  now: Date;
}

export async function buildThread(
  deps: ThreadDeps,
  contact: Contact | null,
  leadId: string | null,
  conversationId: string | null,
): Promise<DealWhatsApp> {
  const { db } = deps;
  const config = whatsappConfigOf(deps.env);
  const rows = conversationId
    ? await db
        .select()
        .from(waMessages)
        .where(eq(waMessages.conversationId, conversationId))
        .orderBy(desc(waMessages.createdAt))
        .limit(MESSAGES_SHOWN)
    : leadId
      ? await db
          .select()
          .from(waMessages)
          .where(eq(waMessages.leadId, leadId))
          .orderBy(desc(waMessages.createdAt))
          .limit(MESSAGES_SHOWN)
      : [];
  rows.reverse();
  const authors = await authorsOf(db, rows);
  const pick = { id: waConversations.id, attendance: waConversations.attendance };
  const [conversation] = conversationId
    ? await db.select(pick).from(waConversations).where(eq(waConversations.id, conversationId))
    : leadId
      ? await db
          .select(pick)
          .from(waConversations)
          .where(eq(waConversations.leadId, leadId))
          .orderBy(desc(waConversations.lastMessageAt))
          .limit(1)
      : [];
  return {
    conversationId: conversationId ?? conversation?.id ?? null,
    leadId,
    profileName: contact?.profileName ?? null,
    configured: config !== null,
    calling: await callingOn(deps.fetchImpl, config),
    phone: contact?.phone ?? null,
    window: windowOf(contact, deps.now),
    optedOut: Boolean(contact?.optOutAt),
    callPermission: permissionOf(contact, deps.now),
    attendance: (conversation?.attendance as SofiaState | undefined) ?? null,
    speaksFor: await brandVoiceOf(db, leadId, conversation?.id ?? null),
    messages: rows.map((row) => toMessage(row, authors)),
  };
}
