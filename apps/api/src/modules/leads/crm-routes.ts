import {
  boardColumnQuerySchema,
  productivityQuerySchema,
  salesDashboardQuerySchema,
  can,
  crmSavedViewCreateSchema,
  leadListQuerySchema,
  crmStageCreateSchema,
  crmStageOrderSchema,
  crmStageUpdateSchema,
  distributionUpdateSchema,
  leadNoteCreateSchema,
  leadTaskCreateSchema,
  leadTaskUpdateSchema,
  leadUpdateSchema,
  taskListQuerySchema,
  LEAD_PIPELINES,
  type LeadPipeline,
} from '@wings/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { crmSavedViews, employees, leadTasks } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { canChangeLeadOwner, leadInScope, leadOwnerFilter, type LeadPermission } from './access.js';
import {
  addNote,
  boardColumn,
  boardCounters,
  boardOf,
  changeLead,
  createStage,
  createTask,
  distributionOf,
  listSellers,
  listStages,
  listTasks,
  reorderStages,
  setDistribution,
  updateStage,
  updateTask,
} from './crm.js';
import { productivityOf } from './productivity.js';
import { salesDashboardOf } from './sales-dashboard.js';
import { listFailedMetaEvents, metaQueueStatus, syncMetaFormLeads } from './meta-intake.js';
import { pollMetaLeadsLocked, pollStatus, testMetaConnection } from './meta-poll.js';
import { loadLead } from './service.js';

const idParam = z.object({ id: z.uuid() });
const taskParam = z.object({ id: z.uuid(), taskId: z.uuid() });
const pipelineQuery = z.object({ pipeline: z.enum(LEAD_PIPELINES).optional() });
const invalid = (message?: string) => ({
  error: 'invalid_request',
  message: message ?? 'Dados inválidos',
});
const notFound = { error: 'not_found', message: 'Lead não encontrado.' };

/**
 * CRM Vendas, Fase 1: the Funil as the place of work. Stages and the
 * rotation are configuration (`crm.manage`); moving, closing and annotating
 * a lead is `leads.write` in the caller's scope (a seller only on their own
 * leads); handing a lead to someone else is `leads.assign`. Every change is
 * recorded on the lead and in the audit log by id.
 */
export const crmRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  type Req = Parameters<typeof app.can>[0];

  /** The employee to filter queries by, or undefined for a caller who sees every lead (`access.ts`). */
  const ownScope = (request: Req, permission: LeadPermission) =>
    leadOwnerFilter(request.session.actor, permission);

  /** The lead, when the caller may see it (a seller sees only their own leads; an ownerless one is the Admin's). */
  const visibleLead = (request: Req, id: string, permission: LeadPermission) =>
    leadInScope(db, request.session.actor, id, permission);

  // --- stages --------------------------------------------------------------------------

  app.get(
    '/crm/stages',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const query = pipelineQuery.safeParse(request.query);
      if (!query.success) return reply.status(400).send(invalid());
      return reply.send({
        stages: await listStages(db, {
          pipeline: query.data.pipeline,
          withCounts: true,
          ownerEmployeeId: ownScope(request, 'leads.read'),
        }),
      });
    },
  );

  const manage = { preHandler: app.requirePermission('crm.manage') };

  app.post('/crm/stages', manage, async (request, reply) => {
    const body = crmStageCreateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    const actor = request.session.actor.employeeId;
    const stage = await createStage(db, { ...body.data, actorEmployeeId: actor });
    if (stage === 'exists')
      return reply
        .status(409)
        .send({ error: 'stage_exists', message: 'Já existe uma etapa com este nome.' });
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'crm_stage.created',
      entity: 'crm_stage',
      entityId: stage.id,
      ip: request.ip,
      metadata: { pipeline: stage.pipeline, position: stage.position },
    });
    return reply.status(201).send({ stage });
  });

  app.patch('/crm/stages/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = crmStageUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .status(400)
        .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    const stage = await updateStage(db, params.data.id, body.data);
    if (stage === null)
      return reply.status(404).send({ error: 'not_found', message: 'Etapa não encontrada.' });
    if (stage === 'exists')
      return reply
        .status(409)
        .send({ error: 'stage_exists', message: 'Já existe uma etapa com este nome.' });
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'crm_stage.updated',
      entity: 'crm_stage',
      entityId: stage.id,
      ip: request.ip,
      metadata: { fields: Object.keys(body.data) },
    });
    return reply.send({ stage });
  });

  app.put('/crm/stages/order', manage, async (request, reply) => {
    const body = crmStageOrderSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    const stages = await reorderStages(db, body.data.pipeline, body.data.ids);
    if (stages === 'mismatch')
      return reply
        .status(400)
        .send(invalid('A ordem precisa conter cada etapa ativa do funil uma vez.'));
    await writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action: 'crm_stage.reordered',
      entity: 'crm_pipeline',
      entityId: body.data.pipeline,
      ip: request.ip,
      metadata: { count: body.data.ids.length },
    });
    return reply.send({ stages });
  });

  // --- the lead -------------------------------------------------------------------------

  app.patch(
    '/leads/:id',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = leadUpdateSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .status(400)
          .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
      const row = await visibleLead(request, params.data.id, 'leads.write');
      if (!row) return reply.status(404).send(notFound);
      const actor = request.session.actor.employeeId;
      if (
        body.data.ownerEmployeeId !== undefined &&
        body.data.ownerEmployeeId !== row.ownerEmployeeId
      ) {
        // Only the Admin (`leads.assign`) changes who owns a lead: to someone else, to oneself or to nobody.
        if (!canChangeLeadOwner(request.session.actor)) {
          return reply.status(403).send({
            error: 'forbidden',
            message: 'Só quem pode atribuir leads (leads.assign) muda o dono.',
          });
        }
        if (body.data.ownerEmployeeId) {
          const owner = await db.query.employees.findFirst({
            where: eq(employees.id, body.data.ownerEmployeeId),
            columns: { id: true, status: true },
          });
          if (!owner || owner.status !== 'active')
            return reply.status(400).send(invalid('Funcionário inexistente ou inativo.'));
        }
      }
      const result = await changeLead(db, {
        leadId: row.id,
        stageId: body.data.stageId,
        pipeline: body.data.pipeline,
        // Whoever may not assign never reaches the owner column, whatever the body says.
        ownerEmployeeId: canChangeLeadOwner(request.session.actor)
          ? body.data.ownerEmployeeId
          : undefined,
        won: body.data.won,
        lostReason: body.data.lostReason,
        source: 'wings',
        actorEmployeeId: actor,
        requireOwnerEmployeeId: ownScope(request, 'leads.write'),
      });
      if (!result.ok) {
        const messages = {
          not_found: notFound.message,
          stage_not_found: 'Etapa não encontrada.',
          stage_wrong_pipeline: 'A etapa pertence a outro funil.',
          stage_inactive: 'Esta etapa foi desativada.',
        } as const;
        return reply
          .status(result.reason === 'not_found' ? 404 : 400)
          .send({ error: result.reason, message: messages[result.reason] });
      }
      if (result.changed.length > 0) {
        await writeAudit(db, {
          actorEmployeeId: actor,
          action: 'lead.updated',
          entity: 'lead',
          entityId: row.id,
          ip: request.ip,
          metadata: {
            changed: result.changed,
            stageId: result.lead.stageId,
            won: result.lead.won,
            ownerEmployeeId: result.lead.ownerEmployeeId,
          },
        });
      }
      return reply.send(await loadLead(db, row.id));
    },
  );

  app.post(
    '/leads/:id/notes',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = leadNoteCreateSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .status(400)
          .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
      const row = await visibleLead(request, params.data.id, 'leads.write');
      if (!row) return reply.status(404).send(notFound);
      const actor = request.session.actor.employeeId;
      const note = await addNote(db, {
        leadId: row.id,
        body: body.data.body,
        authorEmployeeId: actor,
      });
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'lead.note_added',
        entity: 'lead',
        entityId: row.id,
        ip: request.ip,
        metadata: { noteId: note.id },
      });
      return reply.status(201).send({ note });
    },
  );

  // --- tasks ---------------------------------------------------------------------------

  app.post(
    '/leads/:id/tasks',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      const body = leadTaskCreateSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .status(400)
          .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
      const row = await visibleLead(request, params.data.id, 'leads.write');
      if (!row) return reply.status(404).send(notFound);
      const actor = request.session.actor.employeeId;
      // Only whoever may assign leads puts a task on someone else; the others' tasks stay with the lead's owner.
      let assignee = row.ownerEmployeeId ?? actor;
      if (body.data.assigneeEmployeeId && canChangeLeadOwner(request.session.actor)) {
        const target = await db.query.employees.findFirst({
          where: eq(employees.id, body.data.assigneeEmployeeId),
          columns: { id: true, status: true },
        });
        if (!target || target.status !== 'active')
          return reply.status(400).send(invalid('Funcionário inexistente ou inativo.'));
        assignee = target.id;
      }
      const task = await createTask(db, {
        leadId: row.id,
        kind: body.data.kind,
        title: body.data.title,
        dueAt: new Date(body.data.dueAt),
        assigneeEmployeeId: assignee,
        createdBy: actor,
      });
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'lead.task_created',
        entity: 'lead',
        entityId: row.id,
        ip: request.ip,
        metadata: { taskId: task.id, kind: task.kind },
      });
      return reply.status(201).send({ task });
    },
  );

  app.patch(
    '/leads/:id/tasks/:taskId',
    { preHandler: app.requirePermission('leads.write') },
    async (request, reply) => {
      const params = taskParam.safeParse(request.params);
      const body = leadTaskUpdateSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply
          .status(400)
          .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
      const row = await visibleLead(request, params.data.id, 'leads.write');
      if (!row) return reply.status(404).send(notFound);
      const existing = await db.query.leadTasks.findFirst({
        where: eq(leadTasks.id, params.data.taskId),
      });
      if (!existing || existing.leadId !== row.id)
        return reply.status(404).send({ error: 'not_found', message: 'Tarefa não encontrada.' });
      const actor = request.session.actor.employeeId;
      const task = await updateTask(db, {
        taskId: existing.id,
        done: body.data.done,
        dueAt: body.data.dueAt ? new Date(body.data.dueAt) : undefined,
        title: body.data.title,
        actorEmployeeId: actor,
      });
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'lead.task_updated',
        entity: 'lead',
        entityId: row.id,
        ip: request.ip,
        metadata: { taskId: existing.id, fields: Object.keys(body.data) },
      });
      return reply.send({ task });
    },
  );

  /** The caller's tasks (every seller's, with `everyone=true`, for a scope wider than own). */
  app.get(
    '/crm/tasks',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const query = taskListQuerySchema.safeParse(request.query);
      if (!query.success) return reply.status(400).send(invalid());
      const own = ownScope(request, 'leads.read');
      const everyone = query.data.everyone === true && own === undefined;
      return reply.send({
        tasks: await listTasks(db, {
          assigneeEmployeeId: everyone ? query.data.assignee : request.session.actor.employeeId,
          ownerEmployeeId: own,
          status: query.data.status,
          kind: query.data.kind,
        }),
      });
    },
  );

  // --- kanban --------------------------------------------------------------------------

  const boardQuery = leadListQuerySchema.extend({ pipeline: z.enum(LEAD_PIPELINES) });

  app.get(
    '/leads/board',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const query = boardQuery.safeParse(request.query);
      if (!query.success) return reply.status(400).send(invalid('Informe o funil.'));
      const own = ownScope(request, 'leads.read');
      const mine = query.data.mine ? request.session.actor.employeeId : undefined;
      return reply.send(await boardOf(db, { ...query.data, ownerEmployeeId: own ?? mine }));
    },
  );

  app.get(
    '/crm/dashboard',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const query = salesDashboardQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply
          .status(400)
          .send(invalid(query.error.issues[0]?.message ?? 'Filtros inválidos.'));
      return reply.send(
        await salesDashboardOf(db, {
          ...query.data,
          ownerEmployeeId: ownScope(request, 'leads.read'),
          spendVisible: can(request.session.actor, 'ads.read').allowed,
        }),
      );
    },
  );

  // Painel de Vendas › Produtividade (docs/crm/produtividade.md): who sees whom is decided per
  // person inside `productivityOf` (own: themselves and the sector's totals; sector: the sector).
  app.get(
    '/crm/productivity',
    { preHandler: app.requirePermission('productivity.read') },
    async (request, reply) => {
      const query = productivityQuerySchema.safeParse(request.query);
      if (!query.success)
        return reply
          .status(400)
          .send(invalid(query.error.issues[0]?.message ?? 'Filtros inválidos.'));
      return reply.send(await productivityOf(db, { ...query.data, actor: request.session.actor }));
    },
  );

  app.get(
    '/leads/board/column',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const query = boardQuery.extend(boardColumnQuerySchema.shape).safeParse(request.query);
      if (!query.success) return reply.status(400).send(invalid('Informe o funil e a etapa.'));
      const own = ownScope(request, 'leads.read');
      const mine = query.data.mine ? request.session.actor.employeeId : undefined;
      return reply.send({
        cards: await boardColumn(db, {
          ...query.data,
          stageId: query.data.stageId === 'none' ? null : query.data.stageId,
          ownerEmployeeId: own ?? mine,
        }),
      });
    },
  );

  app.get(
    '/leads/board/counters',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const query = pipelineQuery.safeParse(request.query);
      if (!query.success || !query.data.pipeline)
        return reply.status(400).send(invalid('Informe o funil.'));
      return reply.send(
        await boardCounters(db, {
          pipeline: query.data.pipeline,
          ownerEmployeeId: ownScope(request, 'leads.read'),
        }),
      );
    },
  );

  // --- saved views (a person's own tabs) -------------------------------------------------

  app.get(
    '/crm/views',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const rows = await db
        .select()
        .from(crmSavedViews)
        .where(eq(crmSavedViews.employeeId, request.session.actor.employeeId))
        .orderBy(asc(crmSavedViews.createdAt));
      return reply.send({
        views: rows.map((row) => ({
          id: row.id,
          pipeline: row.pipeline as LeadPipeline,
          name: row.name,
          filters: row.filters,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    },
  );

  app.post(
    '/crm/views',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const body = crmSavedViewCreateSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
      const [row] = await db
        .insert(crmSavedViews)
        .values({ ...body.data, employeeId: request.session.actor.employeeId })
        .returning();
      if (!row) throw new Error('view insert returned no row');
      return reply.status(201).send({
        view: {
          id: row.id,
          pipeline: row.pipeline,
          name: row.name,
          filters: row.filters,
          createdAt: row.createdAt.toISOString(),
        },
      });
    },
  );

  app.delete(
    '/crm/views/:id',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const params = idParam.safeParse(request.params);
      if (!params.success) return reply.status(400).send(invalid());
      const removed = await db
        .delete(crmSavedViews)
        .where(
          and(
            eq(crmSavedViews.id, params.data.id),
            eq(crmSavedViews.employeeId, request.session.actor.employeeId),
          ),
        )
        .returning({ id: crmSavedViews.id });
      if (removed.length === 0)
        return reply.status(404).send({ error: 'not_found', message: 'Visão não encontrada.' });
      return reply.status(204).send();
    },
  );

  // --- Meta Lead Ads: queue status and "Buscar leads da Meta" ------------------------------

  const pollingOn = Boolean(env.META_LEADS_ACCESS_TOKEN) && env.META_LEADS_POLL !== 'false';

  // The team's queue and the switches: the Integrações screen only, not the sellers.
  app.get(
    '/crm/meta-leads/status',
    { preHandler: app.requirePermission('integrations.manage') },
    async (_request, reply) =>
      reply.send({
        ...(await metaQueueStatus(db)),
        webhookConfigured: Boolean(env.META_APP_SECRET && env.META_LEADGEN_VERIFY_TOKEN),
        tokenConfigured: Boolean(env.META_LEADS_ACCESS_TOKEN ?? env.META_WRITE_TOKEN),
        polling: { enabled: pollingOn, everyMinutes: 5, ...(await pollStatus(db)) },
      }),
  );

  /** The events that gave up: when, form, campaign and why. Ids and codes only, never a person. */
  app.get(
    '/crm/meta-leads/failed',
    { preHandler: app.requirePermission('integrations.manage') },
    async (_request, reply) => reply.send(await listFailedMetaEvents(db)),
  );

  const metaDeps = () => ({
    db,
    accessToken: env.META_LEADS_ACCESS_TOKEN ?? null,
    rdCrmToken: env.RD_CRM_API_TOKEN ?? null,
    expansionOwnerId: env.EXPANSION_OWNER_RD_USER_ID ?? null,
    rdCopyEnabled: env.META_LEADS_RD_COPY_ENABLED !== 'false',
    graphFetch: app.wings.platformFetch,
    rdFetch: app.wings.rdFetch,
    extraPageIds: env.META_LEADS_PAGE_IDS
      ? env.META_LEADS_PAGE_IDS.split(',').map((id) => id.trim())
      : [],
    log: (facts: Record<string, unknown>) => app.log.info(facts),
  });
  const noMetaKey = {
    error: 'meta_token_not_configured',
    message: 'A chave de leitura de leads da Meta (META_LEADS_ACCESS_TOKEN) não está configurada.',
  };

  /** "Testar conexão": pages, forms and leads the key sees, as totals; nothing about a person, nothing written. */
  app.post(
    '/crm/meta-leads/test',
    { preHandler: app.requirePermission('integrations.manage') },
    async (request, reply) => {
      if (!env.META_LEADS_ACCESS_TOKEN) return reply.status(503).send(noMetaKey);
      const result = await testMetaConnection(metaDeps());
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'meta_leads.connection_tested',
        entity: 'meta_leadgen',
        entityId: 'connection',
        ip: request.ip,
        metadata: {
          pages: result.pages,
          forms: result.forms,
          leads: result.leads,
          failed: Object.keys(result.failed).length,
        },
      });
      return reply.send(result);
    },
  );

  /** "Buscar agora": one pass of the periodic read, at once (90 days on the first one). */
  app.post(
    '/crm/meta-leads/poll',
    { preHandler: app.requirePermission('integrations.manage') },
    async (request, reply) => {
      if (!env.META_LEADS_ACCESS_TOKEN) return reply.status(503).send(noMetaKey);
      const result = await pollMetaLeadsLocked(metaDeps());
      if (result === 'locked')
        return reply.status(409).send({
          error: 'poll_running',
          message: 'Já há uma busca em andamento. Tente de novo em instantes.',
        });
      await writeAudit(db, {
        actorEmployeeId: request.session.actor.employeeId,
        action: 'meta_leads.poll_requested',
        entity: 'meta_leadgen',
        entityId: 'forms',
        ip: request.ip,
        metadata: {
          pages: result.pages,
          forms: result.forms,
          listed: result.listed,
          queued: result.queued,
          alreadyKnown: result.alreadyKnown,
          failed: Object.keys(result.failed).length,
        },
      });
      return reply.send(result);
    },
  );

  /**
   * Lists the last 90 days of every form with a rule and queues what the
   * webhook did not bring (Eric, 05/10). A person's click; totals only.
   */
  app.post(
    '/crm/meta-leads/sync',
    { preHandler: app.requirePermission('integrations.manage') },
    async (request, reply) => {
      const token = env.META_LEADS_ACCESS_TOKEN ?? env.META_WRITE_TOKEN;
      if (!token) {
        return reply.status(503).send({
          error: 'meta_token_not_configured',
          message:
            'O token de leitura de leads da Meta (META_LEADS_ACCESS_TOKEN) não está configurado.',
        });
      }
      const actor = request.session.actor.employeeId;
      const result = await syncMetaFormLeads({
        db,
        accessToken: token,
        rdCrmToken: env.RD_CRM_API_TOKEN ?? null,
        expansionOwnerId: env.EXPANSION_OWNER_RD_USER_ID ?? null,
        rdCopyEnabled: env.META_LEADS_RD_COPY_ENABLED !== 'false',
        graphFetch: app.wings.platformFetch,
        rdFetch: app.wings.rdFetch,
        log: (facts) => app.log.info(facts),
      });
      await writeAudit(db, {
        actorEmployeeId: actor,
        action: 'meta_leads.sync_requested',
        entity: 'meta_leadgen',
        entityId: 'forms',
        ip: request.ip,
        metadata: {
          forms: result.forms,
          listed: result.listed,
          queued: result.queued,
          alreadyKnown: result.alreadyKnown,
          failed: Object.keys(result.failed).length,
        },
      });
      if (result.queued > 0) app.wings.metaLeadKick?.();
      return reply.status(202).send(result);
    },
  );

  // --- distribution and sellers ----------------------------------------------------------

  // The team list is for who hands deals over; a seller sees only their own deals (Eric, 14/10).
  app.get(
    '/crm/sellers',
    { preHandler: app.requirePermission('leads.assign') },
    async (_request, reply) => reply.send({ sellers: await listSellers(db) }),
  );

  app.get('/crm/distribution', manage, async (_request, reply) => {
    const distributions = await Promise.all(
      LEAD_PIPELINES.map((pipeline: LeadPipeline) => distributionOf(db, pipeline)),
    );
    return reply.send({ distributions });
  });

  app.put('/crm/distribution', manage, async (request, reply) => {
    const body = distributionUpdateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    const sellers = new Set((await listSellers(db)).filter((s) => s.active).map((s) => s.id));
    if (body.data.members.some((member) => !sellers.has(member.employeeId)))
      return reply
        .status(400)
        .send(
          invalid('Só vendedores, gerentes comerciais e Diretoria ativos entram na distribuição.'),
        );
    const actor = request.session.actor.employeeId;
    const distribution = await setDistribution(db, { ...body.data, actorEmployeeId: actor });
    await writeAudit(db, {
      actorEmployeeId: actor,
      action: 'crm_distribution.updated',
      entity: 'crm_pipeline',
      entityId: body.data.pipeline,
      ip: request.ip,
      metadata: {
        members: body.data.members.length,
        active: body.data.members.filter((m) => m.active).length,
      },
    });
    return reply.send({ distribution });
  });
};
