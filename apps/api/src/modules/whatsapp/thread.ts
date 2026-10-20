import {
  brazilianPhoneVariants,
  WINGS_CLIENT_ID,
  WA_KIND_LABELS,
  WA_MEDIA_KINDS,
  WA_MESSAGES_PAGE,
  WA_WINDOW_HOURS,
  type BrandArticle,
  type DealWhatsApp,
  type WaConversationItem,
  type SofiaState,
  type WaCallPermission,
  type WaCallPermissionState,
  type WaMessage,
  type WaMessageKind,
  type WaMessageStatus,
  type WaQuote,
} from '@wings/shared';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
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

type Reactions = { emoji: string; direction: 'in' | 'out' }[];

/** What a page's replies and reactions point at, and the reactions on its messages, by wamid. */
export interface MessageLinks {
  quoted: Map<string, MessageRow>;
  reactions: Map<string, Reactions>;
}
const NO_LINKS: MessageLinks = { quoted: new Map(), reactions: new Map() };

/**
 * The messages a page's replies quote and reactions are for, and the reactions
 * on the page's own messages, looked up only inside `scope` (the page's own
 * deal or conversation), so nothing of another deal shows.
 */
export async function linksOf(
  db: Database,
  rows: MessageRow[],
  scope: SQL | undefined,
): Promise<MessageLinks> {
  if (!scope) return NO_LINKS;
  const wanted = new Set<string>();
  for (const row of rows) {
    const content = row.content as { replyTo?: unknown; reactionTo?: unknown } | null;
    for (const wamid of [content?.replyTo, content?.reactionTo])
      if (typeof wamid === 'string') wanted.add(wamid);
  }
  const own = rows.flatMap((row) => (row.wamid && row.kind !== 'reaction' ? [row.wamid] : []));
  const quoted = wanted.size
    ? await db
        .select()
        .from(waMessages)
        .where(and(scope, inArray(waMessages.wamid, [...wanted])))
    : [];
  const target = sql<string>`${waMessages.content} ->> 'reactionTo'`;
  const reacting = own.length
    ? await db
        .select({ target, direction: waMessages.direction, emoji: waMessages.text })
        .from(waMessages)
        .where(and(scope, eq(waMessages.kind, 'reaction'), inArray(target, own)))
        .orderBy(
          sql`coalesce(${waMessages.waTimestamp}, ${waMessages.createdAt})`,
          waMessages.createdAt,
        )
    : [];
  // Each side's last reaction wins, as on WhatsApp; an empty one took it back.
  const last = new Map<string, Map<'in' | 'out', string | null>>();
  for (const reaction of reacting) {
    const sides = last.get(reaction.target) ?? new Map<'in' | 'out', string | null>();
    sides.set(reaction.direction === 'out' ? 'out' : 'in', reaction.emoji);
    last.set(reaction.target, sides);
  }
  const reactions = new Map<string, Reactions>();
  for (const [wamid, sides] of last)
    reactions.set(
      wamid,
      [...sides].flatMap(([direction, emoji]) => (emoji ? [{ emoji, direction }] : [])),
    );
  return { quoted: new Map(quoted.map((row) => [row.wamid!, row])), reactions };
}

function quoteOf(wamid: unknown, links: MessageLinks): WaQuote | null {
  if (typeof wamid !== 'string') return null;
  const row = links.quoted.get(wamid);
  return row
    ? {
        found: true,
        id: row.id,
        direction: row.direction === 'out' ? 'out' : 'in',
        kind: row.kind as WaMessageKind,
        text: row.text?.slice(0, 300) ?? null,
      }
    : { found: false };
}

export function toMessage(
  row: MessageRow,
  authors: Map<string, string>,
  links: MessageLinks = NO_LINKS,
): WaMessage {
  const content = (row.content ?? {}) as Record<string, unknown>;
  const media = content.media as { mimeType?: string | null; filename?: string | null } | undefined;
  const template = content.template as { name?: string; language?: string } | undefined;
  const imported = content.imported as { file?: string | null; omitted?: boolean } | undefined;
  // An imported outgoing line went from the phone: no status of ours to show.
  const tracked = row.direction === 'out' && row.importBatchId === null;
  return {
    id: row.id,
    direction: row.direction === 'out' ? 'out' : 'in',
    kind: row.kind as WaMessageKind,
    text: row.text,
    replyTo: quoteOf(content.replyTo, links),
    reactionTo:
      row.kind === 'reaction' ? (quoteOf(content.reactionTo, links) ?? { found: false }) : null,
    reactions: row.wamid ? (links.reactions.get(row.wamid) ?? []) : [],
    media:
      media && WA_MEDIA_KINDS.includes(row.kind as WaMessageKind)
        ? { mimeType: media.mimeType ?? null, filename: media.filename ?? null }
        : null,
    template:
      template?.name && template.language
        ? { name: template.name, language: template.language }
        : null,
    fromTemplate:
      typeof (content.fromTemplate as { name?: unknown } | undefined)?.name === 'string'
        ? (content.fromTemplate as { name: string }).name
        : null,
    withArt: Boolean(content.art),
    status: tracked ? ((row.status ?? 'pending') as WaMessageStatus) : null,
    error: tracked ? errorText(row.errorCode, row.errorTitle) : null,
    authorName: row.employeeId ? (authors.get(row.employeeId) ?? null) : null,
    bySofia: row.author === 'sofia',
    imported: row.importBatchId
      ? { file: imported?.file ?? null, omitted: imported?.omitted === true }
      : null,
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

/** The brand a conversation speaks for, with what its WhatsApp header needs. */
export interface BrandVoice {
  clientId: string;
  name: string;
  /** "o"/"a" before the name; null while nobody said. */
  article: BrandArticle | null;
  /** The art at the head of its templates, when registered. */
  artFileId: string | null;
}

const voiceColumns = {
  clientId: clients.id,
  name: clients.name,
  article: clients.article,
  artFileId: clients.whatsappArtFileId,
};

const voiceOf = (row: {
  clientId: string | null;
  name: string | null;
  article: string | null;
  artFileId: string | null;
}): BrandVoice | null =>
  row.clientId && row.name
    ? {
        clientId: row.clientId,
        name: row.name,
        article: row.article === 'o' || row.article === 'a' ? row.article : null,
        artFileId: row.artFileId,
      }
    : null;

/**
 * The brand a conversation speaks for (Eric, 07/10): an Expansão deal of a
 * brand client, or Sofia's Expansão conversation once she knows the brand.
 * Null means Wings Company.
 */
export async function brandOf(
  db: Database,
  leadId: string | null,
  conversationId: string | null,
): Promise<BrandVoice | null> {
  // Sofia's brand in the conversation wins: the deal may still be Wings' when
  // the person came by a brand's link.
  const [conversation] = conversationId
    ? await db
        .select({ segment: waConversations.segment, ...voiceColumns })
        .from(waConversations)
        .leftJoin(clients, eq(clients.id, waConversations.brandClientId))
        .where(eq(waConversations.id, conversationId))
    : leadId
      ? await db
          .select({ segment: waConversations.segment, ...voiceColumns })
          .from(waConversations)
          .leftJoin(clients, eq(clients.id, waConversations.brandClientId))
          .where(eq(waConversations.leadId, leadId))
          .orderBy(desc(waConversations.lastMessageAt))
          .limit(1)
      : [];
  if (conversation?.segment === 'expansao' && conversation.name) return voiceOf(conversation);
  if (leadId) {
    const [row] = await db
      .select({ pipeline: leads.pipeline, ...voiceColumns })
      .from(leads)
      .innerJoin(clients, eq(clients.id, leads.clientId))
      .where(eq(leads.id, leadId));
    if (row)
      return row.pipeline === 'expansao' && row.clientId !== WINGS_CLIENT_ID ? voiceOf(row) : null;
  }
  return null;
}

/** The brand's name only (null: Wings Company). */
export async function brandVoiceOf(
  db: Database,
  leadId: string | null,
  conversationId: string | null,
): Promise<string | null> {
  return (await brandOf(db, leadId, conversationId))?.name ?? null;
}

/** A row of the conversation lists (the WhatsApp screen and Sofia's), in the reader's scope. */
export interface ConversationListRow extends Record<string, unknown> {
  id: string;
  lead_id: string | null;
  lead_name: string | null;
  lead_pipeline: string | null;
  owner_name: string | null;
  profile_name: string | null;
  phone: string;
  last_inbound_at: Date | string | null;
  last_message_at: Date | string | null;
  attendance: string;
  segment: string | null;
  state_changed_at: Date | string | null;
  reason: string | null;
  brand_name: string | null;
  direction: string | null;
  kind: string | null;
  text: string | null;
  status: string | null;
  unread: number;
}

/**
 * The conversations a reader may see (`owner` = their id when they see only
 * their own deals' ones), newest first, with the last message and how many
 * of the person's messages this reader has not opened (after their last
 * opening, or after our last reply when they never opened it).
 */
export function conversationListSql(input: {
  owner: string | undefined;
  readerId: string;
  where: SQL;
  limit: number;
}) {
  return sql`
    select c.id, c.lead_id, l.name as lead_name, l.pipeline as lead_pipeline,
           e.full_name as owner_name, k.profile_name, k.phone, k.last_inbound_at,
           c.last_message_at, c.attendance, c.segment, c.state_changed_at, c.reason,
           b.name as brand_name, m.direction, m.kind, m.text, m.status,
           (select count(*)::int from wa_messages u
             where u.conversation_id = c.id and u.direction = 'in' and u.import_batch_id is null
               and u.created_at > coalesce(
                 (select r.read_at from wa_conversation_reads r
                   where r.conversation_id = c.id and r.employee_id = ${input.readerId}),
                 (select max(o.created_at) from wa_messages o
                   where o.conversation_id = c.id and o.direction = 'out'),
                 '-infinity'::timestamptz)) as unread
    from wa_conversations c
    join wa_contacts k on k.id = c.contact_id
    left join leads l on l.id = c.lead_id
    left join employees e on e.id = l.owner_employee_id
    left join clients b on b.id = c.brand_client_id
    left join lateral (
      select direction, kind, text, status from wa_messages
      where conversation_id = c.id order by created_at desc limit 1
    ) m on true
    where c.last_message_at is not null
      ${input.owner === undefined ? sql`` : sql`and l.owner_employee_id = ${input.owner}`}
      ${input.where}
    order by c.last_message_at desc
    limit ${input.limit}`;
}

export function conversationItemOf(row: ConversationListRow, now: Date): WaConversationItem {
  const lastInbound = row.last_inbound_at ? new Date(row.last_inbound_at) : null;
  const kind = (row.kind ?? 'text') as WaMessageKind;
  return {
    conversationId: row.id,
    leadId: row.lead_id,
    leadName: row.lead_name,
    profileName: row.profile_name,
    phone: row.phone,
    lastAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
    lastDirection: row.direction === 'in' ? 'in' : row.direction === 'out' ? 'out' : null,
    preview: row.text ? row.text.slice(0, 80) : row.kind ? WA_KIND_LABELS[kind] : null,
    unanswered: row.direction === 'in',
    windowOpen:
      lastInbound !== null && lastInbound.getTime() + WA_WINDOW_HOURS * 3_600_000 > now.getTime(),
    unreadCount: Number(row.unread ?? 0),
    lastStatus: row.direction === 'out' ? ((row.status ?? 'pending') as WaMessageStatus) : null,
    attendance: row.attendance as SofiaState,
    ownerName: row.owner_name,
  };
}

/** The reader has seen the conversation up to its last message (the database's clock). */
export async function markConversationRead(
  db: Database,
  conversationId: string,
  employeeId: string,
) {
  await db.execute(sql`
    insert into wa_conversation_reads (conversation_id, employee_id, read_at)
    select ${conversationId}, ${employeeId}, coalesce(max(created_at), now())
    from wa_messages where conversation_id = ${conversationId}
    on conflict (conversation_id, employee_id)
    do update set read_at = greatest(wa_conversation_reads.read_at, excluded.read_at)`);
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
  const scope = conversationId
    ? eq(waMessages.conversationId, conversationId)
    : leadId
      ? eq(waMessages.leadId, leadId)
      : undefined;
  const rows = scope
    ? await db
        .select()
        .from(waMessages)
        .where(scope)
        .orderBy(desc(waMessages.createdAt))
        .limit(WA_MESSAGES_PAGE)
    : [];
  rows.reverse();
  const authors = await authorsOf(db, rows);
  const links = await linksOf(db, rows, scope);
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
    messages: rows.map((row) => toMessage(row, authors, links)),
  };
}

/**
 * The deal's messages older than the message `beforeId`, a page at a time ("Mostrar anteriores").
 * Compared in the database: its timestamps have microseconds, a JS Date has not. The caller checked access.
 */
export async function olderMessages(
  db: Database,
  leadId: string,
  beforeId: string,
): Promise<WaMessage[]> {
  const rows = await db
    .select()
    .from(waMessages)
    .where(
      and(
        eq(waMessages.leadId, leadId),
        sql`(${waMessages.createdAt}, ${waMessages.id}) < (select o.created_at, o.id from wa_messages o where o.id = ${beforeId} and o.lead_id = ${leadId})`,
      ),
    )
    .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
    .limit(WA_MESSAGES_PAGE);
  rows.reverse();
  const authors = await authorsOf(db, rows);
  const links = await linksOf(db, rows, eq(waMessages.leadId, leadId));
  return rows.map((row) => toMessage(row, authors, links));
}
