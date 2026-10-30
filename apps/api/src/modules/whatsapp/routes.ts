import {
  grantedScope,
  brazilianPhoneVariants,
  normalizeBrazilianPhone,
  mentionsWings,
  canonicalWhatsAppPhone,
  WHATSAPP_OPT_IN_MISSING_TEXT,
  withArticle,
  templateParamCount,
  waTemplateFamily,
  waTemplateSendSchema,
  waCallPermissionRequestSchema,
  WA_CALL_REQUEST_LANGUAGE,
  WA_CALL_REQUEST_TEMPLATES,
  waSendKindOf,
  waSendMediaSchema,
  waSendTextSchema,
  waVoiceRecordingType,
  WA_VOICE_MAX_SECONDS,
  WA_VOICE_UPLOAD_MAX_BYTES,
  WA_ART_SUFFIX,
  WA_INBOX_PAGE,
  WA_TEXT_SEARCH_MIN,
  waInboxQuerySchema,
  waNumberStartSchema,
  waAssignSchema,
  waAssignmentSettingsSchema,
  waSofiaSwitchSchema,
  waVersionSchema,
  type SofiaSegment,
  type WaArtLink,
  type WaChatNumber,
  type WaConversationItem,
  type WaInboxPage,
  type WaSendKind,
  type WaNewTarget,
  type WaTemplate,
  type WaCallPermission,
  type WaCallPermissionLive,
  CONTACT_BLOCKED_ERROR,
} from '@wings/shared';
import { and, asc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  driveFiles,
  driveFileVersions,
  employees,
  waContacts,
  waConversations,
  waMessageFiles,
  waMessages,
  waNumberTemplates,
  waNumbers,
  waTemplates,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { numberConfigOf } from './numbers.js';
import { linkNumberChat } from './number-intake.js';
import {
  leadOptInMissing,
  officialNumberLive,
  sellerWhatsAppLocked,
  SELLER_SOON_MESSAGE,
  setOfficialNumberLive,
} from './official-number.js';
import { leadInScope, leadOwnerFilter } from '../leads/access.js';
import { dealRouteAccessOf } from '../drive/access.js';
import { DriveError, fileFor } from '../drive/service.js';
import { leadHasFile, storeLeadFile } from '../leads/files.js';
import { toVoiceNote, voiceFileName } from './voice.js';
import { contactBlock, noteContactBlocked } from '../leads/contact-block.js';
import { storageOf } from '../../lib/storage/index.js';
import {
  ART_MEDIA_GONE_CODES,
  artLink,
  artMediaId,
  driveFileMediaId,
  invalidateArtMedia,
  type ArtDeps,
} from './art.js';
import {
  downloadWhatsAppMedia,
  errorText,
  filePayload,
  textPayload,
  callPermissionPayload,
  readCallPermission,
  whatsappConfigOf,
  type OutgoingPayload,
} from './graph.js';
import { deliverWhatsApp, type Contact } from './outbox.js';
import {
  authorsOf,
  brandOf,
  buildThread,
  conversationItemOf,
  conversationListSql,
  holderSql,
  likeOf,
  unreadMessageOf,
  markConversationRead,
  numberWindowOf,
  type ConversationListRow,
  contactOfPhone,
  permissionOf,
  toMessage,
  windowOf,
  callPermissionText,
} from './thread.js';
import {
  assignmentModeOf,
  heldByOther,
  holdForSend,
  reopen,
  resolve,
  sendToQueue,
  setAssignmentMode,
  startReplying,
  switchSofia,
  takeOver,
  transfer,
  type ActionInput,
} from './attendance.js';
import { attendanceRefusal, AttendanceError } from './attendance-errors.js';
import { attendanceView } from './attendance-view.js';
import { loadSofiaSettings } from '../sofia/settings.js';
import { factListOf } from '../sofia/state.js';
import { adoptUnmatched, conversationFor, openConversation } from './intake.js';
import { syncNumberTemplates, syncTemplates } from './templates.js';
import { inboxSummaryOf } from './inbox.js';
import { callRequestRefusal } from './call-request-limit.js';
import { notifyInboxChanged } from './inbox-signal.js';
import {
  payloadOf,
  planTemplateFor,
  asksCallPermission,
  templateBody,
  templateContextOf,
  unsupportedOf,
  type TemplatePlan,
} from './template-send.js';

export { templateBody } from './template-send.js';

/**
 * The deal's WhatsApp (docs/whatsapp/cloud-api.md). One permission,
 * `leads.whatsapp`, in the lead's owner scope (Admin and Diretoria every
 * lead, a seller only their own): reading the conversation, sending and,
 * later, calling. A conversation no deal took yet is only for a full-scope
 * holder. Free text only inside the 24-hour window, checked here; outside it
 * only an approved template. A send is written first, made once, never
 * retried; nothing about the person is logged.
 */

const TEMPLATES_FRESH_MS = 6 * 3_600_000;

const idParams = z.object({ id: z.uuid() });

/** Why a conversation with no deal cannot send a file (the screen shows the same). */
const NO_DEAL_FOR_FILES =
  'O arquivo fica nos arquivos da negociação: esta conversa ainda não tem negociação.';

export const whatsappRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();
  const fetchImpl = () => app.wings.whatsappFetch ?? fetch;
  const use = { preHandler: app.requirePermission('leads.whatsapp') };
  const artDeps = (): ArtDeps => ({ db, storage: storageOf(app.wings), now });

  const notFound = (reply: FastifyReply) =>
    reply.status(404).send({ error: 'not_found', message: 'Conversa não encontrada.' });
  const off = (reply: FastifyReply) =>
    reply.status(503).send({
      error: 'whatsapp_off',
      message: 'O WhatsApp oficial ainda não está ligado no sistema.',
    });
  const fullScope = (request: FastifyRequest) =>
    leadOwnerFilter(request.session.actor, 'leads.whatsapp') === undefined;

  const threadOf = (
    contact: Contact | null,
    leadId: string | null,
    conversationId: string | null,
  ) =>
    buildThread({ db, env, fetchImpl: fetchImpl(), now: now() }, contact, leadId, conversationId);

  const box = env.INTEGRATIONS_ENCRYPTION_KEY
    ? createSecretBox(env.INTEGRATIONS_ENCRYPTION_KEY)
    : null;

  /**
   * The work numbers a reader reaches (docs/whatsapp/central.md): their own, or every one at full
   * scope. `numberId` narrows to one.
   */
  const chatNumbersOf = async (request: FastifyRequest, numberId?: string) => {
    const owner = leadOwnerFilter(request.session.actor, 'leads.whatsapp');
    return db
      .select({
        id: waNumbers.id,
        label: waNumbers.label,
        phone: sql<string | null>`coalesce(${waNumbers.phone}, ${waNumbers.displayPhone})`,
        ownerName: employees.fullName,
        sector: waNumbers.sector,
        connected: sql<boolean>`${waNumbers.status} = 'connected' and ${waNumbers.tokenEnc} is not null`,
      })
      .from(waNumbers)
      .leftJoin(employees, eq(employees.id, waNumbers.ownerEmployeeId))
      .where(
        and(
          owner === undefined ? undefined : eq(waNumbers.ownerEmployeeId, owner),
          numberId ? eq(waNumbers.id, numberId) : undefined,
        ),
      )
      .orderBy(asc(waNumbers.label));
  };

  // --- reading ------------------------------------------------------------------------

  app.get('/leads/:id/whatsapp', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const lead = await leadInScope(db, request.session.actor, params.data.id, 'leads.whatsapp');
    if (!lead) return notFound(reply);
    const contact = await contactOfPhone(db, lead.phone);
    // Messages that waited with no deal come to this one (same phone) — but a
    // conversation Sofia or the team is still handling is not a seller's to take.
    if (contact) {
      const waiting = await db.query.waConversations.findFirst({
        where: and(
          eq(waConversations.contactId, contact.id),
          isNull(waConversations.leadId),
          isNull(waConversations.numberId),
        ),
        columns: { attendance: true },
      });
      if (waiting && (fullScope(request) || waiting.attendance === 'closed'))
        await adoptUnmatched(db, contact.id, lead.id);
    }
    const data = await threadOf(contact, lead.id, null);
    // The deal's chats on work numbers the reader reaches: opened in the Central.
    const reached = new Map((await chatNumbersOf(request)).map((n) => [n.id, n]));
    const chats = await db
      .select({ conversationId: waConversations.id, numberId: waConversations.numberId })
      .from(waConversations)
      .where(and(eq(waConversations.leadId, lead.id), isNotNull(waConversations.numberId)));
    const numberChats = chats.flatMap(({ conversationId, numberId }) => {
      const found = numberId ? reached.get(numberId) : undefined;
      if (!found) return [];
      const number: WaChatNumber = {
        id: found.id,
        label: found.label,
        phone: found.phone,
        ownerName: found.ownerName,
      };
      return [{ conversationId, number }];
    });
    return reply.send({ ...data, phone: lead.phone, numberChats });
  });

  /**
   * The reader's WhatsApp, as in WhatsApp Web: the conversations of their deals
   * (every conversation for Admin and Diretoria), newest first, with search,
   * unread (per reader) and the last message's status.
   */
  // The official number's switch (Eric, 14/10): read by everyone with the inbox, flipped by an
  // Admin Master on the day the number is swapped.
  app.get('/whatsapp/official-number', use, async (_request, reply) =>
    reply.send({ live: await officialNumberLive(db) }),
  );

  app.put(
    '/whatsapp/official-number',
    { preHandler: app.requirePermission('integrations.manage') },
    async (request, reply) => {
      const body = z.object({ live: z.boolean() }).safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: 'invalid_request', message: 'Dados inválidos' });
      await setOfficialNumberLive(db, body.data.live, request.session.actor.employeeId);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'whatsapp.official_number_switched',
        entity: 'whatsapp_settings',
        entityId: null,
        ip: request.ip,
        metadata: { live: body.data.live },
      });
      return reply.send({ live: body.data.live });
    },
  );

  app.get('/whatsapp/conversations', use, async (request, reply) => {
    const query = waInboxQuerySchema.safeParse(request.query);
    if (!query.success)
      return reply.status(400).send({ error: 'invalid', message: 'Filtro inválido.' });
    const { number, sector, state, from, to, before } = query.data;
    const filter = query.data.filter ?? (query.data.unanswered === '1' ? 'unanswered' : 'all');
    const q = query.data.q || undefined;
    const digits = q?.replace(/\D/g, '') ?? '';
    const like = q ? likeOf(q) : '';
    // Inside the messages too (Eric, 20/10), from a few letters on. The request log drops the
    // query string; a database error's message would carry it, as on every route (docs).
    const textLike = q && q.length >= WA_TEXT_SEARCH_MIN ? like : undefined;
    const readerId = request.session.actor.employeeId;
    // The page's cursor: the last row's time (with its microseconds) and id.
    const cursor = before?.match(/^(.+)\|([0-9a-f-]{36})$/i);
    if (before && (!cursor || Number.isNaN(Date.parse(cursor[1]!))))
      return reply.status(400).send({ error: 'invalid', message: 'Página inválida.' });
    // The responsible: who answers it (attendance.ts).
    const responsible = holderSql;
    const rows = await db.execute<ConversationListRow>(
      conversationListSql({
        owner: leadOwnerFilter(request.session.actor, 'leads.whatsapp'),
        readerId,
        limit: WA_INBOX_PAGE + 1,
        textLike,
        where: sql`
          ${filter === 'unanswered' ? sql`and m.direction = 'in'` : sql``}
          ${
            // In the query, so a page is a page of unread ones: the menu counts them all (inbox.ts).
            filter === 'unread'
              ? sql`and exists (select 1 from wa_messages u where ${unreadMessageOf(readerId)})`
              : sql``
          }
          ${filter === 'mine' ? sql`and ${responsible} = ${readerId}` : sql``}
          ${filter === 'unassigned' ? sql`and ${responsible} is null` : sql``}
          ${filter === 'human' ? sql`and c.attendance <> 'sofia'` : sql``}
          ${filter === 'sofia' ? sql`and c.attendance = 'sofia'` : sql``}
          ${
            number === 'official'
              ? sql`and c.number_id is null`
              : number
                ? sql`and c.number_id = ${number}`
                : sql``
          }
          ${sector ? sql`and coalesce(c.queue, n.sector) = ${sector}` : sql``}
          ${state ? sql`and c.attendance = ${state}` : sql``}
          ${from ? sql`and c.last_message_at >= (${from}::date::timestamp at time zone 'America/Sao_Paulo')` : sql``}
          ${to ? sql`and c.last_message_at < ((${to}::date + 1)::timestamp at time zone 'America/Sao_Paulo')` : sql``}
          ${
            cursor
              ? sql`and (c.last_message_at, c.id) < (${cursor[1]}::timestamptz, ${cursor[2]}::uuid)`
              : sql``
          }
          ${
            q
              ? sql`and (k.profile_name ilike ${like} or l.name ilike ${like}
                    or c.phone_contact_name ilike ${like}
                    ${digits.length >= 4 ? sql`or k.phone like ${`%${digits}%`}` : sql``}
                    ${textLike ? sql`or f.text is not null` : sql``})`
              : sql``
          }`,
      }),
    );
    const at = now();
    const page = rows.rows.slice(0, WA_INBOX_PAGE);
    const last = page.at(-1);
    const items: WaConversationItem[] = page.map((row) =>
      conversationItemOf(row, at, textLike ? q : undefined),
    );
    return reply.send({
      conversations: items,
      next: rows.rows.length > WA_INBOX_PAGE && last ? `${last.cursor_at}|${last.id}` : null,
    } satisfies WaInboxPage);
  });

  /** The work numbers the reader reaches: the list's filter and "Nova conversa" by a number. */
  app.get('/whatsapp/chat-numbers', use, async (request, reply) =>
    reply.send({ numbers: await chatNumbersOf(request) }),
  );

  /** The menu's count of unread conversations and the stamp the screens watch (`inbox.ts`). */
  app.get('/whatsapp/inbox/summary', use, async (request, reply) =>
    reply.send(await inboxSummaryOf(db, request.session.actor)),
  );

  /** The reader opened the conversation: its messages so far are read, for them only. */
  app.post('/whatsapp/conversations/:id/read', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const found = params.success ? await visibleConversation(request, params.data.id) : null;
    if (!found) return notFound(reply);
    await markConversationRead(db, found.conversation.id, request.session.actor.employeeId);
    // The reader's other tabs (and the menu of this one) count it read at once.
    notifyInboxChanged();
    return reply.status(204).send();
  });

  /**
   * "Nova conversa": the deals in the reader's scope whose name, phone or
   * contact matches, open ones first, with the conversation each already has.
   */
  app.get('/whatsapp/targets', use, async (request, reply) => {
    const query = z.object({ q: z.string().trim().min(2).max(80) }).safeParse(request.query);
    if (!query.success) return reply.send({ targets: [] });
    const q = query.data.q;
    const digits = q.replace(/\D/g, '');
    const owner = leadOwnerFilter(request.session.actor, 'leads.whatsapp');
    const like = `%${q}%`;
    const phoneLike = digits.length >= 4 ? `%${digits}%` : null;
    const rows = await db.execute<{
      lead_id: string;
      name: string | null;
      phone: string | null;
      contact_name: string | null;
      pipeline: string | null;
      owner_name: string | null;
      won: boolean | null;
    }>(sql`
      select * from (
        select distinct on (t.lead_id) t.* from (
        select l.id as lead_id, l.name, l.phone, null::text as contact_name, l.pipeline,
               e.full_name as owner_name, l.won, l.created_at
        from leads l left join employees e on e.id = l.owner_employee_id
        where l.phone is not null
          and (l.name ilike ${like} ${phoneLike ? sql`or l.phone like ${phoneLike}` : sql``})
          ${owner === undefined ? sql`` : sql`and l.owner_employee_id = ${owner}`}
        union all
        select l.id, l.name, ct.phone, ct.name, l.pipeline, e.full_name, l.won, l.created_at
        from leads l
        join lead_contacts lc on lc.lead_id = l.id
        join crm_contacts ct on ct.id = lc.contact_id and ct.merged_into_id is null
        left join employees e on e.id = l.owner_employee_id
        where ct.phone is not null
          and (ct.name ilike ${like} ${phoneLike ? sql`or ct.phone like ${phoneLike}` : sql``})
          ${owner === undefined ? sql`` : sql`and l.owner_employee_id = ${owner}`}
        ) t
        -- One row per deal: the lead's own phone first, else the contact's that matched.
        order by t.lead_id, (t.contact_name is null) desc
      ) d
      order by (d.won is null) desc, d.created_at desc
      limit 20`);
    const targets: WaNewTarget[] = [];
    for (const row of rows.rows) {
      if (!row.phone) continue;
      const contact = await contactOfPhone(db, row.phone);
      const conversation = contact
        ? await db.query.waConversations.findFirst({
            where: and(
              eq(waConversations.contactId, contact.id),
              eq(waConversations.leadId, row.lead_id),
              isNull(waConversations.numberId),
            ),
            columns: { id: true },
          })
        : undefined;
      targets.push({
        leadId: row.lead_id,
        name: row.name,
        phone: row.phone,
        contactName: row.contact_name,
        pipeline: row.pipeline,
        ownerName: row.owner_name,
        open: row.won === null,
        conversationId: conversation?.id ?? null,
      });
    }
    // A number someone is already attending with no deal yet (Sofia or the
    // team): an owner-scoped reader may not start it as their own deal.
    let busy = false;
    if (owner !== undefined && digits.length >= 10) {
      const contact = await contactOfPhone(db, digits.startsWith('55') ? digits : `55${digits}`);
      if (contact) {
        const waiting = await db.query.waConversations.findFirst({
          where: and(
            eq(waConversations.contactId, contact.id),
            isNull(waConversations.leadId),
            isNull(waConversations.numberId),
          ),
          columns: { attendance: true },
        });
        busy = Boolean(waiting && waiting.attendance !== 'closed');
      }
    }
    return reply.send({ targets, busy });
  });

  /**
   * Any conversation the reader may see: a deal's in its owner scope, one with no deal at full
   * scope, a work number's chat by its number's owner or at full scope (docs/whatsapp/central.md),
   * and any one assigned to the reader.
   */
  async function visibleConversation(request: FastifyRequest, id: string) {
    const conversation = await db.query.waConversations.findFirst({
      where: eq(waConversations.id, id),
    });
    if (!conversation) return null;
    // Given to the reader (attendance.ts): theirs to answer, whoever owns the deal or the number.
    if (conversation.assigneeEmployeeId !== request.session.actor.employeeId) {
      if (conversation.numberId) {
        if ((await chatNumbersOf(request, conversation.numberId)).length === 0) return null;
      } else if (conversation.leadId) {
        const lead = await leadInScope(
          db,
          request.session.actor,
          conversation.leadId,
          'leads.whatsapp',
        );
        if (!lead) return null;
      } else if (!fullScope(request)) return null;
    }
    const contact = await db.query.waContacts.findFirst({
      where: eq(waContacts.id, conversation.contactId),
    });
    return contact ? { conversation, contact } : null;
  }

  app.get('/whatsapp/conversations/:id', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const found = await visibleConversation(request, params.data.id);
    if (!found) return notFound(reply);
    return reply.send(
      await threadOf(found.contact, found.conversation.leadId, found.conversation.id),
    );
  });

  // --- the CRM link (docs/whatsapp/central.md) ----------------------------------------

  /** The deals in the reader's scope with this phone (their own or a contact's), open first. */
  async function dealsOfPhone(request: FastifyRequest, phone: string): Promise<WaNewTarget[]> {
    const owner = leadOwnerFilter(request.session.actor, 'leads.whatsapp');
    const variants = brazilianPhoneVariants(phone);
    const rows = await db.execute<{
      lead_id: string;
      name: string | null;
      pipeline: string | null;
      owner_name: string | null;
      won: boolean | null;
    }>(sql`
      select l.id as lead_id, l.name, l.pipeline, e.full_name as owner_name, l.won
      from leads l left join employees e on e.id = l.owner_employee_id
      where (l.phone in ${variants} or exists (
          select 1 from lead_contacts lc
          join crm_contacts ct on ct.id = lc.contact_id and ct.merged_into_id is null
          where lc.lead_id = l.id and ct.phone in ${variants}))
        ${owner === undefined ? sql`` : sql`and l.owner_employee_id = ${owner}`}
      order by (l.won is null) desc, l.created_at desc
      limit 20`);
    return rows.rows.map((row) => ({
      leadId: row.lead_id,
      name: row.name,
      phone,
      contactName: null,
      pipeline: row.pipeline,
      ownerName: row.owner_name,
      open: row.won === null,
      conversationId: null,
    }));
  }

  /** A chat with no deal: the deals it may join (the reader chooses; nothing is guessed). */
  app.get('/whatsapp/conversations/:id/deals', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const found = params.success ? await visibleConversation(request, params.data.id) : null;
    if (!found) return notFound(reply);
    return reply.send({ deals: await dealsOfPhone(request, found.contact.phone) });
  });

  /** The reader joins a chat to one of its phone's deals; the deal's history says so. */
  app.post('/whatsapp/conversations/:id/link', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = z.object({ leadId: z.uuid() }).safeParse(request.body);
    const found = params.success ? await visibleConversation(request, params.data.id) : null;
    if (!found) return notFound(reply);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid', message: 'Escolha uma negociação.' });
    const { conversation, contact } = found;
    if (conversation.leadId)
      return reply.status(409).send({
        error: 'already_linked',
        message: 'Esta conversa já está numa negociação.',
      });
    // Only a deal of this phone, in the reader's reach: a chat never joins someone else's deal.
    const deals = await dealsOfPhone(request, contact.phone);
    if (!deals.some((deal) => deal.leadId === body.data.leadId))
      return reply.status(404).send({
        error: 'deal_not_found',
        message: 'Negociação não encontrada entre as deste telefone.',
      });
    const actorId = request.session.actor.employeeId;
    if (conversation.numberId)
      await linkNumberChat(db, conversation.id, body.data.leadId, {
        via: 'manual',
        numberId: conversation.numberId,
        employeeId: actorId,
      });
    else await adoptUnmatched(db, contact.id, body.data.leadId);
    await writeAudit(db, {
      actorEmployeeId: actorId,
      action: 'whatsapp.conversation_linked',
      entity: 'lead',
      entityId: body.data.leadId,
      ip: request.ip,
      metadata: { conversationId: conversation.id, numberId: conversation.numberId },
    });
    notifyInboxChanged();
    return reply.status(204).send();
  });

  // --- who answers it (docs/whatsapp/central.md, "Atendimento") -------------------------

  /** Runs one change of hands, answering a refusal in the screen's words. */
  async function handsAction(
    request: FastifyRequest,
    reply: FastifyReply,
    action: (input: ActionInput) => Promise<void>,
    audit: { action: string; metadata?: Record<string, unknown> },
  ) {
    const params = idParams.safeParse(request.params);
    const found = params.success ? await visibleConversation(request, params.data.id) : null;
    if (!found) return notFound(reply);
    const body = waVersionSchema.safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid', message: 'Dados inválidos.' });
    const { conversation } = found;
    try {
      await action({
        conversationId: conversation.id,
        version: body.data.version,
        actor: request.session.actor,
        at: now(),
      });
    } catch (error) {
      if (!(error instanceof AttendanceError)) throw error;
      const refused = attendanceRefusal(error);
      return reply.status(refused.status).send(refused.body);
    }
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: audit.action,
      entity: conversation.leadId ? 'lead' : 'wa_conversation',
      entityId: conversation.leadId ?? conversation.id,
      ip: request.ip,
      metadata: { conversationId: conversation.id, ...audit.metadata },
    });
    return reply.status(204).send();
  }

  /** Who holds it, what the reader may do, its history and Sofia's context. */
  app.get('/whatsapp/conversations/:id/attendance', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const found = params.success ? await visibleConversation(request, params.data.id) : null;
    if (!found) return notFound(reply);
    const settings = await loadSofiaSettings(db);
    const view = await attendanceView(
      db,
      {
        conversationId: found.conversation.id,
        actor: request.session.actor,
        at: now(),
        sofiaOn: settings.enabled,
      },
      (row) => factListOf(row, settings, row.segment as SofiaSegment | null),
    );
    return view ? reply.send(view) : notFound(reply);
  });

  /** Take it (`employeeId` = the reader), pass it on, or send it back to a department's queue. */
  app.post('/whatsapp/conversations/:id/assign', use, async (request, reply) => {
    const body = waAssignSchema.safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid', message: 'Escolha uma pessoa ou fila.' });
    const { employeeId, queue } = body.data;
    const me = request.session.actor.employeeId;
    if (employeeId === null && !queue)
      return reply.status(400).send({ error: 'invalid', message: 'Escolha a fila.' });
    return handsAction(
      request,
      reply,
      (input) =>
        employeeId === me
          ? takeOver(db, input)
          : employeeId
            ? transfer(db, { ...input, to: employeeId })
            : sendToQueue(db, { ...input, queue: queue! }),
      {
        action:
          employeeId === me
            ? 'whatsapp.conversation_taken'
            : employeeId
              ? 'whatsapp.conversation_transferred'
              : 'whatsapp.conversation_queued',
        metadata: employeeId ? { to: employeeId } : { queue },
      },
    );
  });

  app.post('/whatsapp/conversations/:id/resolve', use, (request, reply) =>
    handsAction(request, reply, (input) => resolve(db, input), {
      action: 'whatsapp.conversation_resolved',
    }),
  );

  app.post('/whatsapp/conversations/:id/reopen', use, (request, reply) =>
    handsAction(request, reply, (input) => reopen(db, input), {
      action: 'whatsapp.conversation_reopened',
    }),
  );

  /** Sofia in this conversation: pause (anyone who sees it) or turn on (`sofia.read`). */
  app.post('/whatsapp/conversations/:id/sofia', use, async (request, reply) => {
    const body = waSofiaSwitchSchema.safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid', message: 'Ação inválida.' });
    const { action } = body.data;
    const sofiaOn = (await loadSofiaSettings(db)).enabled;
    return handsAction(request, reply, (input) => switchSofia(db, { ...input, action, sofiaOn }), {
      action: action === 'pause' ? 'sofia.paused' : 'sofia.resumed',
    });
  });

  /** "Está respondendo": the composer renews it while the reader types; answers who else is. */
  app.post('/whatsapp/conversations/:id/replying', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const found = params.success ? await visibleConversation(request, params.data.id) : null;
    if (!found) return notFound(reply);
    const other = await startReplying(
      db,
      found.conversation.id,
      request.session.actor.employeeId,
      now(),
    );
    return reply.send({ replyingName: other });
  });

  /** Who gets a conversation nobody holds: its queue, or the funnel's rotation (Eric, 26/10). */
  app.get('/whatsapp/assignment', use, async (_request, reply) =>
    reply.send({ mode: await assignmentModeOf(db) }),
  );

  app.put(
    '/whatsapp/assignment',
    { preHandler: app.requirePermission('crm.manage') },
    async (request, reply) => {
      const body = waAssignmentSettingsSchema.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: 'invalid', message: 'Modo inválido.' });
      await setAssignmentMode(db, body.data.mode, request.session.actor.employeeId);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'whatsapp.assignment_mode_changed',
        entity: 'whatsapp_settings',
        entityId: null,
        ip: request.ip,
        metadata: { mode: body.data.mode },
      });
      return reply.send({ mode: body.data.mode });
    },
  );

  /**
   * "Nova conversa" by a work number (Eric, 26/10): the number's chat with one of the deal's phones.
   * Nothing is sent here; the first message follows Meta's rule (free text only inside 24 h).
   */
  app.post('/whatsapp/chat-numbers/:id/conversations', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = waNumberStartSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.status(400).send({ error: 'invalid', message: 'Dados inválidos.' });
    const [number] = await chatNumbersOf(request, params.data.id);
    if (!number?.connected)
      return reply.status(404).send({
        error: 'number_not_found',
        message: 'Número não encontrado ou ainda não conectado.',
      });
    const lead = await leadInScope(db, request.session.actor, body.data.leadId, 'leads.whatsapp');
    if (!lead) return notFound(reply);
    const phone = canonicalWhatsAppPhone(
      normalizeBrazilianPhone(body.data.phone) ?? body.data.phone,
    );
    if (!(await dealsOfPhone(request, phone)).some((deal) => deal.leadId === lead.id))
      return reply.status(422).send({
        error: 'phone_not_of_deal',
        message: 'Este telefone não é da negociação nem de um contato dela.',
      });
    const [contact] = await db
      .insert(waContacts)
      .values({ phone })
      .onConflictDoUpdate({
        target: [waContacts.tenantId, waContacts.phone],
        set: { updatedAt: now() },
      })
      .returning();
    const { conversation } = await openConversation(
      db,
      contact!.id,
      null,
      { referral: null, originCode: null },
      number.id,
    );
    if (!conversation.leadId)
      await linkNumberChat(db, conversation.id, lead.id, {
        via: 'manual',
        numberId: number.id,
        employeeId: request.session.actor.employeeId,
      });
    return reply.send({ conversationId: conversation.id });
  });

  // --- sending ------------------------------------------------------------------------

  const notHolder = (reply: FastifyReply, holderName: string | null) => {
    const refused = attendanceRefusal(new AttendanceError('not_holder', holderName));
    return reply.status(refused.status).send(refused.body);
  };

  /**
   * Meta's 1 a day and 2 a week (call-request-limit.ts), refused before anything goes. The
   * caller awaits the reason and returns this reply itself: an async helper returning the reply
   * hands back undefined once awaited (a FastifyReply is thenable), and the send went on to Meta.
   */
  const callLimitReply = (reply: FastifyReply, why: string) =>
    reply.status(429).send({ error: 'call_request_limit', message: why });

  type Outgoing =
    | { kind: 'text'; text: string }
    | { kind: 'media'; fileId: string; caption: string }
    /** A recording made in the conversation: converted, kept in the deal's files, sent as voice. */
    | { kind: 'voice'; recording: Buffer }
    | { kind: 'call_permission' }
    | {
        kind: 'template';
        name: string;
        language: string;
        params: string[];
        companyArticle: 'a' | 'o';
        expect?: { sendAs: 'free' | 'template'; charged: boolean };
      };

  const VOICE_REFUSALS = {
    unreadable: [422, 'Não deu para ler a gravação. Nada foi enviado; grave de novo.'],
    too_long: [
      413,
      `O áudio passa de ${WA_VOICE_MAX_SECONDS / 60} minutos. Nada foi enviado; grave um mais curto.`,
    ],
    too_large: [
      413,
      'O áudio ficou grande demais para o WhatsApp. Nada foi enviado; grave um mais curto.',
    ],
    unavailable: [503, 'A conversão de áudio não está instalada no servidor. Nada foi enviado.'],
  } as const;

  /**
   * A recording turned into a voice note and kept in the deal's files, the way a file the person
   * attaches gets there: only by who may edit the deal (`leads.write` in scope, the upload route's
   * rule). Nothing is kept when the recording is refused.
   */
  async function keepVoice(
    request: FastifyRequest,
    leadId: string,
    recording: Buffer,
  ): Promise<
    | { ok: true; fileId: string; seconds: number }
    | { ok: false; status: number; body: { error: string; message: string } }
  > {
    const actor = request.session.actor;
    // leadInScope filters by owner only: the permission itself is asked here, as a route would.
    const lead = grantedScope(actor, 'leads.write')
      ? await leadInScope(db, actor, leadId, 'leads.write')
      : null;
    const access = dealRouteAccessOf(actor);
    if (!lead || !access.write)
      return {
        ok: false,
        status: 403,
        body: {
          error: 'files_forbidden',
          message:
            'Para gravar áudio, é preciso poder editar a negociação: o áudio fica nos arquivos dela.',
        },
      };
    const note = await toVoiceNote(recording);
    if (!note.ok) {
      const [status, message] = VOICE_REFUSALS[note.why];
      return { ok: false, status, body: { error: `voice_${note.why}`, message } };
    }
    try {
      const file = await storeLeadFile(
        { ...artDeps(), maxFileBytes: env.DRIVE_MAX_FILE_BYTES },
        access,
        lead,
        { name: voiceFileName(now()), mimeType: 'audio/ogg', bytes: note.bytes },
      );
      await writeAudit(db, {
        actorEmployeeId: actor.employeeId,
        action: 'lead.file_added',
        entity: 'lead',
        entityId: lead.id,
        ip: request.ip,
        metadata: { fileId: file.fileId, voice: true },
      });
      return { ok: true, fileId: file.fileId, seconds: note.seconds };
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      return {
        ok: false,
        status: error.code === 'storage_unavailable' ? 503 : 409,
        body: {
          error: error.code,
          message: 'Não deu para guardar o áudio nos arquivos da negociação. Nada foi enviado.',
        },
      };
    }
  }

  async function send(
    request: FastifyRequest,
    reply: FastifyReply,
    target: {
      leadId: string | null;
      phone: string;
      contact: Contact | null;
      conversationId?: string;
      /** A work number's chat: sent with that number's token, never Sofia's or a template. */
      numberId?: string | null;
    },
    outgoing: Outgoing,
  ) {
    const numberId = target.numberId ?? null;
    // The seller's lock is the official number's (Eric, 14/10): a work number is live once connected.
    if (!numberId && (await sellerWhatsAppLocked(db, request.session.actor)))
      return reply.status(403).send({ error: 'whatsapp_soon', message: SELLER_SOON_MESSAGE });
    if (await leadOptInMissing(db, target.leadId))
      return reply
        .status(403)
        .send({ error: 'whatsapp_no_opt_in', message: WHATSAPP_OPT_IN_MISSING_TEXT });
    // Someone else holds it: they answer, or this reader takes it first (attendance.ts).
    const known =
      target.conversationId ??
      (target.contact && target.leadId
        ? (
            await db.query.waConversations.findFirst({
              where: and(
                eq(waConversations.contactId, target.contact.id),
                eq(waConversations.leadId, target.leadId),
                isNull(waConversations.numberId),
              ),
              columns: { id: true },
            })
          )?.id
        : undefined);
    const other = known ? await heldByOther(db, known, request.session.actor.employeeId) : null;
    if (other) return notHolder(reply, other.holderName);
    // Calling is the official number's: a work number sends text, files and its own templates.
    if (numberId && outgoing.kind === 'call_permission')
      return reply.status(409).send({
        error: 'number_no_calls',
        message: 'O pedido de ligação vai só pelo número oficial.',
      });
    const config = numberId ? await numberConfigOf(db, box, numberId) : whatsappConfigOf(env);
    if (!config)
      return numberId
        ? reply.status(503).send({
            error: 'number_offline',
            message: 'Este número não está conectado ao sistema agora. Nada foi enviado.',
          })
        : off(reply);
    const at = now();
    const window =
      numberId && target.conversationId
        ? await numberWindowOf(db, target.conversationId, at)
        : windowOf(target.contact, at);
    // A franchise lead speaks with the brand's expansion team, never with Wings (Eric, 07/10).
    const voice = await brandOf(db, target.leadId, target.conversationId ?? null);
    const brand = voice?.name ?? null;
    const offBrand = (words: string, why = 'não cite a Wings') =>
      brand && mentionsWings(words)
        ? reply.status(422).send({
            error: 'brand_voice',
            message: `Nesta conversa você fala pelo time de expansão ${withArticle(brand, voice?.article ?? 'a', 'of')}: ${why}.`,
          })
        : null;
    let payload: OutgoingPayload;
    let shown: string | null;
    let content: Record<string, unknown> = {};
    let planned: {
      plan: Extract<TemplatePlan, { ok: true }>;
      mediaId: string | null;
      artFileId: string | null;
    } | null = null;
    let sentFile: { fileId: string; kind: WaSendKind; mediaId: string } | null = null;
    // A template or a call request starts a contact: the "não me contate" register decides first,
    // on any of our numbers. A typed reply or a file inside the window keeps the rules above. A
    // recorded voice note is refused too (the safer reading of t084, docs/whatsapp/cloud-api.md).
    if (
      outgoing.kind === 'template' ||
      outgoing.kind === 'call_permission' ||
      outgoing.kind === 'voice'
    ) {
      const block = await contactBlock(db, 'whatsapp', {
        leadId: target.leadId,
        phone: target.contact?.phone ?? target.phone,
      });
      // A SAIR keeps its own answer below (`opted_out`), as before.
      if (block.blocked && !(outgoing.kind === 'template' && target.contact?.optOutAt)) {
        if (target.leadId)
          await noteContactBlocked(
            db,
            target.leadId,
            {
              channel: 'whatsapp',
              path:
                outgoing.kind === 'template'
                  ? 'modelo'
                  : outgoing.kind === 'voice'
                    ? 'audio_gravado'
                    : 'pedido_ligacao',
              origin: block.origin,
            },
            request.session.actor.employeeId,
          );
        return reply.status(409).send({ error: CONTACT_BLOCKED_ERROR, message: block.reason });
      }
    }
    if (outgoing.kind === 'call_permission') {
      if (!window.open)
        return reply.status(409).send({
          error: 'window_closed',
          message:
            'Fora das 24 horas: o pedido de ligação vai pelo modelo aprovado ("Pedir pelo modelo", no painel de ligação).',
        });
      const overLimit = await callRequestRefusal(db, target.contact?.id ?? null);
      if (overLimit) return callLimitReply(reply, overLimit);
      shown = callPermissionText(voice);
      payload = callPermissionPayload(shown);
      content = { callPermissionRequest: true };
    } else if (outgoing.kind === 'text') {
      if (!window.open)
        return reply.status(409).send({
          error: 'window_closed',
          message:
            'Fora das 24 horas desde a última mensagem da pessoa: escolha um modelo aprovado.',
        });
      const refused = offBrand(outgoing.text);
      if (refused) return refused;
      payload = textPayload(outgoing.text);
      shown = outgoing.text;
    } else if (outgoing.kind === 'media' || outgoing.kind === 'voice') {
      if (!window.open)
        return reply.status(409).send({
          error: 'window_closed',
          message: `Fora das 24 horas desde a última mensagem da pessoa: ${
            outgoing.kind === 'voice' ? 'áudio' : 'arquivo'
          } só vai dentro da janela. Escolha um modelo aprovado.`,
        });
      // The file goes up to the deal's files first: a conversation no deal took yet has none.
      if (!target.leadId)
        return reply.status(422).send({ error: 'no_deal', message: NO_DEAL_FOR_FILES });
      // A recording becomes one of the deal's files here, then goes like any other.
      const kept =
        outgoing.kind === 'voice'
          ? await keepVoice(request, target.leadId, outgoing.recording)
          : null;
      if (kept && !kept.ok) return reply.status(kept.status).send(kept.body);
      const fileId = kept ? kept.fileId : (outgoing as { fileId: string }).fileId;
      const caption = outgoing.kind === 'media' ? outgoing.caption : '';
      // One of the deal's files, and one the sender may open: the deal's link route asks the
      // same, so a file of another department attached to the deal never leaves through here.
      const file = (await leadHasFile(db, target.leadId, fileId))
        ? await fileFor(
            { ...artDeps(), maxFileBytes: env.DRIVE_MAX_FILE_BYTES },
            dealRouteAccessOf(request.session.actor),
            fileId,
          ).then(
            ({ file: found }) => (found.trashedAt ? undefined : found),
            (error: unknown) => {
              if (error instanceof DriveError) return undefined;
              throw error;
            },
          )
        : undefined;
      if (!file)
        return reply.status(404).send({
          error: 'file_not_found',
          message: 'Arquivo não encontrado nos arquivos desta negociação.',
        });
      const goes = waSendKindOf(file);
      if (!goes)
        return reply.status(413).send({
          error: 'too_large',
          message: 'O WhatsApp aceita arquivos de até 100 MB.',
        });
      if (caption && goes.kind === 'audio')
        return reply.status(422).send({
          error: 'caption_not_allowed',
          message: 'Áudio vai sem legenda: mande o texto numa mensagem à parte.',
        });
      // The name can reach the person (a document shows it): the voice covers it too.
      const refused =
        offBrand(caption) ??
        offBrand(file.name, 'o nome do arquivo cita a Wings; envie com outro nome');
      if (refused) return refused;
      const media = await driveFileMediaId({ ...artDeps(), fetchImpl: fetchImpl(), config }, file, {
        mimeType: goes.type,
        filename: file.name,
      });
      if (!media.ok) {
        // On the upload, Meta's 100 is the file itself: a type or size WhatsApp does not take.
        const why =
          media.why !== 'meta'
            ? null
            : media.code === 100
              ? 'a Meta não aceita este tipo de arquivo'
              : errorText(media.code, null);
        return reply.status(502).send({
          error: 'media_upload_failed',
          message:
            media.why !== 'meta'
              ? 'Não deu para ler o arquivo no Drive. Nada foi enviado; tente de novo em instantes.'
              : media.code === 100
                ? // The same file is refused again: another format, not another try.
                  `O arquivo não subiu para a Meta (${why}). Nada foi enviado; envie em outro formato, como PDF.`
                : `O arquivo não subiu para a Meta${why ? ` (${why})` : ''}. Nada foi enviado; tente de novo em instantes.`,
        });
      }
      sentFile = { fileId: file.id, kind: goes.kind, mediaId: media.mediaId };
      payload = filePayload(goes.kind, media.mediaId, caption, file.name, kept !== null);
      shown = caption || null;
      // The bubble opens the Drive file (this version) by `file`; Meta's id is the fallback.
      content = {
        media: { id: media.mediaId, mimeType: file.mimeType, filename: file.name },
        file: { fileId: file.id, version: file.version },
        ...(kept ? { voice: { seconds: kept.seconds } } : {}),
      };
    } else {
      // Who asked not to receive messages gets no template, not even as a common message, by any
      // of our numbers: only what a person writes, inside the window.
      if (target.contact?.optOutAt)
        return reply.status(409).send({
          error: 'opted_out',
          message:
            'A pessoa pediu para não receber mensagens. Só dá para responder quando ela escrever.',
        });
      const context = await templateContextOf(
        db,
        {
          leadId: target.leadId,
          conversationId: target.conversationId ?? null,
          contact: target.contact,
          senderEmployeeId: request.session.actor.employeeId,
          numberId,
        },
        at,
      );
      // A work number sends only its own WABA's templates (synced on "Usar modelo").
      const plan = await planTemplateFor(db, context, outgoing, numberId);
      if (!plan.ok)
        return reply.status(plan.status).send({ error: plan.error, message: plan.message });
      const { preview } = plan;
      // One value per field, as the preview gave them: a short or long list is refused, never completed.
      if (outgoing.params.length !== preview.fields.length || !preview.ready)
        return reply.status(422).send({
          error: 'template_params',
          message:
            outgoing.params.length !== preview.fields.length
              ? `Este modelo pede ${preview.fields.length} campo(s).`
              : 'Preencha cada campo do modelo.',
        });
      // The window may have closed since the preview: the seller sees the new cost before it goes.
      if (
        outgoing.expect &&
        (outgoing.expect.sendAs !== preview.sendAs || outgoing.expect.charged !== preview.charged)
      )
        return reply.status(409).send({
          error: 'send_mode_changed',
          message:
            preview.sendAs === 'template'
              ? `A janela de 24 h fechou: agora vai como modelo aprovado${
                  preview.charged ? ', cobrado pela Meta' : ''
                }. Confira e envie de novo.`
              : 'A janela de 24 h abriu: agora vai como mensagem comum, sem custo. Confira e envie de novo.',
          preview,
        });
      // The voice covers every word that leaves: the text, the buttons, the footer, the header.
      const refused = offBrand(`${preview.text} ${JSON.stringify(plan.version.components ?? [])}`);
      if (refused) return refused;
      const asksCall = asksCallPermission(plan.version);
      if (asksCall) {
        if (numberId)
          return reply.status(409).send({
            error: 'number_no_calls',
            message: 'O pedido de ligação vai só pelo número oficial.',
          });
        const overLimit = await callRequestRefusal(db, target.contact?.id ?? null);
        if (overLimit) return callLimitReply(reply, overLimit);
      }
      let mediaId: string | null = null;
      if (plan.needsArt) {
        if (!context.art)
          return reply
            .status(422)
            .send({ error: 'art_missing', message: preview.notices[0] ?? 'Falta a arte.' });
        const media = await artMediaId(
          { ...artDeps(), fetchImpl: fetchImpl(), config },
          context.art,
        );
        if (!media.ok)
          return reply.status(502).send({
            error: 'art_upload_failed',
            message:
              media.why === 'meta'
                ? `A arte não subiu para a Meta${errorText(media.code, null) ? ` (${errorText(media.code, null)})` : ''}. Nada foi enviado; tente de novo em instantes.`
                : 'Não deu para ler a arte no Drive. Nada foi enviado; confira a arte no cadastro.',
          });
        mediaId = media.mediaId;
      }
      planned = { plan, mediaId, artFileId: plan.needsArt ? (context.art?.id ?? null) : null };
      payload = payloadOf(plan, mediaId);
      shown = preview.text;
      const sent = {
        name: plan.version.name,
        language: plan.version.language,
        params: plan.params,
      };
      content = {
        ...(preview.sendAs === 'free'
          ? { fromTemplate: { ...sent, family: preview.family } }
          : { template: sent }),
        ...(planned.artFileId ? { art: { fileId: planned.artFileId, mediaId } } : {}),
        // Counted for Meta's limit, free request or template alike.
        ...(asksCall ? { callPermissionRequest: true } : {}),
      };
    }

    // The contact and the conversation exist before the message: a first
    // template to a lead who never wrote opens them.
    const contact =
      target.contact ??
      (
        await db
          .insert(waContacts)
          .values({ phone: canonicalWhatsAppPhone(target.phone) })
          .onConflictDoUpdate({
            target: [waContacts.tenantId, waContacts.phone],
            set: { updatedAt: at },
          })
          .returning()
      )[0]!;
    const conversation =
      numberId && target.conversationId
        ? { id: target.conversationId }
        : await conversationFor(db, contact.id, target.leadId, {
            referral: null,
            originCode: null,
          });
    const actor = request.session.actor;
    // The conversation becomes the writer's (and Sofia stops) before the message goes.
    const held = await holdForSend(db, conversation.id, actor.employeeId, at);
    if (!held.ok) return notHolder(reply, held.holderName);
    const delivered = await deliverWhatsApp(db, fetchImpl(), config, {
      numberId,
      contact,
      conversationId: conversation.id,
      leadId: target.leadId,
      author: 'employee',
      employeeId: actor.employeeId,
      kind:
        outgoing.kind === 'media' || outgoing.kind === 'voice'
          ? sentFile!.kind
          : outgoing.kind === 'call_permission'
            ? 'interactive'
            : planned?.plan.free
              ? planned.plan.free.kind === 'image'
                ? 'image'
                : planned.plan.free.kind === 'text'
                  ? 'text'
                  : 'interactive'
              : outgoing.kind,
      shown,
      content,
      payload,
      at,
    });
    const saved = delivered.row;
    const outcome = delivered.outcome;
    // Meta said the file behind the id is gone: the next send uploads it again (this one stays failed).
    const sentMediaId = planned?.mediaId ?? sentFile?.mediaId;
    if (
      outcome === 'failed' &&
      sentMediaId &&
      delivered.errorCode !== null &&
      ART_MEDIA_GONE_CODES.has(delivered.errorCode)
    )
      await invalidateArtMedia(db, sentMediaId, at);
    // A template with Meta's "Permitir ligações" request asks too.
    if (
      outcome === 'sent' &&
      (outgoing.kind === 'call_permission' ||
        (planned !== null && asksCallPermission(planned.plan.version)))
    )
      await db
        .update(waContacts)
        .set({
          callPermission:
            contact.callPermission === 'temporary' || contact.callPermission === 'permanent'
              ? contact.callPermission
              : 'requested',
          callPermissionRequestedAt: at,
        })
        .where(eq(waContacts.id, contact.id));
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'whatsapp.message_sent',
      entity: target.leadId ? 'lead' : 'wa_conversation',
      entityId: target.leadId ?? conversation.id,
      ip: request.ip,
      metadata: {
        messageId: saved.id,
        kind: outgoing.kind,
        ...(planned
          ? {
              template: planned.plan.version.name,
              sentAs: planned.plan.preview.sendAs,
              artFileId: planned.artFileId,
            }
          : {}),
        // By id only: a file's name is never written to the audit.
        ...(sentFile ? { fileId: sentFile.fileId, sentAs: sentFile.kind } : {}),
        ...(outgoing.kind === 'voice' ? { voice: true } : {}),
        ...(numberId ? { numberId } : {}),
        outcome,
        ...(delivered.errorCode === null ? {} : { errorCode: delivered.errorCode }),
      },
    });
    const authors = await authorsOf(db, [saved]);
    // Written either way: the bubble shows whether it went, and why not.
    return reply.status(201).send({ message: toMessage(saved, authors) });
  }

  // A recording comes as the raw body (scoped to this plugin: the rest keeps refusing non-JSON).
  app.addContentTypeParser(
    /^audio\//,
    { parseAs: 'buffer', bodyLimit: WA_VOICE_UPLOAD_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );

  type Refusal = { status: number; error: string; message: string };

  const voiceOf = (request: FastifyRequest): Outgoing | Refusal =>
    waVoiceRecordingType(request.headers['content-type']) && Buffer.isBuffer(request.body)
      ? request.body.length > 0
        ? { kind: 'voice', recording: request.body }
        : { status: 400, error: 'invalid', message: 'A gravação chegou vazia. Grave de novo.' }
      : {
          status: 415,
          error: 'unsupported_audio',
          message: 'Formato de gravação que o sistema não lê (aceita WebM, OGG e MP4 de áudio).',
        };

  const outgoingOf = (kind: 'text' | 'template' | 'media', body: unknown): Outgoing | string => {
    if (kind === 'text') {
      const parsed = waSendTextSchema.safeParse(body);
      return parsed.success
        ? { kind: 'text', text: parsed.data.text }
        : (parsed.error.issues[0]?.message ?? 'Mensagem inválida.');
    }
    if (kind === 'media') {
      const parsed = waSendMediaSchema.safeParse(body);
      return parsed.success
        ? { kind: 'media', fileId: parsed.data.fileId, caption: parsed.data.caption ?? '' }
        : (parsed.error.issues[0]?.message ?? 'Arquivo inválido.');
    }
    const parsed = waTemplateSendSchema.safeParse(body);
    return parsed.success
      ? { kind: 'template', ...parsed.data }
      : (parsed.error.issues[0]?.message ?? 'Modelo inválido.');
  };

  const parsedOutgoing = (
    kind: 'text' | 'template' | 'media' | 'voice',
    request: FastifyRequest,
  ): Outgoing | Refusal => {
    if (kind === 'voice') return voiceOf(request);
    const outgoing = outgoingOf(kind, request.body);
    return typeof outgoing === 'string'
      ? { status: 400, error: 'invalid', message: outgoing }
      : outgoing;
  };

  for (const kind of ['text', 'template', 'media', 'voice'] as const) {
    app.post(`/leads/:id/whatsapp/${kind}`, use, async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const lead = await leadInScope(db, request.session.actor, params.data.id, 'leads.whatsapp');
      if (!lead) return notFound(reply);
      const outgoing = parsedOutgoing(kind, request);
      if ('status' in outgoing)
        return reply
          .status(outgoing.status)
          .send({ error: outgoing.error, message: outgoing.message });
      if (!lead.phone)
        return reply
          .status(422)
          .send({ error: 'no_phone', message: 'A negociação não tem telefone.' });
      const contact = await contactOfPhone(db, lead.phone);
      return send(request, reply, { leadId: lead.id, phone: lead.phone, contact }, outgoing);
    });

    app.post(`/whatsapp/conversations/:id/${kind}`, use, async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      // Any conversation the reader may see: the reply goes to that
      // conversation's own number (a deal's contact may not be its main phone).
      const found = await visibleConversation(request, params.data.id);
      if (!found) return notFound(reply);
      const outgoing = parsedOutgoing(kind, request);
      if ('status' in outgoing)
        return reply
          .status(outgoing.status)
          .send({ error: outgoing.error, message: outgoing.message });
      return send(
        request,
        reply,
        {
          leadId: found.conversation.leadId,
          phone: found.contact.phone,
          contact: found.contact,
          conversationId: found.conversation.id,
          numberId: found.conversation.numberId,
        },
        outgoing,
      );
    });
  }

  // --- what a template becomes, before it goes ---------------------------------------

  /** The deal's or the conversation's target, in the reader's scope; null answers 404. */
  async function targetOf(request: FastifyRequest, by: 'lead' | 'conversation', id: string) {
    if (by === 'lead') {
      const lead = await leadInScope(db, request.session.actor, id, 'leads.whatsapp');
      if (!lead) return null;
      return {
        leadId: lead.id,
        conversationId: null,
        contact: await contactOfPhone(db, lead.phone),
      };
    }
    const found = await visibleConversation(request, id);
    if (!found) return null;
    return {
      leadId: found.conversation.leadId,
      conversationId: found.conversation.id,
      contact: found.contact,
      numberId: found.conversation.numberId,
    };
  }

  for (const [by, base] of [
    ['lead', '/leads/:id/whatsapp'],
    ['conversation', '/whatsapp/conversations/:id'],
  ] as const) {
    /**
     * What the chosen template becomes now: a common message (window open) or
     * the approved template, with the fields filled and the notices. Nothing
     * is sent; the send plans again from the database.
     */
    app.post(`${base}/template-preview`, use, async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const target = await targetOf(request, by, params.data.id);
      if (!target) return notFound(reply);
      const body = waTemplateSendSchema.safeParse(request.body);
      if (!body.success)
        return reply.status(400).send({ error: 'invalid', message: 'Modelo inválido.' });
      const context = await templateContextOf(
        db,
        { ...target, senderEmployeeId: request.session.actor.employeeId },
        now(),
      );
      const plan = await planTemplateFor(
        db,
        context,
        body.data,
        'numberId' in target ? target.numberId : null,
      );
      if (!plan.ok)
        return reply.status(plan.status).send({ error: plan.error, message: plan.message });
      return reply.header('Cache-Control', 'no-store').send({ preview: plan.preview });
    });

    /** The art this conversation's templates carry, for the preview: an address of 5 minutes. */
    app.get(`${base}/art`, use, async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const target = await targetOf(request, by, params.data.id);
      if (!target) return notFound(reply);
      const context = await templateContextOf(db, { ...target, senderEmployeeId: null }, now());
      if (!context.art)
        return reply.status(404).send({ error: 'no_art', message: 'Sem arte cadastrada.' });
      const deps = artDeps();
      if (!deps.storage)
        return reply
          .status(503)
          .send({ error: 'storage_unavailable', message: 'O Drive não está disponível agora.' });
      const link: WaArtLink = await artLink(deps, context.art);
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'drive.file_previewed',
        entity: 'drive_file',
        entityId: link.fileId,
        ip: request.ip,
        metadata: {
          purpose: 'whatsapp_template_preview',
          ...(target.leadId
            ? { leadId: target.leadId }
            : { conversationId: target.conversationId }),
        },
      });
      return reply.header('Cache-Control', 'no-store').send(link);
    });
  }

  // --- call permission ----------------------------------------------------------------

  /** Asks Meta now whether the person lets us call, and keeps the answer. */
  app.get('/leads/:id/whatsapp/call-permission', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const lead = await leadInScope(db, request.session.actor, params.data.id, 'leads.whatsapp');
    if (!lead) return notFound(reply);
    const config = whatsappConfigOf(env);
    if (!config) return off(reply);
    const contact = await contactOfPhone(db, lead.phone);
    if (!contact)
      return reply.send({
        ...permissionOf(null, now()),
        status: 'no_permission',
        canRequest: null,
        canCall: false,
      } satisfies WaCallPermissionLive);
    const live = await readCallPermission(fetchImpl(), config, contact.waId ?? contact.phone);
    if (!live.ok)
      return reply.status(502).send({
        error: 'meta_error',
        message: errorText(live.code, live.title) ?? 'A Meta não respondeu.',
      });
    const said = live.data.permission?.status;
    const status: WaCallPermission =
      said === 'temporary' || said === 'permanent'
        ? said
        : contact.callPermission === 'requested'
          ? 'requested'
          : 'no_permission';
    const expiresAt =
      said === 'temporary' && live.data.permission?.expiration_time
        ? new Date(live.data.permission.expiration_time * 1000)
        : null;
    const [saved] = await db
      .update(waContacts)
      .set({ callPermission: status, callPermissionExpiresAt: expiresAt })
      .where(eq(waContacts.id, contact.id))
      .returning();
    const can = (name: string) =>
      live.data.actions?.find((a) => a.action_name === name)?.can_perform_action ?? null;
    return reply.send({
      ...permissionOf(saved, now()),
      canRequest: can('send_call_permission_request'),
      canCall: can('start_call'),
    } satisfies WaCallPermissionLive);
  });

  /** The call-request template of this deal's voice: the brand's expansion team, or Wings. */
  const callRequestTemplate = async (leadId: string) =>
    WA_CALL_REQUEST_TEMPLATES[(await brandOf(db, leadId, null)) ? 'brand' : 'wings'];

  /**
   * Sends Meta's "may we call you?": with no body, the free request (inside the 24-hour window);
   * with `template`, the approved call-request template of the deal's voice, as its preview showed.
   */
  app.post('/leads/:id/whatsapp/call-permission', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const lead = await leadInScope(db, request.session.actor, params.data.id, 'leads.whatsapp');
    if (!lead) return notFound(reply);
    const body = waCallPermissionRequestSchema.safeParse(request.body ?? {});
    if (!body.success)
      return reply.status(400).send({ error: 'invalid', message: 'Pedido inválido.' });
    if (!lead.phone)
      return reply
        .status(422)
        .send({ error: 'no_phone', message: 'A negociação não tem telefone.' });
    const contact = await contactOfPhone(db, lead.phone);
    const template = body.data.template;
    return send(
      request,
      reply,
      { leadId: lead.id, phone: lead.phone, contact },
      template
        ? {
            kind: 'template',
            name: await callRequestTemplate(lead.id),
            language: WA_CALL_REQUEST_LANGUAGE,
            params: template.params,
            companyArticle: 'a',
            expect: template.expect,
          }
        : { kind: 'call_permission' },
    );
  });

  /** What the call-request template becomes for this deal, before it goes. Nothing is sent. */
  app.post('/leads/:id/whatsapp/call-permission/preview', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const target = await targetOf(request, 'lead', params.data.id);
    if (!target) return notFound(reply);
    const overLimit = await callRequestRefusal(db, target.contact?.id ?? null);
    if (overLimit) return callLimitReply(reply, overLimit);
    const name = await callRequestTemplate(params.data.id);
    const context = await templateContextOf(
      db,
      { ...target, senderEmployeeId: request.session.actor.employeeId },
      now(),
    );
    const plan = await planTemplateFor(db, context, {
      name,
      language: WA_CALL_REQUEST_LANGUAGE,
      params: [],
      companyArticle: 'a',
    });
    if (!plan.ok)
      return reply.status(plan.status).send({
        error: plan.error,
        message:
          plan.error === 'template_unknown'
            ? `O modelo de pedido de ligação (${name}) ainda não foi aprovado pela Meta. Nada foi enviado.`
            : plan.message,
      });
    if (!asksCallPermission(plan.version))
      return reply.status(422).send({
        error: 'template_no_call_request',
        message: `O modelo ${name} aprovado na Meta não tem o pedido de ligação. Nada foi enviado.`,
      });
    return reply.header('Cache-Control', 'no-store').send({ preview: plan.preview });
  });

  // --- templates ----------------------------------------------------------------------

  /** One entry per template for the seller: the `_arte` version is chosen when it goes. */
  const templateList = (
    rows: { name: string; language: string; category: string | null; components: unknown }[],
  ): WaTemplate[] => {
    const approved = new Set(rows.map((row) => `${row.name}|${row.language}`));
    return rows
      .filter(
        (row) =>
          !row.name.endsWith(WA_ART_SUFFIX) ||
          !approved.has(`${waTemplateFamily(row.name)}|${row.language}`),
      )
      .map((row) => {
        const body = templateBody(row.components);
        return {
          name: row.name,
          language: row.language,
          category: row.category,
          body,
          paramCount: templateParamCount(body),
          artVersion:
            row.name.endsWith(WA_ART_SUFFIX) ||
            approved.has(`${row.name}${WA_ART_SUFFIX}|${row.language}`),
          unsupported: unsupportedOf(row),
        };
      });
  };

  app.get('/whatsapp/templates', use, async (request, reply) => {
    const query = z
      .object({ refresh: z.literal('1').optional(), numberId: z.uuid().optional() })
      .safeParse(request.query);
    if (!query.success)
      return reply.status(400).send({ error: 'invalid', message: 'Pedido inválido.' });
    const refresh = query.data.refresh === '1';
    const { numberId } = query.data;
    if (numberId) {
      // A work number's own WABA (docs/whatsapp/central.md): only for who reaches its chats (its
      // owner, full scope, or someone given one of them).
      const [number] = await chatNumbersOf(request, numberId);
      const given = number
        ? undefined
        : await db.query.waConversations.findFirst({
            where: and(
              eq(waConversations.numberId, numberId),
              eq(waConversations.assigneeEmployeeId, request.session.actor.employeeId),
            ),
            columns: { id: true },
          });
      if (!number && !given)
        return reply.status(404).send({ error: 'not_found', message: 'Número não encontrado.' });
      const config = await numberConfigOf(db, box, numberId);
      let syncError: string | null = null;
      const [{ last } = { last: null }] = await db
        .select({ last: max(waNumberTemplates.syncedAt) })
        .from(waNumberTemplates)
        .where(eq(waNumberTemplates.numberId, numberId));
      const stale = !last || now().getTime() - last.getTime() > TEMPLATES_FRESH_MS;
      if (config?.wabaId && (refresh || stale))
        syncError = await syncNumberTemplates(
          db,
          fetchImpl(),
          numberId,
          { ...config, wabaId: config.wabaId },
          now(),
        );
      const rows = await db
        .select()
        .from(waNumberTemplates)
        .where(
          and(eq(waNumberTemplates.numberId, numberId), eq(waNumberTemplates.status, 'APPROVED')),
        )
        .orderBy(asc(waNumberTemplates.name), asc(waNumberTemplates.language));
      return reply.send({ templates: templateList(rows), configured: config !== null, syncError });
    }
    const config = whatsappConfigOf(env);
    let syncError: string | null = null;
    const [{ last } = { last: null }] = await db
      .select({ last: max(waTemplates.syncedAt) })
      .from(waTemplates);
    const stale = !last || now().getTime() - last.getTime() > TEMPLATES_FRESH_MS;
    if (config?.wabaId && (refresh || stale))
      syncError = await syncTemplates(db, fetchImpl(), { ...config, wabaId: config.wabaId }, now());
    const rows = await db
      .select()
      .from(waTemplates)
      .where(eq(waTemplates.status, 'APPROVED'))
      .orderBy(asc(waTemplates.name), asc(waTemplates.language));
    return reply.send({ templates: templateList(rows), configured: config !== null, syncError });
  });

  // --- received files -------------------------------------------------------------------

  /**
   * Types a browser may show in place; anything else is a download, never run on our origin.
   * AMR audio and 3GPP video are downloads too: browsers do not play them.
   */
  const INLINE = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'audio/ogg',
    'audio/mpeg',
    'audio/aac',
    'audio/mp4',
    // What some browsers call an M4A sent from the deal's files (Meta was told audio/mp4).
    'audio/x-m4a',
    'video/mp4',
    'application/pdf',
  ]);

  /** The bytes of the version a message sent, while its Drive file is out of the trash. */
  async function sentVersionOf(fileId: string, version: number | undefined) {
    const file = await db.query.driveFiles.findFirst({
      where: and(eq(driveFiles.id, fileId), isNull(driveFiles.trashedAt)),
    });
    if (!file) return null;
    if (version === undefined || version === file.version)
      return {
        fileId,
        version: file.version,
        storageKey: file.storageKey,
        mimeType: file.mimeType,
      };
    const older = await db.query.driveFileVersions.findFirst({
      where: and(eq(driveFileVersions.fileId, fileId), eq(driveFileVersions.version, version)),
    });
    return older
      ? { fileId, version, storageKey: older.storageKey, mimeType: older.mimeType }
      : null;
  }

  app.get('/whatsapp/messages/:id/media', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = await db.query.waMessages.findFirst({ where: eq(waMessages.id, params.data.id) });
    if (!row) return notFound(reply);
    // The same reach as the conversation's (a work number's chat: its owner or full scope).
    const found = await visibleConversation(request, row.conversationId);
    if (!found) return notFound(reply);
    const media = (row.content as { media?: { id?: string; filename?: string | null } }).media;
    if (!media?.id) return notFound(reply);
    const typeOf = (mime: string | null) => (mime ?? '').split(';')[0]!.trim().toLowerCase();
    const name = (media.filename ?? `arquivo-${row.id.slice(0, 8)}`).replace(/[^\w.\- ]/g, '_');
    // Sent from the deal's files: the Drive file itself, the version that went. Received: the
    // copy in our storage (media-store.ts). The browser takes either from there, by an
    // address good for five minutes that only this check hands out.
    const sent = (row.content as { file?: { fileId?: string; version?: number } }).file;
    const drive = sent?.fileId ? await sentVersionOf(sent.fileId, sent.version) : null;
    const kept =
      drive ??
      (await db.query.waMessageFiles.findFirst({
        where: and(eq(waMessageFiles.messageId, row.id), eq(waMessageFiles.status, 'stored')),
      }));
    const storage = kept ? storageOf(app.wings) : null;
    if (kept && storage) {
      const type = typeOf(kept.mimeType);
      const inline = INLINE.has(type);
      const url = await storage.presignGet(kept.storageKey, {
        expiresSeconds: 300,
        disposition: inline ? 'inline' : 'attachment',
        filename: name,
        contentType: inline ? type : 'application/octet-stream',
      });
      // A Drive file opened is written down by id, as every Drive read is.
      if (drive)
        await writeAudit(db, {
          actorEmployeeId: request.session.actor.employeeId,
          action: inline ? 'drive.file_previewed' : 'drive.file_downloaded',
          entity: 'drive_file',
          entityId: drive.fileId,
          ip: request.ip,
          metadata: {
            version: drive.version,
            purpose: 'whatsapp_message',
            messageId: row.id,
            ...(row.leadId ? { leadId: row.leadId } : {}),
          },
        });
      return reply.header('Cache-Control', 'private, max-age=240').redirect(url, 302);
    }
    // Not copied yet (or the copy failed): straight from Meta (a work number's with its own token).
    const numberId = found.conversation.numberId;
    const config = numberId ? await numberConfigOf(db, box, numberId) : whatsappConfigOf(env);
    if (!config) return off(reply);
    const file = await downloadWhatsAppMedia(fetchImpl(), config, media.id);
    if (!file.ok)
      return reply.status(502).send({
        error: 'media_unavailable',
        message: 'A Meta não entregou o arquivo (a Meta guarda os arquivos recebidos por 30 dias).',
      });
    const type = typeOf(file.data.mimeType);
    const inline = INLINE.has(type);
    return reply
      .header('Content-Type', inline ? type : 'application/octet-stream')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`)
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(file.data.bytes);
  });
};
