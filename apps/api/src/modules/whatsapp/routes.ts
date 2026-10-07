import {
  brazilianPhoneVariants,
  canonicalWhatsAppPhone,
  templateParamCount,
  waSendTemplateSchema,
  waSendTextSchema,
  WA_KIND_LABELS,
  WA_MEDIA_KINDS,
  WA_WINDOW_HOURS,
  type DealWhatsApp,
  type WaConversationItem,
  type WaMessage,
  type WaMessageKind,
  type WaMessageStatus,
  type WaTemplate,
  type WaCallPermission,
  type WaCallPermissionLive,
  type WaCallPermissionState,
} from '@wings/shared';
import { and, asc, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import {
  employees,
  waContacts,
  waConversations,
  waMessages,
  waTemplates,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { leadInScope, leadOwnerFilter } from '../leads/access.js';
import {
  downloadWhatsAppMedia,
  errorText,
  listWhatsAppTemplates,
  sendWhatsAppMessage,
  templatePayload,
  textPayload,
  callPermissionPayload,
  readCallPermission,
  UNKNOWN_OUTCOME,
  whatsappConfigOf,
  type OutgoingPayload,
} from './graph.js';
import { callingOn } from './calling.js';
import { adoptUnmatched, conversationFor } from './intake.js';

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
const MESSAGES_SHOWN = 500;

const idParams = z.object({ id: z.uuid() });

/** What the person sees above Meta's "Permitir ligações" buttons. */
export const CALL_PERMISSION_TEXT =
  'A Wings gostaria de poder te ligar pelo WhatsApp para continuar o seu atendimento.';

/** The stored permission, with a temporary one that ran out read as none. */
function permissionOf(
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

type Contact = typeof waContacts.$inferSelect;
type MessageRow = typeof waMessages.$inferSelect;

const windowOf = (contact: Contact | null | undefined, now: Date) => {
  const expires = contact?.lastInboundAt
    ? new Date(contact.lastInboundAt.getTime() + WA_WINDOW_HOURS * 3_600_000)
    : null;
  return { open: expires !== null && expires > now, expiresAt: expires?.toISOString() ?? null };
};

function toMessage(row: MessageRow, authors: Map<string, string>): WaMessage {
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
    at: (row.waTimestamp ?? row.createdAt).toISOString(),
  };
}

async function authorsOf(db: Database, rows: MessageRow[]) {
  const ids = [...new Set(rows.map((r) => r.employeeId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map<string, string>();
  const found = await db
    .select({ id: employees.id, name: employees.fullName })
    .from(employees)
    .where(inArray(employees.id, ids));
  return new Map(found.map((e) => [e.id, e.name]));
}

async function contactOfPhone(db: Database, phone: string | null) {
  if (!phone) return null;
  const found = await db
    .select()
    .from(waContacts)
    .where(inArray(waContacts.phone, brazilianPhoneVariants(phone)))
    .limit(1);
  return found[0] ?? null;
}

export const whatsappRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();
  const fetchImpl = () => app.wings.whatsappFetch ?? fetch;
  const use = { preHandler: app.requirePermission('leads.whatsapp') };

  const notFound = (reply: FastifyReply) =>
    reply.status(404).send({ error: 'not_found', message: 'Conversa não encontrada.' });
  const off = (reply: FastifyReply) =>
    reply.status(503).send({
      error: 'whatsapp_off',
      message: 'O WhatsApp oficial ainda não está ligado no sistema.',
    });
  const fullScope = (request: FastifyRequest) =>
    leadOwnerFilter(request.session.actor, 'leads.whatsapp') === undefined;

  async function threadOf(
    contact: Contact | null,
    leadId: string | null,
    conversationId: string | null,
  ): Promise<DealWhatsApp> {
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
    return {
      conversationId,
      leadId,
      profileName: contact?.profileName ?? null,
      configured: whatsappConfigOf(env) !== null,
      calling: await callingOn(fetchImpl(), whatsappConfigOf(env)),
      phone: contact?.phone ?? null,
      window: windowOf(contact, now()),
      optedOut: Boolean(contact?.optOutAt),
      callPermission: permissionOf(contact, now()),
      messages: rows.map((row) => toMessage(row, authors)),
    };
  }

  // --- reading ------------------------------------------------------------------------

  app.get('/leads/:id/whatsapp', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const lead = await leadInScope(db, request.session.actor, params.data.id, 'leads.whatsapp');
    if (!lead) return notFound(reply);
    const contact = await contactOfPhone(db, lead.phone);
    // Messages that waited with no deal come to this one (same phone).
    if (contact) await adoptUnmatched(db, contact.id, lead.id);
    const data = await threadOf(contact, lead.id, null);
    return reply.send({ ...data, phone: lead.phone });
  });

  app.get('/whatsapp/conversations', use, async (request, reply) => {
    const query = z.object({ unanswered: z.enum(['1', '0']).optional() }).safeParse(request.query);
    if (!query.success)
      return reply.status(400).send({ error: 'invalid', message: 'Filtro inválido.' });
    const owner = leadOwnerFilter(request.session.actor, 'leads.whatsapp');
    const rows = await db.execute<{
      id: string;
      lead_id: string | null;
      lead_name: string | null;
      profile_name: string | null;
      phone: string;
      last_inbound_at: Date | string | null;
      last_message_at: Date | string | null;
      direction: string | null;
      kind: string | null;
      text: string | null;
    }>(sql`
      select c.id, c.lead_id, l.name as lead_name, k.profile_name, k.phone, k.last_inbound_at,
             c.last_message_at, m.direction, m.kind, m.text
      from wa_conversations c
      join wa_contacts k on k.id = c.contact_id
      left join leads l on l.id = c.lead_id
      left join lateral (
        select direction, kind, text from wa_messages
        where conversation_id = c.id order by created_at desc limit 1
      ) m on true
      where c.last_message_at is not null
        ${owner === undefined ? sql`` : sql`and l.owner_employee_id = ${owner}`}
        ${query.data.unanswered === '1' ? sql`and m.direction = 'in'` : sql``}
      order by c.last_message_at desc
      limit 100`);
    const at = now();
    const items: WaConversationItem[] = rows.rows.map((row) => {
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
          lastInbound !== null &&
          lastInbound.getTime() + WA_WINDOW_HOURS * 3_600_000 > at.getTime(),
      };
    });
    return reply.send({ conversations: items });
  });

  /** A conversation no deal took yet: full scope only (a deal's opens from the deal). */
  async function waitingConversation(request: FastifyRequest, id: string) {
    if (!fullScope(request)) return null;
    const conversation = await db.query.waConversations.findFirst({
      where: and(eq(waConversations.id, id), isNull(waConversations.leadId)),
    });
    if (!conversation) return null;
    const contact = await db.query.waContacts.findFirst({
      where: eq(waContacts.id, conversation.contactId),
    });
    return contact ? { conversation, contact } : null;
  }

  app.get('/whatsapp/conversations/:id', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const found = await waitingConversation(request, params.data.id);
    if (!found) return notFound(reply);
    return reply.send(await threadOf(found.contact, null, found.conversation.id));
  });

  // --- sending ------------------------------------------------------------------------

  type Outgoing =
    | { kind: 'text'; text: string }
    | { kind: 'call_permission' }
    | { kind: 'template'; name: string; language: string; params: string[] };

  async function send(
    request: FastifyRequest,
    reply: FastifyReply,
    target: { leadId: string | null; phone: string; contact: Contact | null },
    outgoing: Outgoing,
  ) {
    const config = whatsappConfigOf(env);
    if (!config) return off(reply);
    const at = now();
    const window = windowOf(target.contact, at);
    let payload: OutgoingPayload;
    let shown: string;
    let content: Record<string, unknown> = {};
    if (outgoing.kind === 'call_permission') {
      if (!window.open)
        return reply.status(409).send({
          error: 'window_closed',
          message:
            'Fora das 24 horas: o pedido de ligação vai por um modelo de pedido de ligação (em "Usar modelo").',
        });
      shown = CALL_PERMISSION_TEXT;
      payload = callPermissionPayload(CALL_PERMISSION_TEXT);
      content = { callPermissionRequest: true };
    } else if (outgoing.kind === 'text') {
      if (!window.open)
        return reply.status(409).send({
          error: 'window_closed',
          message:
            'Fora das 24 horas desde a última mensagem da pessoa: escolha um modelo aprovado.',
        });
      payload = textPayload(outgoing.text);
      shown = outgoing.text;
    } else {
      if (target.contact?.optOutAt)
        return reply.status(409).send({
          error: 'opted_out',
          message:
            'A pessoa pediu para não receber mensagens. Só dá para responder quando ela escrever.',
        });
      const template = await db.query.waTemplates.findFirst({
        where: and(
          eq(waTemplates.name, outgoing.name),
          eq(waTemplates.language, outgoing.language),
          eq(waTemplates.status, 'APPROVED'),
        ),
      });
      if (!template)
        return reply.status(422).send({
          error: 'template_unknown',
          message: 'Modelo não encontrado ou não aprovado pela Meta.',
        });
      const body = templateBody(template.components);
      if (templateParamCount(body) !== outgoing.params.length)
        return reply.status(422).send({
          error: 'template_params',
          message: `Este modelo pede ${templateParamCount(body)} campo(s).`,
        });
      payload = templatePayload(outgoing.name, outgoing.language, outgoing.params);
      shown = fillTemplate(body, outgoing.params) ?? outgoing.name;
      content = {
        template: { name: outgoing.name, language: outgoing.language, params: outgoing.params },
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
    const conversation = await conversationFor(db, contact.id, target.leadId, {
      referral: null,
      originCode: null,
    });
    const actor = request.session.actor;
    const [row] = await db
      .insert(waMessages)
      .values({
        conversationId: conversation.id,
        contactId: contact.id,
        leadId: target.leadId,
        direction: 'out',
        author: 'employee',
        employeeId: actor.employeeId,
        kind: outgoing.kind === 'call_permission' ? 'interactive' : outgoing.kind,
        text: shown,
        content,
        status: 'pending',
      })
      .returning();

    const result = await sendWhatsAppMessage(
      fetchImpl(),
      config,
      contact.waId ?? contact.phone,
      payload,
    );
    const outcome = result.ok ? 'sent' : result.unknown ? 'unknown' : 'failed';
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
    if (result.ok && outgoing.kind === 'call_permission')
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
    if (result.ok && result.data.waId && result.data.waId !== contact.waId)
      await db
        .update(waContacts)
        .set({ waId: result.data.waId, updatedAt: at })
        .where(eq(waContacts.id, contact.id));
    await db
      .update(waConversations)
      .set({ lastMessageAt: at })
      .where(eq(waConversations.id, conversation.id));
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'whatsapp.message_sent',
      entity: target.leadId ? 'lead' : 'wa_conversation',
      entityId: target.leadId ?? conversation.id,
      ip: request.ip,
      metadata: {
        messageId: row!.id,
        kind: outgoing.kind,
        ...(outgoing.kind === 'template' ? { template: outgoing.name } : {}),
        outcome,
        ...(result.ok ? {} : { errorCode: result.code }),
      },
    });
    const authors = await authorsOf(db, [saved!]);
    // Written either way: the bubble shows whether it went, and why not.
    return reply.status(201).send({ message: toMessage(saved!, authors) });
  }

  const outgoingOf = (kind: 'text' | 'template', body: unknown): Outgoing | string => {
    if (kind === 'text') {
      const parsed = waSendTextSchema.safeParse(body);
      return parsed.success
        ? { kind: 'text', text: parsed.data.text }
        : (parsed.error.issues[0]?.message ?? 'Mensagem inválida.');
    }
    const parsed = waSendTemplateSchema.safeParse(body);
    return parsed.success
      ? { kind: 'template', ...parsed.data }
      : (parsed.error.issues[0]?.message ?? 'Modelo inválido.');
  };

  for (const kind of ['text', 'template'] as const) {
    app.post(`/leads/:id/whatsapp/${kind}`, use, async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return notFound(reply);
      const lead = await leadInScope(db, request.session.actor, params.data.id, 'leads.whatsapp');
      if (!lead) return notFound(reply);
      const outgoing = outgoingOf(kind, request.body);
      if (typeof outgoing === 'string')
        return reply.status(400).send({ error: 'invalid', message: outgoing });
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
      const found = await waitingConversation(request, params.data.id);
      if (!found) return notFound(reply);
      const outgoing = outgoingOf(kind, request.body);
      if (typeof outgoing === 'string')
        return reply.status(400).send({ error: 'invalid', message: outgoing });
      return send(
        request,
        reply,
        { leadId: null, phone: found.contact.phone, contact: found.contact },
        outgoing,
      );
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

  /** Sends Meta's "may we call you?" message (inside the 24-hour window). */
  app.post('/leads/:id/whatsapp/call-permission', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const lead = await leadInScope(db, request.session.actor, params.data.id, 'leads.whatsapp');
    if (!lead) return notFound(reply);
    if (!lead.phone)
      return reply
        .status(422)
        .send({ error: 'no_phone', message: 'A negociação não tem telefone.' });
    const contact = await contactOfPhone(db, lead.phone);
    return send(
      request,
      reply,
      { leadId: lead.id, phone: lead.phone, contact },
      { kind: 'call_permission' },
    );
  });

  // --- templates ----------------------------------------------------------------------

  app.get('/whatsapp/templates', use, async (request, reply) => {
    const refresh = (request.query as { refresh?: string } | undefined)?.refresh === '1';
    const config = whatsappConfigOf(env);
    let syncError: string | null = null;
    const [{ last } = { last: null }] = await db
      .select({ last: max(waTemplates.syncedAt) })
      .from(waTemplates);
    const stale = !last || now().getTime() - last.getTime() > TEMPLATES_FRESH_MS;
    if (config?.wabaId && (refresh || stale)) {
      const listed = await listWhatsAppTemplates(fetchImpl(), { ...config, wabaId: config.wabaId });
      if (listed.ok) {
        const at = now();
        for (const t of listed.data) {
          if (!t.name || !t.language || !t.status) continue;
          await db
            .insert(waTemplates)
            .values({
              metaId: t.id ?? null,
              name: t.name,
              language: t.language,
              category: t.category ?? null,
              status: t.status,
              components: (t.components ?? []) as object[],
              syncedAt: at,
            })
            .onConflictDoUpdate({
              target: [waTemplates.tenantId, waTemplates.name, waTemplates.language],
              set: {
                metaId: t.id ?? null,
                category: t.category ?? null,
                status: t.status,
                components: (t.components ?? []) as object[],
                syncedAt: at,
              },
            });
        }
      } else syncError = errorText(listed.code, listed.title);
    }
    const rows = await db
      .select()
      .from(waTemplates)
      .where(eq(waTemplates.status, 'APPROVED'))
      .orderBy(asc(waTemplates.name), asc(waTemplates.language));
    const templates: WaTemplate[] = rows.map((row) => {
      const body = templateBody(row.components);
      return {
        name: row.name,
        language: row.language,
        category: row.category,
        body,
        paramCount: templateParamCount(body),
      };
    });
    return reply.send({ templates, configured: config !== null, syncError });
  });

  // --- received files -------------------------------------------------------------------

  /** Types a browser may show in place; anything else is a download, never run on our origin. */
  const INLINE = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'audio/ogg',
    'audio/mpeg',
    'audio/aac',
    'audio/mp4',
    'audio/amr',
    'video/mp4',
    'video/3gpp',
    'application/pdf',
  ]);

  app.get('/whatsapp/messages/:id/media', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = await db.query.waMessages.findFirst({ where: eq(waMessages.id, params.data.id) });
    if (!row) return notFound(reply);
    const allowed = row.leadId
      ? await leadInScope(db, request.session.actor, row.leadId, 'leads.whatsapp')
      : fullScope(request);
    if (!allowed) return notFound(reply);
    const media = (row.content as { media?: { id?: string; filename?: string | null } }).media;
    if (!media?.id) return notFound(reply);
    const config = whatsappConfigOf(env);
    if (!config) return off(reply);
    const file = await downloadWhatsAppMedia(fetchImpl(), config, media.id);
    if (!file.ok)
      return reply.status(502).send({
        error: 'media_unavailable',
        message: 'A Meta não entregou o arquivo (a Meta guarda os arquivos recebidos por 30 dias).',
      });
    const type = (file.data.mimeType ?? '').split(';')[0]!.trim().toLowerCase();
    const inline = INLINE.has(type);
    const name = (media.filename ?? `arquivo-${row.id.slice(0, 8)}`).replace(/[^\w.\- ]/g, '_');
    return reply
      .header('Content-Type', inline ? type : 'application/octet-stream')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`)
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(file.data.bytes);
  });
};

/** The BODY text of a template as Meta lists it. */
export function templateBody(components: unknown): string | null {
  if (!Array.isArray(components)) return null;
  const body = components.find(
    (c) => c && typeof c === 'object' && (c as { type?: string }).type === 'BODY',
  ) as { text?: unknown } | undefined;
  return typeof body?.text === 'string' ? body.text : null;
}

function fillTemplate(body: string | null, params: string[]): string | null {
  if (!body) return null;
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (all, n: string) => params[Number(n) - 1] ?? all);
}
