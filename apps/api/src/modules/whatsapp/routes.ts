import {
  mentionsWings,
  canonicalWhatsAppPhone,
  withArticle,
  templateParamCount,
  waTemplateFamily,
  waTemplateSendSchema,
  waSendTextSchema,
  WA_ART_SUFFIX,
  type WaArtLink,
  type WaConversationItem,
  type WaNewTarget,
  type WaTemplate,
  type WaCallPermission,
  type WaCallPermissionLive,
} from '@wings/shared';
import { and, asc, eq, isNull, max, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { waContacts, waConversations, waMessages, waTemplates } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import {
  officialNumberLive,
  sellerWhatsAppLocked,
  SELLER_SOON_MESSAGE,
  setOfficialNumberLive,
} from './official-number.js';
import { leadInScope, leadOwnerFilter } from '../leads/access.js';
import { storageOf } from '../../lib/storage/index.js';
import {
  ART_MEDIA_GONE_CODES,
  artLink,
  artMediaId,
  invalidateArtMedia,
  type ArtDeps,
} from './art.js';
import {
  downloadWhatsAppMedia,
  errorText,
  listWhatsAppTemplates,
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
  markConversationRead,
  type ConversationListRow,
  contactOfPhone,
  permissionOf,
  toMessage,
  windowOf,
  callPermissionText,
} from './thread.js';
import { takeConversation } from '../sofia/state.js';
import { adoptUnmatched, conversationFor } from './intake.js';
import {
  payloadOf,
  planTemplateFor,
  templateBody,
  templateContextOf,
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
        where: and(eq(waConversations.contactId, contact.id), isNull(waConversations.leadId)),
        columns: { attendance: true },
      });
      if (waiting && (fullScope(request) || waiting.attendance === 'closed'))
        await adoptUnmatched(db, contact.id, lead.id);
    }
    const data = await threadOf(contact, lead.id, null);
    return reply.send({ ...data, phone: lead.phone });
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
    const query = z
      .object({
        unanswered: z.enum(['1', '0']).optional(),
        filter: z.enum(['all', 'unread', 'unanswered']).optional(),
        q: z.string().trim().max(80).optional(),
      })
      .safeParse(request.query);
    if (!query.success)
      return reply.status(400).send({ error: 'invalid', message: 'Filtro inválido.' });
    const filter = query.data.filter ?? (query.data.unanswered === '1' ? 'unanswered' : 'all');
    const q = query.data.q;
    const digits = q?.replace(/\D/g, '') ?? '';
    const rows = await db.execute<ConversationListRow>(
      conversationListSql({
        owner: leadOwnerFilter(request.session.actor, 'leads.whatsapp'),
        readerId: request.session.actor.employeeId,
        limit: 200,
        where: sql`
          ${filter === 'unanswered' ? sql`and m.direction = 'in'` : sql``}
          ${
            q
              ? sql`and (k.profile_name ilike ${`%${q}%`} or l.name ilike ${`%${q}%`}
                    ${digits.length >= 4 ? sql`or k.phone like ${`%${digits}%`}` : sql``})`
              : sql``
          }`,
      }),
    );
    const at = now();
    const items: WaConversationItem[] = rows.rows
      .map((row) => conversationItemOf(row, at))
      .filter((item) => filter !== 'unread' || item.unreadCount > 0);
    return reply.send({ conversations: items });
  });

  /** The reader opened the conversation: its messages so far are read, for them only. */
  app.post('/whatsapp/conversations/:id/read', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const found = params.success ? await visibleConversation(request, params.data.id) : null;
    if (!found) return notFound(reply);
    await markConversationRead(db, found.conversation.id, request.session.actor.employeeId);
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
          where: and(eq(waConversations.contactId, contact.id), isNull(waConversations.leadId)),
          columns: { attendance: true },
        });
        busy = Boolean(waiting && waiting.attendance !== 'closed');
      }
    }
    return reply.send({ targets, busy });
  });

  /** Any conversation the reader may see: a deal's in its owner scope, one with no deal at full scope. */
  async function visibleConversation(request: FastifyRequest, id: string) {
    const conversation = await db.query.waConversations.findFirst({
      where: eq(waConversations.id, id),
    });
    if (!conversation) return null;
    if (conversation.leadId) {
      const lead = await leadInScope(
        db,
        request.session.actor,
        conversation.leadId,
        'leads.whatsapp',
      );
      if (!lead) return null;
    } else if (!fullScope(request)) return null;
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

  // --- sending ------------------------------------------------------------------------

  type Outgoing =
    | { kind: 'text'; text: string }
    | { kind: 'call_permission' }
    | {
        kind: 'template';
        name: string;
        language: string;
        params: string[];
        companyArticle: 'a' | 'o';
        expect?: { sendAs: 'free' | 'template'; charged: boolean };
      };

  async function send(
    request: FastifyRequest,
    reply: FastifyReply,
    target: {
      leadId: string | null;
      phone: string;
      contact: Contact | null;
      conversationId?: string;
    },
    outgoing: Outgoing,
  ) {
    if (await sellerWhatsAppLocked(db, request.session.actor))
      return reply.status(403).send({ error: 'whatsapp_soon', message: SELLER_SOON_MESSAGE });
    const config = whatsappConfigOf(env);
    if (!config) return off(reply);
    const at = now();
    const window = windowOf(target.contact, at);
    // A franchise lead speaks with the brand's expansion team, never with Wings (Eric, 07/10).
    const voice = await brandOf(db, target.leadId, target.conversationId ?? null);
    const brand = voice?.name ?? null;
    const offBrand = (words: string) =>
      brand && mentionsWings(words)
        ? reply.status(422).send({
            error: 'brand_voice',
            message: `Nesta conversa você fala pelo time de expansão ${withArticle(brand, voice?.article ?? 'a', 'of')}: não cite a Wings.`,
          })
        : null;
    let payload: OutgoingPayload;
    let shown: string;
    let content: Record<string, unknown> = {};
    let planned: {
      plan: Extract<TemplatePlan, { ok: true }>;
      mediaId: string | null;
      artFileId: string | null;
    } | null = null;
    if (outgoing.kind === 'call_permission') {
      if (!window.open)
        return reply.status(409).send({
          error: 'window_closed',
          message:
            'Fora das 24 horas: o pedido de ligação vai por um modelo de pedido de ligação (em "Usar modelo").',
        });
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
    } else {
      // Who asked not to receive messages gets no template, not even as a common message:
      // only what a person writes, inside the window.
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
        },
        at,
      );
      const plan = await planTemplateFor(db, context, outgoing);
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
    const delivered = await deliverWhatsApp(db, fetchImpl(), config, {
      contact,
      conversationId: conversation.id,
      leadId: target.leadId,
      author: 'employee',
      employeeId: actor.employeeId,
      kind:
        outgoing.kind === 'call_permission'
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
    // Meta said the art behind the id is gone: the next send uploads it again (this one stays failed).
    if (
      outcome === 'failed' &&
      planned?.mediaId &&
      delivered.errorCode !== null &&
      ART_MEDIA_GONE_CODES.has(delivered.errorCode)
    )
      await invalidateArtMedia(db, planned.mediaId, at);
    if (outcome === 'sent' && outgoing.kind === 'call_permission')
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
    // A person writing takes the conversation: Sofia stops, the wait is over.
    await takeConversation(db, conversation.id, at);
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
        outcome,
        ...(delivered.errorCode === null ? {} : { errorCode: delivered.errorCode }),
      },
    });
    const authors = await authorsOf(db, [saved]);
    // Written either way: the bubble shows whether it went, and why not.
    return reply.status(201).send({ message: toMessage(saved, authors) });
  }

  const outgoingOf = (kind: 'text' | 'template', body: unknown): Outgoing | string => {
    if (kind === 'text') {
      const parsed = waSendTextSchema.safeParse(body);
      return parsed.success
        ? { kind: 'text', text: parsed.data.text }
        : (parsed.error.issues[0]?.message ?? 'Mensagem inválida.');
    }
    const parsed = waTemplateSendSchema.safeParse(body);
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
      // Any conversation the reader may see: the reply goes to that
      // conversation's own number (a deal's contact may not be its main phone).
      const found = await visibleConversation(request, params.data.id);
      if (!found) return notFound(reply);
      const outgoing = outgoingOf(kind, request.body);
      if (typeof outgoing === 'string')
        return reply.status(400).send({ error: 'invalid', message: outgoing });
      return send(
        request,
        reply,
        {
          leadId: found.conversation.leadId,
          phone: found.contact.phone,
          contact: found.contact,
          conversationId: found.conversation.id,
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
      const plan = await planTemplateFor(db, context, body.data);
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
    // One entry per template for the seller: the `_arte` version is chosen when it goes.
    const approved = new Set(rows.map((row) => `${row.name}|${row.language}`));
    const templates: WaTemplate[] = rows
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
