import {
  PROJECT_REFUSALS,
  isProjectStageSlot,
  nextOpenStage,
  projectCurrentStageSchema,
  projectIsClosed,
  projectListQuerySchema,
  projectStageUpdateSchema,
  projectStatusChangeSchema,
  projectStatusEditableBy,
  stageEditableBy,
  type DriveDepartment,
  type ProjectRefusal,
  type ProjectStageSlot,
  type StageProgress,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  clientProjectStages,
  clientProjectStatusHistory,
  clientProjects,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { listProjects, statusHistory, type Tx } from './service.js';

const clientParam = z.object({ clientId: z.uuid() });
const stageParam = clientParam.extend({ slot: z.string() });

const refuse = (reply: FastifyReply, status: number, error: ProjectRefusal) =>
  reply.status(status).send({ error, message: PROJECT_REFUSALS[error] });

const invalid = (reply: FastifyReply, message?: string) =>
  reply.status(400).send({ error: 'invalid_request', message: message ?? 'Dados inválidos' });

/** The project's row, locked for the rest of the transaction. */
async function lockProject(tx: Tx, clientId: string) {
  const [row] = await tx
    .select()
    .from(clientProjects)
    .where(eq(clientProjects.clientId, clientId))
    .for('update');
  return row ?? null;
}

/**
 * Gestão → Projetos. The one API the board, the tag on the client's Drive
 * folder, Formatação → Clientes and later the Client Portal read. Every
 * change is re-checked here against the rules of `@wings/shared` and written
 * to the audit log; a status change also goes to the append-only history.
 */
export const projectRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.wings;

  const oneProject = async (clientId: string, actor: Parameters<typeof listProjects>[1]) =>
    (await listProjects(db, actor, { clientId, inactive: true, hidden: true }))[0] ?? null;

  app.get(
    '/projects',
    { preHandler: app.requirePermission('projects.read') },
    async (request, reply) => {
      const query = projectListQuerySchema.safeParse(request.query ?? {});
      if (!query.success) return invalid(reply, query.error.issues[0]?.message);
      return reply.send({ projects: await listProjects(db, request.session.actor, query.data) });
    },
  );

  app.get(
    '/projects/:clientId',
    { preHandler: app.requirePermission('projects.read') },
    async (request, reply) => {
      const params = clientParam.safeParse(request.params);
      if (!params.success) return invalid(reply);
      const project = await oneProject(params.data.clientId, request.session.actor);
      if (!project) return refuse(reply, 404, 'not_found');
      return reply.send({ project, history: await statusHistory(db, project.id) });
    },
  );

  app.patch(
    '/projects/:clientId/status',
    { preHandler: app.requirePermission('projects.manage') },
    async (request, reply) => {
      const params = clientParam.safeParse(request.params);
      const body = projectStatusChangeSchema.safeParse(request.body);
      if (!params.success) return invalid(reply);
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);
      const { actor } = request.session;
      if (!projectStatusEditableBy(actor)) {
        return reply.status(403).send({ error: 'forbidden', message: 'Acesso negado' });
      }
      const outcome = await db.transaction(async (tx) => {
        const project = await lockProject(tx, params.data.clientId);
        if (!project) return 'not_found' as const;
        if (project.status === body.data.status) return 'same_status' as const;
        const now = new Date();
        await tx
          .update(clientProjects)
          .set({ status: body.data.status, updatedBy: actor.employeeId, updatedAt: now })
          .where(eq(clientProjects.id, project.id));
        await tx.insert(clientProjectStatusHistory).values({
          projectId: project.id,
          fromStatus: project.status,
          toStatus: body.data.status,
          reason: body.data.reason || null,
          changedBy: actor.employeeId,
          changedAt: now,
        });
        await writeAudit(tx, {
          actorEmployeeId: actor.employeeId,
          action: 'project.status_changed',
          entity: 'client_project',
          entityId: project.id,
          ip: request.ip,
          metadata: {
            clientId: project.clientId,
            from: project.status,
            to: body.data.status,
            withReason: Boolean(body.data.reason),
          },
        });
        return 'ok' as const;
      });
      if (outcome === 'not_found') return refuse(reply, 404, 'not_found');
      if (outcome === 'same_status') return refuse(reply, 409, 'same_status');
      return reply.send({ project: await oneProject(params.data.clientId, actor) });
    },
  );

  app.patch(
    '/projects/:clientId/current-stage',
    { preHandler: app.requirePermission('projects.manage') },
    async (request, reply) => {
      const params = clientParam.safeParse(request.params);
      const body = projectCurrentStageSchema.safeParse(request.body);
      if (!params.success) return invalid(reply);
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);
      const { actor } = request.session;
      if (!projectStatusEditableBy(actor)) {
        return reply.status(403).send({ error: 'forbidden', message: 'Acesso negado' });
      }
      const outcome = await db.transaction(async (tx) => {
        const project = await lockProject(tx, params.data.clientId);
        if (!project) return 'not_found' as const;
        if (projectIsClosed(project.status)) return 'project_closed' as const;
        if (project.currentStage === body.data.stage) return 'ok' as const;
        await tx
          .update(clientProjects)
          .set({
            currentStage: body.data.stage,
            updatedBy: actor.employeeId,
            updatedAt: new Date(),
          })
          .where(eq(clientProjects.id, project.id));
        await writeAudit(tx, {
          actorEmployeeId: actor.employeeId,
          action: 'project.current_stage_changed',
          entity: 'client_project',
          entityId: project.id,
          ip: request.ip,
          metadata: {
            clientId: project.clientId,
            from: project.currentStage,
            to: body.data.stage,
            auto: false,
          },
        });
        return 'ok' as const;
      });
      if (outcome === 'not_found') return refuse(reply, 404, 'not_found');
      if (outcome === 'project_closed') return refuse(reply, 409, 'project_closed');
      return reply.send({ project: await oneProject(params.data.clientId, actor) });
    },
  );

  app.patch(
    '/projects/:clientId/stages/:slot',
    { preHandler: app.requirePermission('projects.manage') },
    async (request, reply) => {
      const params = stageParam.safeParse(request.params);
      const body = projectStageUpdateSchema.safeParse(request.body);
      if (!params.success) return invalid(reply);
      if (!isProjectStageSlot(params.data.slot)) return refuse(reply, 404, 'not_found');
      if (!body.success) return invalid(reply, body.error.issues[0]?.message);
      const { actor } = request.session;
      const slot: ProjectStageSlot = params.data.slot;
      const outcome = await db.transaction(async (tx) => {
        const project = await lockProject(tx, params.data.clientId);
        if (!project) return 'not_found' as const;
        const [stage] = await tx
          .select()
          .from(clientProjectStages)
          .where(
            and(eq(clientProjectStages.projectId, project.id), eq(clientProjectStages.slot, slot)),
          );
        if (!stage) return 'not_found' as const;
        // The department rule before the closed rule: a refusal never tells
        // another department more than "not yours".
        if (!stageEditableBy(actor, stage.department as DriveDepartment)) {
          return 'stage_forbidden' as const;
        }
        if (projectIsClosed(project.status)) return 'project_closed' as const;

        const now = new Date();
        const previous = stage.progress as StageProgress;
        const next = body.data.progress;
        await tx
          .update(clientProjectStages)
          .set({
            progress: next,
            note: body.data.note || null,
            startedAt: stage.startedAt ?? (next === 'nao_iniciada' ? null : now),
            completedAt: next === 'concluida' ? (stage.completedAt ?? now) : null,
            updatedBy: actor.employeeId,
            updatedAt: now,
          })
          .where(eq(clientProjectStages.id, stage.id));
        await writeAudit(tx, {
          actorEmployeeId: actor.employeeId,
          action: 'project.stage_changed',
          entity: 'client_project',
          entityId: project.id,
          ip: request.ip,
          metadata: {
            clientId: project.clientId,
            slot,
            from: previous,
            to: next,
            withNote: Boolean(body.data.note),
          },
        });

        // Concluding the current stage moves the client to the next open one.
        let currentStage = project.currentStage;
        if (next === 'concluida' && slot === project.currentStage) {
          const rows = await tx
            .select({ slot: clientProjectStages.slot, progress: clientProjectStages.progress })
            .from(clientProjectStages)
            .where(eq(clientProjectStages.projectId, project.id));
          const progress = Object.fromEntries(rows.map((row) => [row.slot, row.progress]));
          const advanced = nextOpenStage(slot, progress);
          if (advanced) {
            currentStage = advanced;
            await writeAudit(tx, {
              actorEmployeeId: actor.employeeId,
              action: 'project.current_stage_changed',
              entity: 'client_project',
              entityId: project.id,
              ip: request.ip,
              metadata: { clientId: project.clientId, from: slot, to: advanced, auto: true },
            });
          }
        }
        await tx
          .update(clientProjects)
          .set({ currentStage, updatedBy: actor.employeeId, updatedAt: now })
          .where(eq(clientProjects.id, project.id));
        return 'ok' as const;
      });
      if (outcome === 'not_found') return refuse(reply, 404, 'not_found');
      if (outcome === 'stage_forbidden') return refuse(reply, 403, 'stage_forbidden');
      if (outcome === 'project_closed') return refuse(reply, 409, 'project_closed');
      return reply.send({ project: await oneProject(params.data.clientId, actor) });
    },
  );
};
