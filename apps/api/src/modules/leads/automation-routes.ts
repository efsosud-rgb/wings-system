import {
  automationRuleCreateSchema,
  automationRuleUpdateSchema,
  automationEmailConfigSchema,
  automationNotifyConfigSchema,
  automationOwnerConfigSchema,
  automationSequenceConfigSchema,
  automationTaskConfigSchema,
  emailTemplateSaveSchema,
  LEAD_PIPELINES,
  sequenceSaveSchema,
  type AutomationRule,
  type AutomationRuleKind,
  type AutomationSequence,
  type EmailTemplate,
  type SequenceStepKind,
} from '@wings/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  crmAutomationRules,
  crmAutomationRuns,
  crmEmailTemplates,
  crmSequences,
  crmSequenceSteps,
  crmStageLimits,
  crmStages,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { runCrmCycle } from './automations-scheduler.js';
import { canChangeLeadOwner, leadOwnerFilter } from './access.js';
import { markRead, newLeadPopupsOf, notificationsOf } from './crm-alerts.js';
import { crmMailOf } from './crm-mail.js';

const idParam = z.object({ id: z.uuid() });
const pipelineQuery = z.object({ pipeline: z.enum(LEAD_PIPELINES) });
const invalid = (message?: string) => ({
  error: 'invalid_request',
  message: message ?? 'Dados inválidos',
});
const gone = (what: string) => ({ error: 'not_found', message: `${what} não encontrado.` });

const CONFIG_SCHEMAS = {
  create_task: automationTaskConfigSchema,
  change_owner: automationOwnerConfigSchema,
  notify: automationNotifyConfigSchema,
  start_sequence: automationSequenceConfigSchema,
  send_email: automationEmailConfigSchema,
} as const;

const toRule = (row: typeof crmAutomationRules.$inferSelect): AutomationRule => ({
  id: row.id,
  pipeline: row.pipeline,
  stageId: row.stageId,
  position: row.position,
  kind: row.kind as AutomationRuleKind,
  config: row.config as Record<string, unknown>,
  delayMinutes: row.delayMinutes,
  active: row.active,
});

const toTemplate = (row: typeof crmEmailTemplates.$inferSelect): EmailTemplate => ({
  id: row.id,
  name: row.name,
  subject: row.subject,
  body: row.body,
  active: row.active,
});

/**
 * CRM Vendas → Regras de automação (`crm.manage`): the rules of each stage,
 * the sequences they can start and the e-mail templates. Every change writes
 * an audit entry by id. Nothing here sends an e-mail: sending is the rules'
 * work, through the transport CRM_EMAIL_MODE chooses (a recording one by default).
 */
export const automationRoutes: FastifyPluginAsync = async (app) => {
  const { db, env } = app.wings;
  const manage = { preHandler: app.requirePermission('crm.manage') };
  const audit = (
    request: { session: { actor: { employeeId: string } }; ip: string },
    action: string,
    entity: string,
    entityId: string,
    metadata: Record<string, unknown> = {},
  ) =>
    writeAudit(db, {
      actorEmployeeId: request.session.actor.employeeId,
      action,
      entity,
      entityId,
      ip: request.ip,
      metadata,
    });

  // --- rules ---------------------------------------------------------------------------

  app.get('/crm/automations/rules', manage, async (request, reply) => {
    const query = pipelineQuery.safeParse(request.query);
    if (!query.success) return reply.status(400).send(invalid());
    const rows = await db
      .select()
      .from(crmAutomationRules)
      .where(eq(crmAutomationRules.pipeline, query.data.pipeline))
      .orderBy(asc(crmAutomationRules.position), asc(crmAutomationRules.createdAt));
    return reply.send({ rules: rows.map(toRule) });
  });

  /** A rule's references must exist: stage of its funnel, template, sequence, person. */
  async function referencesProblem(
    kind: AutomationRuleKind | SequenceStepKind,
    config: Record<string, unknown>,
  ): Promise<string | null> {
    if (kind === 'send_email') {
      const template = await db.query.crmEmailTemplates.findFirst({
        where: eq(crmEmailTemplates.id, String(config.templateId)),
      });
      if (!template) return 'Modelo de e-mail não encontrado.';
    }
    if (kind === 'start_sequence') {
      const sequence = await db.query.crmSequences.findFirst({
        where: eq(crmSequences.id, String(config.sequenceId)),
      });
      if (!sequence) return 'Sequência não encontrada.';
    }
    return null;
  }

  const ownerRuleRefusal = {
    error: 'forbidden',
    message: 'Só quem pode atribuir negociações cria ou muda uma regra que troca o dono.',
  };

  app.post('/crm/automations/rules', manage, async (request, reply) => {
    const body = automationRuleCreateSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    // A rule that changes the owner is an owner change: only who may assign leads sets one up.
    if (body.data.kind === 'change_owner' && !canChangeLeadOwner(request.session.actor))
      return reply.status(403).send(ownerRuleRefusal);
    const stage = await db.query.crmStages.findFirst({
      where: eq(crmStages.id, body.data.stageId),
    });
    if (!stage || stage.pipeline !== body.data.pipeline)
      return reply.status(400).send(invalid('Etapa inválida para este funil.'));
    const problem = await referencesProblem(body.data.kind, body.data.config);
    if (problem) return reply.status(400).send(invalid(problem));
    const [last] = await db
      .select({ max: sql<number>`coalesce(max(${crmAutomationRules.position}), 0)::int` })
      .from(crmAutomationRules)
      .where(eq(crmAutomationRules.stageId, body.data.stageId));
    const [row] = await db
      .insert(crmAutomationRules)
      .values({
        pipeline: body.data.pipeline,
        stageId: body.data.stageId,
        position: (last?.max ?? 0) + 1,
        kind: body.data.kind,
        config: body.data.config,
        delayMinutes: body.data.delayMinutes,
        active: body.data.active,
        createdBy: request.session.actor.employeeId,
      })
      .returning();
    if (!row) throw new Error('rule insert returned no row');
    await audit(request, 'crm_automation_rule.created', 'crm_automation_rule', row.id, {
      kind: row.kind,
      stageId: row.stageId,
    });
    return reply.status(201).send({ rule: toRule(row) });
  });

  app.patch('/crm/automations/rules/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = automationRuleUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .status(400)
        .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    const rule = await db.query.crmAutomationRules.findFirst({
      where: eq(crmAutomationRules.id, params.data.id),
    });
    if (!rule) return reply.status(404).send(gone('Regra'));
    if (rule.kind === 'change_owner' && !canChangeLeadOwner(request.session.actor))
      return reply.status(403).send(ownerRuleRefusal);
    let config: Record<string, unknown> | undefined;
    if (body.data.config) {
      const parsed = CONFIG_SCHEMAS[rule.kind as AutomationRuleKind].safeParse(body.data.config);
      if (!parsed.success) return reply.status(400).send(invalid(parsed.error.issues[0]?.message));
      config = parsed.data as Record<string, unknown>;
      const problem = await referencesProblem(rule.kind as AutomationRuleKind, config);
      if (problem) return reply.status(400).send(invalid(problem));
    }
    const [row] = await db
      .update(crmAutomationRules)
      .set({
        ...(config ? { config } : {}),
        ...(body.data.delayMinutes !== undefined ? { delayMinutes: body.data.delayMinutes } : {}),
        ...(body.data.active !== undefined ? { active: body.data.active } : {}),
        updatedAt: new Date(),
      })
      .where(eq(crmAutomationRules.id, rule.id))
      .returning();
    await audit(request, 'crm_automation_rule.updated', 'crm_automation_rule', rule.id, {
      fields: Object.keys(body.data),
    });
    return reply.send({ rule: toRule(row!) });
  });

  app.delete('/crm/automations/rules/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    if (!params.success) return reply.status(400).send(invalid());
    const rule = await db.query.crmAutomationRules.findFirst({
      where: eq(crmAutomationRules.id, params.data.id),
    });
    if (!rule) return reply.status(404).send(gone('Regra'));
    // A rule that already ran stays in the history: it is switched off, not deleted.
    const [ran] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(crmAutomationRuns)
      .where(eq(crmAutomationRuns.ruleId, rule.id));
    if ((ran?.n ?? 0) > 0) {
      await db
        .update(crmAutomationRules)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(crmAutomationRules.id, rule.id));
      await db
        .update(crmAutomationRuns)
        .set({ status: 'cancelled', doneAt: new Date(), result: { reason: 'rule_removed' } })
        .where(and(eq(crmAutomationRuns.ruleId, rule.id), eq(crmAutomationRuns.status, 'pending')));
    } else {
      await db.delete(crmAutomationRules).where(eq(crmAutomationRules.id, rule.id));
    }
    await audit(request, 'crm_automation_rule.removed', 'crm_automation_rule', rule.id, {
      kind: rule.kind,
      kept: (ran?.n ?? 0) > 0,
    });
    return reply.status(204).send();
  });

  // --- e-mail templates -------------------------------------------------------------------

  app.get('/crm/automations/templates', manage, async (_request, reply) => {
    const rows = await db.select().from(crmEmailTemplates).orderBy(asc(crmEmailTemplates.name));
    return reply.send({ templates: rows.map(toTemplate) });
  });

  app.post('/crm/automations/templates', manage, async (request, reply) => {
    const body = emailTemplateSaveSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    const twin = await db.query.crmEmailTemplates.findFirst({
      where: eq(crmEmailTemplates.name, body.data.name),
    });
    if (twin)
      return reply
        .status(409)
        .send({ error: 'template_exists', message: 'Já existe um modelo com este nome.' });
    const [row] = await db
      .insert(crmEmailTemplates)
      .values({ ...body.data, createdBy: request.session.actor.employeeId })
      .returning();
    await audit(request, 'crm_email_template.created', 'crm_email_template', row!.id);
    return reply.status(201).send({ template: toTemplate(row!) });
  });

  app.put('/crm/automations/templates/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = emailTemplateSaveSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .status(400)
        .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    const current = await db.query.crmEmailTemplates.findFirst({
      where: eq(crmEmailTemplates.id, params.data.id),
    });
    if (!current) return reply.status(404).send(gone('Modelo'));
    if (body.data.name !== current.name) {
      const twin = await db.query.crmEmailTemplates.findFirst({
        where: eq(crmEmailTemplates.name, body.data.name),
      });
      if (twin)
        return reply
          .status(409)
          .send({ error: 'template_exists', message: 'Já existe um modelo com este nome.' });
    }
    const [row] = await db
      .update(crmEmailTemplates)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(crmEmailTemplates.id, current.id))
      .returning();
    await audit(request, 'crm_email_template.updated', 'crm_email_template', current.id);
    return reply.send({ template: toTemplate(row!) });
  });

  // --- sequences ---------------------------------------------------------------------------

  async function loadSequences(ids?: string[]): Promise<AutomationSequence[]> {
    const rows = await db
      .select()
      .from(crmSequences)
      .where(ids ? inArray(crmSequences.id, ids) : undefined)
      .orderBy(asc(crmSequences.name));
    if (rows.length === 0) return [];
    const steps = await db
      .select()
      .from(crmSequenceSteps)
      .where(
        and(
          eq(crmSequenceSteps.retired, false),
          inArray(
            crmSequenceSteps.sequenceId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(asc(crmSequenceSteps.position));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      active: row.active,
      steps: steps
        .filter((s) => s.sequenceId === row.id)
        .map((s) => ({
          id: s.id,
          position: s.position,
          kind: s.kind as SequenceStepKind,
          afterHours: s.afterHours,
          config: s.config as Record<string, unknown>,
        })),
    }));
  }

  app.get('/crm/automations/sequences', manage, async (_request, reply) =>
    reply.send({ sequences: await loadSequences() }),
  );

  async function saveSequence(id: string | null, input: z.output<typeof sequenceSaveSchema>) {
    for (const step of input.steps) {
      const problem = await referencesProblem(step.kind, step.config);
      if (problem) return { problem } as const;
    }
    const savedId = await db.transaction(async (tx) => {
      let sequenceId = id;
      if (sequenceId) {
        await tx
          .update(crmSequences)
          .set({ name: input.name, active: input.active, updatedAt: new Date() })
          .where(eq(crmSequences.id, sequenceId));
        // Steps already scheduled keep pointing at their old rows: those rows stay.
        const used = await tx
          .select({ stepId: crmAutomationRuns.stepId })
          .from(crmAutomationRuns)
          .where(eq(crmAutomationRuns.sequenceId, sequenceId));
        const keep = new Set(used.map((u) => u.stepId));
        const existing = await tx
          .select({ id: crmSequenceSteps.id })
          .from(crmSequenceSteps)
          .where(eq(crmSequenceSteps.sequenceId, sequenceId));
        const removable = existing.filter((s) => !keep.has(s.id)).map((s) => s.id);
        if (removable.length > 0)
          await tx.delete(crmSequenceSteps).where(inArray(crmSequenceSteps.id, removable));
        // The kept ones are retired (still run for deals already inside); the new list takes 1..n.
        await tx
          .update(crmSequenceSteps)
          .set({ retired: true })
          .where(eq(crmSequenceSteps.sequenceId, sequenceId));
      } else {
        const [row] = await tx
          .insert(crmSequences)
          .values({
            name: input.name,
            active: input.active,
            createdBy: null,
          })
          .returning({ id: crmSequences.id });
        sequenceId = row!.id;
      }
      await tx.insert(crmSequenceSteps).values(
        input.steps.map((step, index) => ({
          sequenceId: sequenceId!,
          position: index + 1,
          kind: step.kind,
          afterHours: step.afterHours,
          config: step.config,
        })),
      );
      return sequenceId;
    });
    return { id: savedId } as const;
  }

  app.post('/crm/automations/sequences', manage, async (request, reply) => {
    const body = sequenceSaveSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(invalid(body.error.issues[0]?.message));
    const twin = await db.query.crmSequences.findFirst({
      where: eq(crmSequences.name, body.data.name),
    });
    if (twin)
      return reply
        .status(409)
        .send({ error: 'sequence_exists', message: 'Já existe uma sequência com este nome.' });
    const saved = await saveSequence(null, body.data);
    if ('problem' in saved) return reply.status(400).send(invalid(saved.problem));
    await audit(request, 'crm_sequence.created', 'crm_sequence', saved.id, {
      steps: body.data.steps.length,
    });
    const [sequence] = await loadSequences([saved.id]);
    return reply.status(201).send({ sequence });
  });

  app.put('/crm/automations/sequences/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = sequenceSaveSchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .status(400)
        .send(invalid(body.success ? undefined : body.error.issues[0]?.message));
    const current = await db.query.crmSequences.findFirst({
      where: eq(crmSequences.id, params.data.id),
    });
    if (!current) return reply.status(404).send(gone('Sequência'));
    if (body.data.name !== current.name) {
      const twin = await db.query.crmSequences.findFirst({
        where: eq(crmSequences.name, body.data.name),
      });
      if (twin)
        return reply
          .status(409)
          .send({ error: 'sequence_exists', message: 'Já existe uma sequência com este nome.' });
    }
    const saved = await saveSequence(current.id, body.data);
    if ('problem' in saved) return reply.status(400).send(invalid(saved.problem));
    await audit(request, 'crm_sequence.updated', 'crm_sequence', current.id, {
      steps: body.data.steps.length,
    });
    const [sequence] = await loadSequences([current.id]);
    return reply.send({ sequence });
  });

  // --- stage limits and the panel's notices ----------------------------------------------------

  app.get('/crm/automations/stage-limits', manage, async (_request, reply) => {
    const rows = await db.select().from(crmStageLimits);
    return reply.send({ limits: rows.map((r) => ({ stageId: r.stageId, maxDays: r.maxDays })) });
  });

  app.put('/crm/automations/stage-limits/:id', manage, async (request, reply) => {
    const params = idParam.safeParse(request.params);
    const body = z.object({ maxDays: z.number().int().min(0).max(365) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send(invalid());
    const stage = await db.query.crmStages.findFirst({ where: eq(crmStages.id, params.data.id) });
    if (!stage) return reply.status(404).send(gone('Etapa'));
    const by = request.session.actor.employeeId;
    await db
      .insert(crmStageLimits)
      .values({ stageId: stage.id, maxDays: body.data.maxDays, updatedBy: by })
      .onConflictDoUpdate({
        target: crmStageLimits.stageId,
        set: { maxDays: body.data.maxDays, updatedBy: by, updatedAt: new Date() },
      });
    await audit(request, 'crm_stage_limit.set', 'crm_stage', stage.id, {
      maxDays: body.data.maxDays,
    });
    return reply.send({ stageId: stage.id, maxDays: body.data.maxDays });
  });

  /** The caller's own notices; every CRM user sees only theirs. */
  app.get(
    '/crm/notifications',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const rows = await notificationsOf(
        db,
        request.session.actor.employeeId,
        100,
        leadOwnerFilter(request.session.actor, 'leads.read') !== undefined,
      );
      return reply.send({
        unread: rows.filter((r) => r.readAt === null).length,
        notifications: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          readAt: r.readAt?.toISOString() ?? null,
        })),
      });
    },
  );

  /** The caller's own new leads for the pop-up: the owner's alone, whatever the role (docs/crm/avisos-por-email.md). */
  app.get(
    '/crm/notifications/new-leads',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) =>
      reply.send(await newLeadPopupsOf(db, request.session.actor.employeeId)),
  );

  app.post(
    '/crm/notifications/read',
    { preHandler: app.requirePermission('leads.read') },
    async (request, reply) => {
      const body = z
        .object({ ids: z.union([z.literal('all'), z.array(z.uuid()).min(1).max(200)]) })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(invalid());
      const marked = await markRead(db, request.session.actor.employeeId, body.data.ids);
      return reply.send({ marked });
    },
  );

  // --- running what is due ------------------------------------------------------------------

  /** The delayed rules and sequence steps whose time has come; also what the scheduled task calls. */
  app.post('/crm/automations/run', manage, async (_request, reply) => {
    const result = await runCrmCycle({
      db,
      mail: crmMailOf(app.wings),
      stageStuckDays: env.CRM_STAGE_STUCK_DAYS === undefined ? 7 : Number(env.CRM_STAGE_STUCK_DAYS),
      log: () => undefined,
    });
    return reply.send(result);
  });
};
