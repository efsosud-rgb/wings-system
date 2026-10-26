import {
  brazilianPhoneVariants,
  WINGS_CLIENT_ID,
  WA_KIND_LABELS,
  WA_MEDIA_KINDS,
  WA_MESSAGES_PAGE,
  WA_WINDOW_HOURS,
  withArticle,
  type BrandArticle,
  type DealWhatsApp,
  type WaConversationItem,
  type SofiaState,
  type WaCallPermission,
  type WaCallPermissionState,
  type WaChatNumber,
  type WaMessage,
  type WaMessageKind,
  type WaMessageStatus,
  type WaQuote,
} from '@wings/shared';
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  clients,
  employees,
  leads,
  waContacts,
  waConversations,
  waMessages,
  waNumbers,
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
    // A card from before the numbers were kept holds only their count.
    contacts:
      row.kind === 'contacts' && Array.isArray(content.contacts)
        ? (content.contacts as { name: string | null; phones: string[] }[])
        : null,
    location:
      row.kind === 'location' && content.location
        ? (content.location as NonNullable<WaMessage['location']>)
        : null,
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

/**
 * What the person sees above Meta's "Permitir ligações" buttons (a brand's
 * lead hears the brand, with its own article: "O Casal do Churros", "A Cabana
 * da Barra" — never "A A Cabana").
 */
export const callPermissionText = (brand: Pick<BrandVoice, 'name' | 'article'> | null) => {
  const who = brand ? withArticle(brand.name, brand.article ?? 'a', 'article') : 'a Wings';
  return `${who.charAt(0).toUpperCase()}${who.slice(1)} gostaria de poder te ligar pelo WhatsApp para continuar o seu atendimento.`;
};

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
          .where(and(eq(waConversations.leadId, leadId), isNull(waConversations.numberId)))
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
  /** With `textLike`: the latest message whose text matched (`f` in the query). */
  match_text?: string | null;
  match_at?: Date | string | null;
  /** `last_message_at` with its microseconds, for the next page's cursor. */
  cursor_at: string | null;
  phone_contact_name: string | null;
  number_id: string | null;
  number_label: string | null;
  number_phone: string | null;
  number_owner_name: string | null;
}

/**
 * A message `u` of the conversation `c` that the reader has not opened: the
 * person's, after the reader's last opening, or after our last reply when they
 * never opened it. One rule for the list's counts and the inbox total.
 */
export const unreadMessageOf = (readerId: string) => sql`
  u.conversation_id = c.id and u.direction = 'in' and u.import_batch_id is null
  and (u.content ->> 'history') is null
  and u.created_at > coalesce(
    (select r.read_at from wa_conversation_reads r
      where r.conversation_id = c.id and r.employee_id = ${readerId}),
    (select max(o.created_at) from wa_messages o
      where o.conversation_id = c.id and o.direction = 'out' and o.author <> 'system'),
    '-infinity'::timestamptz)`;

/**
 * The conversations a reader reaches (`owner` = their id when they see only their own): an
 * official one through its deal's owner, a work number's chat through the number's owner. Needs
 * `c`, `l` (the deal) and `n` (the number) in the query.
 */
export const reachOf = (owner: string | undefined) =>
  owner === undefined
    ? sql``
    : sql`and ((c.number_id is null and l.owner_employee_id = ${owner}) or n.owner_employee_id = ${owner})`;

/** An ILIKE pattern that finds `term` as typed: `%`, `_` and `\` in it are plain characters. */
export const likeOf = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The conversations a reader may see (`reachOf`), newest first, with the last
 * message and how many of the person's messages this reader has not opened
 * (`unreadMessageOf`). With `textLike`, each row also brings its latest message
 * whose text matches (`f`), for `where` to filter on: the same conversations, so
 * the same reach.
 */
export function conversationListSql(input: {
  owner: string | undefined;
  readerId: string;
  where: SQL;
  limit: number;
  textLike?: string;
}) {
  return sql`
    select c.id, c.lead_id, l.name as lead_name, l.pipeline as lead_pipeline,
           e.full_name as owner_name, k.profile_name, k.phone, k.last_inbound_at,
           c.last_message_at, c.last_message_at::text as cursor_at, c.attendance, c.segment,
           c.state_changed_at, c.reason, b.name as brand_name, m.direction, m.kind, m.text, m.status,
           c.phone_contact_name, c.number_id, n.label as number_label,
           coalesce(n.phone, n.display_phone) as number_phone, ne.full_name as number_owner_name,
           (select count(*)::int from wa_messages u
             where ${unreadMessageOf(input.readerId)}) as unread
           ${input.textLike ? sql`, f.text as match_text, f.at as match_at` : sql``}
    from wa_conversations c
    join wa_contacts k on k.id = c.contact_id
    left join leads l on l.id = c.lead_id
    left join employees e on e.id = l.owner_employee_id
    left join clients b on b.id = c.brand_client_id
    left join wa_numbers n on n.id = c.number_id
    left join employees ne on ne.id = n.owner_employee_id
    left join lateral (
      select direction, kind, text, status from wa_messages
      -- The system's own call-permission request is not an answer: the conversation stays waiting.
      where conversation_id = c.id and author <> 'system' order by created_at desc limit 1
    ) m on true
    ${
      input.textLike
        ? sql`left join lateral (
            select s.text, coalesce(s.wa_timestamp, s.created_at) as at from wa_messages s
            where s.conversation_id = c.id and s.kind <> 'reaction'
              and s.text ilike ${input.textLike}
            order by s.created_at desc limit 1
          ) f on true`
        : sql``
    }
    where c.last_message_at is not null
      ${reachOf(input.owner)}
      ${input.where}
    order by c.last_message_at desc, c.id desc
    limit ${input.limit}`;
}

/** About `size` characters of a found message around the first place `term` is. */
export function snippetOf(text: string, term: string, size = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= size) return flat;
  const at = flat
    .toLocaleLowerCase('pt-BR')
    .indexOf(term.replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR'));
  const start = Math.max(0, Math.min(at - 20, flat.length - size));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + size)}${start + size < flat.length ? '…' : ''}`;
}

export function conversationItemOf(
  row: ConversationListRow,
  now: Date,
  term?: string,
): WaConversationItem {
  const lastInbound = row.last_inbound_at ? new Date(row.last_inbound_at) : null;
  const kind = (row.kind ?? 'text') as WaMessageKind;
  return {
    conversationId: row.id,
    leadId: row.lead_id,
    leadName: row.lead_name,
    // The name the number's owner saved in the phone, before the person's own profile name.
    profileName: row.phone_contact_name ?? row.profile_name,
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
    number: row.number_id
      ? {
          id: row.number_id,
          label: row.number_label,
          phone: row.number_phone,
          ownerName: row.number_owner_name,
        }
      : null,
    ...(term !== undefined && {
      match:
        row.match_text && row.match_at
          ? { text: snippetOf(row.match_text, term), at: new Date(row.match_at).toISOString() }
          : null,
    }),
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

/** A deal's messages on the official number (a work number's chat is opened in the Central). */
const officialOfLead = (leadId: string) =>
  and(
    eq(waMessages.leadId, leadId),
    sql`${waMessages.conversationId} in (select w.id from wa_conversations w where w.number_id is null)`,
  );

/** A work number as a chat shows it, and whether it can send now (connected, with its token). */
export async function chatNumberOf(
  db: Database,
  numberId: string,
): Promise<{ number: WaChatNumber; connected: boolean } | null> {
  const [row] = await db
    .select({
      id: waNumbers.id,
      label: waNumbers.label,
      phone: sql<string | null>`coalesce(${waNumbers.phone}, ${waNumbers.displayPhone})`,
      ownerName: employees.fullName,
      status: waNumbers.status,
      token: sql<boolean>`${waNumbers.tokenEnc} is not null`,
    })
    .from(waNumbers)
    .leftJoin(employees, eq(employees.id, waNumbers.ownerEmployeeId))
    .where(eq(waNumbers.id, numberId));
  if (!row) return null;
  const { status, token, ...number } = row;
  return { number, connected: status === 'connected' && token };
}

/**
 * Meta's 24-hour window on a work number: from the person's last message to that number, which
 * lives in the chat (the contact's `last_inbound_at` is the official number's).
 */
export async function numberWindowOf(db: Database, conversationId: string, now: Date) {
  const [last] = await db
    .select({
      at: sql<string | null>`max(coalesce(${waMessages.waTimestamp}, ${waMessages.createdAt}))`,
    })
    .from(waMessages)
    .where(and(eq(waMessages.conversationId, conversationId), eq(waMessages.direction, 'in')));
  const lastInboundAt = last?.at ? new Date(last.at) : null;
  return windowOf({ lastInboundAt } as Contact, now);
}

export async function buildThread(
  deps: ThreadDeps,
  contact: Contact | null,
  leadId: string | null,
  conversationId: string | null,
): Promise<DealWhatsApp> {
  const { db } = deps;
  const scope = conversationId
    ? eq(waMessages.conversationId, conversationId)
    : leadId
      ? officialOfLead(leadId)
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
  const pick = {
    id: waConversations.id,
    attendance: waConversations.attendance,
    numberId: waConversations.numberId,
  };
  const [conversation] = conversationId
    ? await db.select(pick).from(waConversations).where(eq(waConversations.id, conversationId))
    : leadId
      ? await db
          .select(pick)
          .from(waConversations)
          .where(and(eq(waConversations.leadId, leadId), isNull(waConversations.numberId)))
          .orderBy(desc(waConversations.lastMessageAt))
          .limit(1)
      : [];
  const onNumber = conversation?.numberId ? await chatNumberOf(db, conversation.numberId) : null;
  // A work number sends with its own token: no call, no opt-out of the official number.
  const config = onNumber ? null : whatsappConfigOf(deps.env);
  return {
    conversationId: conversationId ?? conversation?.id ?? null,
    leadId,
    profileName: contact?.profileName ?? null,
    configured: onNumber ? onNumber.connected : config !== null,
    calling: onNumber ? false : await callingOn(deps.fetchImpl, config),
    phone: contact?.phone ?? null,
    window:
      onNumber && conversation
        ? await numberWindowOf(db, conversation.id, deps.now)
        : windowOf(contact, deps.now),
    optedOut: onNumber ? false : Boolean(contact?.optOutAt),
    callPermission: permissionOf(onNumber ? null : contact, deps.now),
    attendance: (conversation?.attendance as SofiaState | undefined) ?? null,
    speaksFor: await brandVoiceOf(db, leadId, conversation?.id ?? null),
    number: onNumber?.number ?? null,
    numberChats: [],
    messages: rows.map((row) => toMessage(row, authors, links)),
  };
}

/**
 * The deal's official messages older than the message `beforeId`, a page at a time ("Mostrar
 * anteriores"). Compared in the database: its timestamps have microseconds, a JS Date has not.
 * The caller checked access.
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
        officialOfLead(leadId),
        sql`(${waMessages.createdAt}, ${waMessages.id}) < (select o.created_at, o.id from wa_messages o where o.id = ${beforeId} and o.lead_id = ${leadId})`,
      ),
    )
    .orderBy(desc(waMessages.createdAt), desc(waMessages.id))
    .limit(WA_MESSAGES_PAGE);
  rows.reverse();
  const authors = await authorsOf(db, rows);
  const links = await linksOf(db, rows, officialOfLead(leadId));
  return rows.map((row) => toMessage(row, authors, links));
}
