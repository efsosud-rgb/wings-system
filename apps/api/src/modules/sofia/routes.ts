import {
  can,
  SOFIA_CLOSE_LABELS,
  SOFIA_HANDOFF_LABELS,
  SOFIA_MODEL,
  SOFIA_SEGMENTS,
  SOFIA_STATES,
  sofiaAttendanceSchema,
  sofiaSettingsSchema,
  type LeadPipeline,
  type SofiaCloseReason,
  type SofiaConversationDetail,
  type SofiaConversationItem,
  type SofiaFact,
  type SofiaHandoffReason,
  type SofiaOverview,
  type SofiaSegment,
  type SofiaState,
} from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { employees, waConversations } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { leadInScope, leadOwnerFilter } from '../leads/access.js';
import { whatsappConfigOf } from '../whatsapp/graph.js';
import {
  buildThread,
  conversationItemOf,
  conversationListSql,
  type ConversationListRow,
} from '../whatsapp/thread.js';
import { sofiaSpentToday } from './engine.js';
import { loadSofiaSettings, saveSofiaSettings } from './settings.js';
import {
  factsOf,
  giveBackToSofia,
  setAttendance,
  SOFIA_GIVEN_BACK,
  takeConversation,
} from './state.js';

/**
 * Sofia's screen (docs/whatsapp/sofia.md): every WhatsApp conversation with
 * who has it, what she found out and the deal she made; taking a
 * conversation, giving it back to her, closing it; and her settings. Reading
 * and acting follow `leads.whatsapp` in the lead's owner scope (a seller sees
 * the conversations of their own deals; one with no deal yet is only for a
 * full-scope reader). Settings and the on/off switch need `sofia.manage`.
 */

const idParams = z.object({ id: z.uuid() });

const listQuery = z.object({
  state: z.enum(SOFIA_STATES).optional(),
  segment: z.enum([...SOFIA_SEGMENTS, 'none']).optional(),
  q: z.string().trim().max(80).optional(),
});

export function reasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === SOFIA_GIVEN_BACK) return 'Devolvida à Sofia';
  return (
    SOFIA_HANDOFF_LABELS[reason as SofiaHandoffReason] ??
    SOFIA_CLOSE_LABELS[reason as SofiaCloseReason] ??
    null
  );
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

export function itemOf(row: ConversationListRow, now: Date): SofiaConversationItem {
  const segment =
    (row.segment as SofiaSegment | null) ??
    (row.lead_pipeline === 'expansao' || row.lead_pipeline === 'formatacao'
      ? (row.lead_pipeline as SofiaSegment)
      : null);
  return {
    ...conversationItemOf(row, now),
    state: row.attendance as SofiaState,
    segment,
    brandName: row.brand_name,
    stateChangedAt: iso(row.state_changed_at),
    reason: reasonLabel(row.reason),
    ownerName: row.owner_name,
  };
}

export const sofiaRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const now = () => app.wings.now?.() ?? new Date();
  // The screen with every conversation: Admin Master, Diretoria and Gerente Comercial (13/10).
  // Inside it, rows still follow the lead's owner scope of `leads.whatsapp`.
  const use = { preHandler: app.requirePermission('sofia.read') };
  const manage = { preHandler: app.requirePermission('sofia.manage') };

  const ownerOf = (request: FastifyRequest) =>
    leadOwnerFilter(request.session.actor, 'leads.whatsapp');
  // Sofia's screen is the official number's: a work number's chats are never hers (central.md).
  const scopeSql = (owner: string | undefined) =>
    owner === undefined
      ? sql`and c.number_id is null`
      : sql`and c.number_id is null and l.owner_employee_id = ${owner}`;
  const canManage = (request: FastifyRequest) => can(request.session.actor, 'sofia.manage').allowed;

  app.get('/sofia/overview', use, async (request, reply) => {
    const settings = await loadSofiaSettings(db);
    const owner = ownerOf(request);
    const rows = await db.execute<{ attendance: string; n: number }>(sql`
      select c.attendance, count(*)::int as n
      from wa_conversations c left join leads l on l.id = c.lead_id
      where c.last_message_at is not null ${scopeSql(owner)}
      group by c.attendance`);
    const counts = Object.fromEntries(SOFIA_STATES.map((s) => [s, 0])) as Record<
      SofiaState,
      number
    >;
    for (const row of rows.rows)
      if ((SOFIA_STATES as readonly string[]).includes(row.attendance))
        counts[row.attendance as SofiaState] = Number(row.n);
    return reply.send({
      enabled: settings.enabled,
      whatsappConfigured: whatsappConfigOf(env) !== null,
      aiConfigured: Boolean(env.OPENROUTER_API_KEY),
      model: SOFIA_MODEL,
      dailyUsd: env.SOFIA_DAILY_USD,
      spentTodayUsd: await sofiaSpentToday(db, now()),
      counts,
      canManage: canManage(request),
    } satisfies SofiaOverview);
  });

  app.get('/sofia/conversations', use, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success)
      return reply.status(400).send({ error: 'invalid', message: 'Filtro inválido.' });
    const { state, segment, q } = query.data;
    const digits = q?.replace(/\D/g, '') ?? '';
    const rows = await db.execute<ConversationListRow>(
      conversationListSql({
        owner: ownerOf(request),
        readerId: request.session.actor.employeeId,
        limit: 200,
        where: sql`
        and c.number_id is null
        ${state ? sql`and c.attendance = ${state}` : sql``}
        ${
          segment === 'none'
            ? sql`and c.segment is null and l.pipeline is null`
            : segment
              ? sql`and (c.segment = ${segment} or (c.segment is null and l.pipeline = ${segment}))`
              : sql``
        }
        ${
          q
            ? sql`and (k.profile_name ilike ${`%${q}%`} or l.name ilike ${`%${q}%`}
                  ${digits.length >= 4 ? sql`or k.phone like ${`%${digits}%`}` : sql``})`
            : sql``
        }`,
      }),
    );
    const at = now();
    return reply.send({ conversations: rows.rows.map((row) => itemOf(row, at)) });
  });

  /** The conversation, if the reader may see it. */
  async function visible(request: FastifyRequest, id: string) {
    const conversation = await db.query.waConversations.findFirst({
      where: eq(waConversations.id, id),
    });
    if (!conversation || conversation.numberId) return null;
    if (conversation.leadId) {
      const lead = await leadInScope(
        db,
        request.session.actor,
        conversation.leadId,
        'leads.whatsapp',
      );
      return lead ? conversation : null;
    }
    return ownerOf(request) === undefined ? conversation : null;
  }

  app.get('/sofia/conversations/:id', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const conversation = params.success ? await visible(request, params.data.id) : null;
    if (!conversation)
      return reply.status(404).send({ error: 'not_found', message: 'Conversa não encontrada.' });
    const settings = await loadSofiaSettings(db);
    const at = now();
    const [row] = (
      await db.execute<ConversationListRow>(
        conversationListSql({
          owner: undefined,
          readerId: request.session.actor.employeeId,
          limit: 1,
          where: sql`and c.id = ${conversation.id}`,
        }),
      )
    ).rows;
    if (!row)
      return reply.status(404).send({ error: 'not_found', message: 'Conversa não encontrada.' });
    const item = itemOf(row, at);
    const facts = factsOf(conversation);
    const questions = item.segment === 'expansao' ? settings.expansao : settings.formatacao;
    const listed: SofiaFact[] = questions
      .filter((q) => facts.answers[q.key] !== undefined)
      .map((q) => ({ key: q.key, label: q.label, answer: facts.answers[q.key]! }));
    const others: SofiaFact[] = Object.entries(facts.answers)
      .filter(([key]) => !questions.some((q) => q.key === key))
      .map(([key, answer]) => ({ key, label: key, answer }));
    if (facts.brandText)
      others.push({ key: 'marca', label: 'Marca citada', answer: facts.brandText });
    const lead = conversation.leadId
      ? await db.query.leads.findFirst({
          where: (l, { eq: equals }) => equals(l.id, conversation.leadId!),
          columns: { id: true, name: true, pipeline: true, stage: true, ownerEmployeeId: true },
        })
      : undefined;
    const contact = await db.query.waContacts.findFirst({
      where: (k, { eq: equals }) => equals(k.id, conversation.contactId),
    });
    const referral = (conversation.referral ?? null) as {
      headline?: string | null;
      sourceId?: string | null;
    } | null;
    const state = item.state;
    const detail: SofiaConversationDetail = {
      item,
      facts: [...listed, ...others],
      origin: {
        code: conversation.originCode,
        adHeadline: referral?.headline ?? null,
        adId: referral?.sourceId ?? null,
      },
      lead: lead
        ? {
            id: lead.id,
            name: lead.name,
            pipeline: (lead.pipeline as LeadPipeline | null) ?? null,
            stage: lead.stage,
            ownerName: item.ownerName,
          }
        : null,
      thread: await buildThread(
        { db, env, fetchImpl: app.wings.whatsappFetch ?? fetch, now: at },
        contact ?? null,
        conversation.leadId,
        conversation.id,
      ),
      can: {
        take: state === 'sofia' || state === 'waiting_seller' || state === 'waiting_human',
        giveBack: settings.enabled && state !== 'sofia',
        close: state !== 'closed',
      },
    };
    return reply.send(detail);
  });

  app.post('/sofia/conversations/:id/attendance', use, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const conversation = params.success ? await visible(request, params.data.id) : null;
    if (!conversation)
      return reply.status(404).send({ error: 'not_found', message: 'Conversa não encontrada.' });
    const body = sofiaAttendanceSchema.safeParse(request.body);
    if (!body.success)
      return reply.status(400).send({ error: 'invalid', message: 'Ação inválida.' });
    const at = now();
    const { action } = body.data;
    if (action === 'give_back') {
      const settings = await loadSofiaSettings(db);
      if (!settings.enabled)
        return reply.status(409).send({
          error: 'sofia_off',
          message: 'A Sofia está desligada. Ligue-a na configuração antes de devolver.',
        });
      await giveBackToSofia(db, conversation.id, at);
    } else if (action === 'take') await takeConversation(db, conversation.id, at);
    else await setAttendance(db, conversation.id, 'closed', at, 'encerrada');
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: `sofia.${action}`,
      entity: conversation.leadId ? 'lead' : 'wa_conversation',
      entityId: conversation.leadId ?? conversation.id,
      ip: request.ip,
      metadata: { conversationId: conversation.id, from: conversation.attendance },
    });
    const [updated] = await db
      .select({ attendance: waConversations.attendance })
      .from(waConversations)
      .where(eq(waConversations.id, conversation.id));
    return reply.send({ state: (updated?.attendance ?? conversation.attendance) as SofiaState });
  });

  app.get('/sofia/settings', use, async (_request, reply) => {
    const settings = await loadSofiaSettings(db);
    const [row] = await db
      .execute<{ updated_at: Date | string; name: string | null }>(
        sql`
      select s.updated_at, e.full_name as name from sofia_settings s
      left join ${employees} e on e.id = s.updated_by limit 1`,
      )
      .then((r) => r.rows);
    return reply.send({
      settings,
      updatedAt: row ? iso(row.updated_at) : null,
      updatedBy: row?.name ?? null,
    });
  });

  app.put('/sofia/settings', manage, async (request, reply) => {
    const parsed = sofiaSettingsSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({
        error: 'invalid',
        message: parsed.error.issues[0]?.message ?? 'Configuração inválida.',
        path: parsed.error.issues[0]?.path ?? [],
      });
    const before = await loadSofiaSettings(db);
    await saveSofiaSettings(db, parsed.data, request.session.actor.employeeId, now());
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action:
        before.enabled !== parsed.data.enabled
          ? parsed.data.enabled
            ? 'sofia.enabled'
            : 'sofia.disabled'
          : 'sofia.settings_changed',
      entity: 'sofia_settings',
      ip: request.ip,
      metadata: {
        enabled: parsed.data.enabled,
        formatacao: parsed.data.formatacao.length,
        expansao: parsed.data.expansao.length,
      },
    });
    return reply.send({ settings: parsed.data });
  });
};
