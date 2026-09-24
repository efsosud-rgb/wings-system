import {
  PROJECT_STAGES,
  isProjectStageSlot,
  projectStatusEditableBy,
  stageEditableBy,
  type Actor,
  type ClientProject,
  type ClientProjectStage,
  type DriveDepartment,
  type ProjectStageSlot,
  type ProjectStatus,
  type ProjectStatusChange,
  type StageProgress,
} from '@wings/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import {
  clientProjectStages,
  clientProjectStatusHistory,
  clientProjects,
  clients,
  employees,
} from '../../db/schema/index.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Db = Database | Tx;

type ProjectRow = typeof clientProjects.$inferSelect;
type StageRow = typeof clientProjectStages.$inferSelect;

/**
 * A client's project, opened with the client: Em Andamento at 01, the eight
 * stages not yet started. Idempotent, so a client that somehow lacks one
 * (registered before the module, or by a script) gets it on the next sync.
 */
export async function openProjectForClient(db: Db, clientId: string): Promise<ProjectRow> {
  const existing = await db.query.clientProjects.findFirst({
    where: eq(clientProjects.clientId, clientId),
  });
  const project =
    existing ??
    (await db.insert(clientProjects).values({ clientId }).onConflictDoNothing().returning())[0] ??
    (await db.query.clientProjects.findFirst({ where: eq(clientProjects.clientId, clientId) }));
  if (!project) throw new Error('could not open the project');
  await db
    .insert(clientProjectStages)
    .values(
      PROJECT_STAGES.map((stage) => ({
        projectId: project.id,
        slot: stage.slot,
        department: stage.department,
      })),
    )
    .onConflictDoNothing();
  return project;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

const toStage = (row: StageRow, actor: Actor, updatedByName: string | null): ClientProjectStage => {
  const slot = row.slot as ProjectStageSlot;
  const department = row.department as DriveDepartment;
  return {
    slot,
    name: PROJECT_STAGES.find((stage) => stage.slot === slot)?.name ?? slot,
    department,
    progress: row.progress as StageProgress,
    note: row.note,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    updatedAt: iso(row.updatedAt),
    updatedByName,
    canEdit: stageEditableBy(actor, department),
  };
};

export interface ProjectListFilter {
  status?: ProjectStatus;
  inactive?: boolean;
  clientId?: string;
}

/** The board: one row per client, its eight stages in order. */
export async function listProjects(
  db: Db,
  actor: Actor,
  filter: ProjectListFilter = {},
): Promise<ClientProject[]> {
  const updater = alias(employees, 'updater');
  const rows = await db
    .select({
      project: clientProjects,
      client: {
        name: clients.name,
        number: clients.number,
        active: clients.active,
      },
      updatedByName: updater.fullName,
    })
    .from(clientProjects)
    .innerJoin(clients, eq(clients.id, clientProjects.clientId))
    .leftJoin(updater, eq(updater.id, clientProjects.updatedBy))
    .where(
      and(
        filter.status ? eq(clientProjects.status, filter.status) : undefined,
        filter.clientId ? eq(clientProjects.clientId, filter.clientId) : undefined,
        filter.inactive ? undefined : eq(clients.active, true),
      ),
    )
    .orderBy(asc(clients.number), asc(clients.name));
  if (rows.length === 0) return [];

  const stageUpdater = alias(employees, 'stage_updater');
  const stageRows = await db
    .select({ stage: clientProjectStages, updatedByName: stageUpdater.fullName })
    .from(clientProjectStages)
    .leftJoin(stageUpdater, eq(stageUpdater.id, clientProjectStages.updatedBy))
    .where(
      inArray(
        clientProjectStages.projectId,
        rows.map((row) => row.project.id),
      ),
    )
    .orderBy(asc(clientProjectStages.slot));
  const stagesByProject = new Map<string, ClientProjectStage[]>();
  for (const row of stageRows) {
    const list = stagesByProject.get(row.stage.projectId) ?? [];
    list.push(toStage(row.stage, actor, row.updatedByName));
    stagesByProject.set(row.stage.projectId, list);
  }

  const canManage = projectStatusEditableBy(actor);
  return rows.map((row) => ({
    id: row.project.id,
    clientId: row.project.clientId,
    clientName: row.client.name,
    clientNumber: row.client.number ?? null,
    clientActive: row.client.active,
    status: row.project.status as ProjectStatus,
    currentStage: isProjectStageSlot(row.project.currentStage) ? row.project.currentStage : '01',
    updatedAt: row.project.updatedAt.toISOString(),
    updatedByName: row.updatedByName,
    stages: stagesByProject.get(row.project.id) ?? [],
    canManage,
  }));
}

/** Newest first: what the project has been through. */
export async function statusHistory(db: Db, projectId: string): Promise<ProjectStatusChange[]> {
  const rows = await db
    .select({ change: clientProjectStatusHistory, changedByName: employees.fullName })
    .from(clientProjectStatusHistory)
    .leftJoin(employees, eq(employees.id, clientProjectStatusHistory.changedBy))
    .where(eq(clientProjectStatusHistory.projectId, projectId))
    .orderBy(desc(clientProjectStatusHistory.changedAt), desc(clientProjectStatusHistory.id));
  return rows.map((row) => ({
    id: String(row.change.id),
    fromStatus: (row.change.fromStatus as ProjectStatus | null) ?? null,
    toStatus: row.change.toStatus as ProjectStatus,
    reason: row.change.reason,
    changedAt: row.change.changedAt.toISOString(),
    changedByName: row.changedByName,
  }));
}
