import {
  addBusinessHours,
  BOARD_CARDS_PER_STAGE,
  LEAD_PIPELINES,
  type Board,
  type BoardCard,
  type BoardColumn,
  type CrmStage,
  type Distribution,
  type LeadChangeSource,
  type LeadNote,
  type LeadPipeline,
  type LeadStageHistoryEntry,
  type LeadTask,
  type LeadTaskKind,
  type Seller,
} from '@wings/shared';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { contactNameSql, listConditions, nextTaskSql, type LeadListFilter } from './service.js';
import {
  clients,
  crmDistributionMembers,
  crmStages,
  employees,
  leadEvents,
  leadNotes,
  leadStageHistory,
  leadTasks,
  leads,
  roles,
} from '../../db/schema/index.js';

/**
 * CRM Vendas, Fase 1: the Funil as the place of work. Stages per funnel,
 * the lead's stage/owner/outcome with an append-only history, notes, tasks
 * with the first-contact SLA, the rotation that hands new leads to sellers
 * and the kanban. Everything a person does here is recorded on the lead's
 * timeline by id; personal data stays in `leads` and in notes.
 */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Tx;

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

// --- configuration -------------------------------------------------------------------

export interface CrmConfig {
  /** Working hours a seller has to make the first contact after a lead lands on them; the auto task's due time. */
  firstContactSlaHours: number;
}

/** Eric, 05/10/2026: one working hour (Mon–Fri, 9h–18h São Paulo); CRM_FIRST_CONTACT_SLA_HOURS overrides the number. */
export const DEFAULT_FIRST_CONTACT_SLA_HOURS = 1;

let config: CrmConfig = { firstContactSlaHours: DEFAULT_FIRST_CONTACT_SLA_HOURS };

export function configureCrm(next: Partial<CrmConfig>): void {
  config = { ...config, ...next };
}

export const crmConfig = (): CrmConfig => config;

/** Runs the hook for a lead that has just entered its stage (by a move or at birth); never throws. */
export async function announceStageEntered(lead: typeof leads.$inferSelect): Promise<void> {
  if (!stageEntered) return;
  try {
    await stageEntered(lead);
  } catch {
    // The move stands; the rules' own records say what ran.
  }
}

/**
 * Called after a stage change is committed, for moves a person (or Sofia)
 * made; the automation rules of the stage start from here. A failing hook
 * never undoes or fails the move.
 */
export type StageEnteredHook = (lead: typeof leads.$inferSelect) => Promise<void>;
let stageEntered: StageEnteredHook | null = null;
export function onStageEnteredHook(hook: StageEnteredHook | null): void {
  stageEntered = hook;
}

// --- stages ----------------------------------------------------------------------------

type StageRow = typeof crmStages.$inferSelect;

export const toStage = (row: StageRow, openCount?: number): CrmStage => ({
  id: row.id,
  pipeline: row.pipeline as LeadPipeline,
  name: row.name,
  position: row.position,
  active: row.active,
  rdStageId: row.rdStageId,
  sofiaEntry: row.sofiaEntry,
  probability: row.probability,
  ...(openCount === undefined ? {} : { openCount }),
});

export async function listStages(
  db: Executor,
  input: { pipeline?: LeadPipeline; withCounts?: boolean; ownerEmployeeId?: string } = {},
): Promise<CrmStage[]> {
  const rows = await db
    .select()
    .from(crmStages)
    .where(input.pipeline ? eq(crmStages.pipeline, input.pipeline) : undefined)
    .orderBy(asc(crmStages.pipeline), asc(crmStages.position), asc(crmStages.name));
  if (!input.withCounts) return rows.map((row) => toStage(row));
  const counts = await db
    .select({ stageId: leads.stageId, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(
      and(
        isNull(leads.won),
        input.ownerEmployeeId ? eq(leads.ownerEmployeeId, input.ownerEmployeeId) : undefined,
      ),
    )
    .groupBy(leads.stageId);
  const byStage = new Map(counts.map((row) => [row.stageId, row.count]));
  return rows.map((row) => toStage(row, byStage.get(row.id) ?? 0));
}

/** Where a new lead lands in each funnel, by RD CRM's names ("Novo Contato", "Sem contato"). */
export const CRM_ENTRY_STAGES: Record<LeadPipeline, string> = {
  expansao: 'Novo Contato',
  formatacao: 'Sem contato',
  consultoria: 'Novo contato',
};

/**
 * The stage a lead born here starts in: the funnel's entry stage by name; if a
 * manager renamed or switched it off, the first active stage; and on an empty
 * list (a fresh database, as production starts) the entry stage is made, so
 * no door ever leaves a new lead without a stage. Positions alone do not
 * decide, because stages learned from RD can share a position.
 */
export async function entryStageOf(db: Executor, pipeline: LeadPipeline): Promise<StageRow> {
  const named = await db.query.crmStages.findFirst({
    where: and(
      eq(crmStages.pipeline, pipeline),
      eq(crmStages.name, CRM_ENTRY_STAGES[pipeline]),
      eq(crmStages.active, true),
    ),
  });
  if (named) return named;
  const first = await db.query.crmStages.findFirst({
    where: and(eq(crmStages.pipeline, pipeline), eq(crmStages.active, true)),
    orderBy: [asc(crmStages.position), asc(crmStages.name)],
  });
  return first ?? ensureStage(db, { pipeline, name: CRM_ENTRY_STAGES[pipeline], position: 1 });
}

/**
 * The stage row for a name RD CRM (or a person) uses, made on first sight at
 * the given position. The default list of stages is whatever RD has today;
 * nothing is invented here, only learned.
 */
export async function ensureStage(
  db: Executor,
  input: {
    pipeline: LeadPipeline;
    name: string;
    position?: number | null;
    rdStageId?: string | null;
  },
): Promise<StageRow> {
  const name = input.name.trim().slice(0, 60);
  const existing = await db.query.crmStages.findFirst({
    where: and(eq(crmStages.pipeline, input.pipeline), eq(crmStages.name, name)),
  });
  if (existing) {
    if (input.rdStageId && existing.rdStageId !== input.rdStageId) {
      const [updated] = await db
        .update(crmStages)
        .set({ rdStageId: input.rdStageId, updatedAt: new Date() })
        .where(eq(crmStages.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing;
  }
  const position =
    input.position ??
    ((
      await db
        .select({ max: sql<number>`coalesce(max(${crmStages.position}), 0)::int` })
        .from(crmStages)
        .where(eq(crmStages.pipeline, input.pipeline))
    )[0]?.max ?? 0) + 1;
  const [created] = await db
    .insert(crmStages)
    .values({ pipeline: input.pipeline, name, position, rdStageId: input.rdStageId ?? null })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // Lost the race to another writer: read theirs.
  const theirs = await db.query.crmStages.findFirst({
    where: and(eq(crmStages.pipeline, input.pipeline), eq(crmStages.name, name)),
  });
  if (!theirs) throw new Error('stage insert returned no row');
  return theirs;
}

export async function createStage(
  db: Database,
  input: { pipeline: LeadPipeline; name: string; position?: number; actorEmployeeId: string },
): Promise<CrmStage | 'exists'> {
  return db.transaction(async (tx) => {
    const existing = await tx.query.crmStages.findFirst({
      where: and(eq(crmStages.pipeline, input.pipeline), eq(crmStages.name, input.name)),
    });
    if (existing) return 'exists';
    const rows = await tx
      .select({ id: crmStages.id })
      .from(crmStages)
      .where(and(eq(crmStages.pipeline, input.pipeline), eq(crmStages.active, true)))
      .orderBy(asc(crmStages.position), asc(crmStages.name));
    const at = Math.min(Math.max((input.position ?? rows.length + 1) - 1, 0), rows.length);
    const [created] = await tx
      .insert(crmStages)
      .values({
        pipeline: input.pipeline,
        name: input.name,
        position: at + 1,
        createdBy: input.actorEmployeeId,
      })
      .returning();
    if (!created) throw new Error('stage insert returned no row');
    const order = rows.map((row) => row.id);
    order.splice(at, 0, created.id);
    await renumber(tx, order);
    return toStage({ ...created, position: at + 1 });
  });
}

async function renumber(tx: Executor, ids: readonly string[]): Promise<void> {
  for (const [index, id] of ids.entries()) {
    await tx
      .update(crmStages)
      .set({ position: index + 1, updatedAt: new Date() })
      .where(eq(crmStages.id, id));
  }
}

export async function updateStage(
  db: Database,
  id: string,
  patch: { name?: string; active?: boolean; probability?: number },
): Promise<CrmStage | null | 'exists'> {
  const row = await db.query.crmStages.findFirst({ where: eq(crmStages.id, id) });
  if (!row) return null;
  if (patch.name && patch.name !== row.name) {
    const clash = await db.query.crmStages.findFirst({
      where: and(eq(crmStages.pipeline, row.pipeline), eq(crmStages.name, patch.name)),
    });
    if (clash) return 'exists';
  }
  const [updated] = await db
    .update(crmStages)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.probability !== undefined ? { probability: patch.probability } : {}),
      updatedAt: new Date(),
    })
    .where(eq(crmStages.id, id))
    .returning();
  if (!updated) return null;
  // Leads show the stage by name too: keep them in step with a rename.
  if (patch.name !== undefined && patch.name !== row.name) {
    await db.update(leads).set({ stage: patch.name }).where(eq(leads.stageId, id));
  }
  return toStage(updated);
}

/** Puts the active stages of a funnel in the given order; every active stage must be named once. */
export async function reorderStages(
  db: Database,
  pipeline: LeadPipeline,
  ids: readonly string[],
): Promise<CrmStage[] | 'mismatch'> {
  return db.transaction(async (tx) => {
    const active = await tx
      .select({ id: crmStages.id })
      .from(crmStages)
      .where(and(eq(crmStages.pipeline, pipeline), eq(crmStages.active, true)));
    const known = new Set(active.map((row) => row.id));
    if (ids.length !== known.size || ids.some((id) => !known.has(id))) return 'mismatch';
    await renumber(tx, ids);
    for (const [index, id] of ids.entries()) {
      await tx
        .update(leads)
        .set({ stageOrder: index + 1 })
        .where(eq(leads.stageId, id));
    }
    return listStages(tx, { pipeline });
  });
}

// --- the lead's stage, owner and outcome ----------------------------------------------

export interface LeadChange {
  leadId: string;
  stageId?: string;
  pipeline?: LeadPipeline;
  /** undefined = untouched; null = no owner. */
  ownerEmployeeId?: string | null;
  /** undefined = untouched; true won, false lost, null reopened. */
  won?: boolean | null;
  lostReason?: string | null;
  source: LeadChangeSource;
  actorEmployeeId: string | null;
}

export type LeadChangeResult =
  | { ok: true; lead: typeof leads.$inferSelect; changed: string[] }
  | {
      ok: false;
      reason: 'not_found' | 'stage_not_found' | 'stage_wrong_pipeline' | 'stage_inactive';
    };

/**
 * One change, all its records: the lead's columns, a `lead_stage_history`
 * row when stage or outcome moved, a timeline event per thing that changed
 * (ids only), and `managed_by = wings` from the first change a person makes
 * here, so the RD follow-up stops overwriting. The caller checked
 * permissions; this writes.
 */
export async function changeLead(db: Database, change: LeadChange): Promise<LeadChangeResult> {
  const result = await changeLeadTx(db, change);
  if (
    result.ok &&
    result.changed.includes('stage') &&
    stageEntered &&
    (change.source === 'wings' || change.source === 'sofia')
  ) {
    await announceStageEntered(result.lead);
  }
  return result;
}

async function changeLeadTx(db: Database, change: LeadChange): Promise<LeadChangeResult> {
  return db.transaction(async (tx) => {
    const [lead] = await tx.select().from(leads).where(eq(leads.id, change.leadId)).for('update');
    if (!lead) return { ok: false, reason: 'not_found' };
    const now = new Date();
    const patch: Partial<typeof leads.$inferInsert> = { updatedAt: now };
    const changed: string[] = [];
    const events: { kind: string; detail: Record<string, unknown> }[] = [];
    let pipeline = (lead.pipeline as LeadPipeline | null) ?? null;

    if (change.pipeline && change.pipeline !== lead.pipeline) {
      pipeline = change.pipeline;
      patch.pipeline = change.pipeline;
      changed.push('pipeline');
      events.push({
        kind: 'lead.pipeline_changed',
        detail: { from: lead.pipeline, to: change.pipeline },
      });
      // A lead changing funnel leaves its stage unless the request names the new one.
      if (!change.stageId) {
        patch.stageId = null;
        patch.stage = null;
        patch.stageOrder = null;
      }
    }

    let stageMoved = false;
    if (change.stageId && change.stageId !== lead.stageId) {
      const toStageRow =
        (await tx.query.crmStages.findFirst({ where: eq(crmStages.id, change.stageId) })) ?? null;
      if (!toStageRow) return { ok: false, reason: 'stage_not_found' };
      if (!toStageRow.active) return { ok: false, reason: 'stage_inactive' };
      if (pipeline && toStageRow.pipeline !== pipeline)
        return { ok: false, reason: 'stage_wrong_pipeline' };
      if (!pipeline) {
        pipeline = toStageRow.pipeline as LeadPipeline;
        patch.pipeline = pipeline;
      }
      patch.stageId = toStageRow.id;
      patch.stage = toStageRow.name;
      patch.stageOrder = toStageRow.position;
      patch.stageChangedAt = now;
      stageMoved = true;
      changed.push('stage');
    }

    let outcomeMoved = false;
    if (change.won !== undefined && change.won !== lead.won) {
      patch.won = change.won;
      patch.closedAt = change.won === null ? null : now;
      patch.lostReason = change.won === false ? change.lostReason?.trim() || null : null;
      outcomeMoved = true;
      changed.push('outcome');
    }

    if (change.ownerEmployeeId !== undefined && change.ownerEmployeeId !== lead.ownerEmployeeId) {
      patch.ownerEmployeeId = change.ownerEmployeeId;
      changed.push('owner');
      events.push({
        kind: 'lead.owner_changed',
        detail: { from: lead.ownerEmployeeId, to: change.ownerEmployeeId, source: change.source },
      });
    }

    if (changed.length === 0) return { ok: true, lead, changed };
    if (change.source === 'wings' || change.source === 'sofia') patch.managedBy = 'wings';

    const [updated] = await tx.update(leads).set(patch).where(eq(leads.id, lead.id)).returning();
    if (!updated) throw new Error('lead update returned no row');

    if (stageMoved || outcomeMoved) {
      await tx.insert(leadStageHistory).values({
        leadId: lead.id,
        at: now,
        fromStageId: lead.stageId,
        toStageId: updated.stageId,
        fromStage: lead.stage,
        toStage: updated.stage,
        won: updated.won,
        lostReason: updated.lostReason,
        source: change.source,
        actorEmployeeId: change.actorEmployeeId,
      });
      events.push({
        kind: stageMoved ? 'lead.stage_changed' : 'lead.outcome_changed',
        detail: {
          fromStageId: lead.stageId,
          toStageId: updated.stageId,
          won: updated.won,
          hasLostReason: updated.lostReason !== null,
          source: change.source,
        },
      });
    }
    for (const event of events) {
      await tx.insert(leadEvents).values({
        leadId: lead.id,
        kind: event.kind,
        actorEmployeeId: change.actorEmployeeId,
        detail: event.detail,
      });
    }
    // A lead handed to a new owner (by a person or the rotation) gets the first-contact task.
    if (changed.includes('owner') && updated.ownerEmployeeId && updated.won === null) {
      await ensureFirstContactTask(tx, updated, change.actorEmployeeId, now);
    }
    return { ok: true, lead: updated, changed };
  });
}

export async function stageHistoryOf(
  db: Executor,
  leadId: string,
): Promise<LeadStageHistoryEntry[]> {
  const rows = await db
    .select({
      id: leadStageHistory.id,
      at: leadStageHistory.at,
      fromStage: leadStageHistory.fromStage,
      toStage: leadStageHistory.toStage,
      won: leadStageHistory.won,
      lostReason: leadStageHistory.lostReason,
      source: leadStageHistory.source,
      actorName: employees.fullName,
    })
    .from(leadStageHistory)
    .leftJoin(employees, eq(employees.id, leadStageHistory.actorEmployeeId))
    .where(eq(leadStageHistory.leadId, leadId))
    .orderBy(desc(leadStageHistory.at))
    .limit(100);
  return rows.map((row) => ({
    ...row,
    at: row.at.toISOString(),
    source: row.source as LeadChangeSource,
  }));
}

// --- notes -----------------------------------------------------------------------------

export async function addNote(
  db: Database,
  input: { leadId: string; body: string; authorEmployeeId: string | null },
): Promise<LeadNote> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(leadNotes)
      .values({ leadId: input.leadId, body: input.body, authorEmployeeId: input.authorEmployeeId })
      .returning();
    if (!row) throw new Error('note insert returned no row');
    await tx.insert(leadEvents).values({
      leadId: input.leadId,
      kind: 'lead.note_added',
      actorEmployeeId: input.authorEmployeeId,
      detail: { noteId: row.id, length: input.body.length },
    });
    const author = input.authorEmployeeId
      ? await tx.query.employees.findFirst({
          where: eq(employees.id, input.authorEmployeeId),
          columns: { fullName: true },
        })
      : null;
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      authorName: author?.fullName ?? null,
      body: row.body,
    };
  });
}

export async function notesOf(db: Executor, leadId: string): Promise<LeadNote[]> {
  const rows = await db
    .select({
      id: leadNotes.id,
      at: leadNotes.createdAt,
      body: leadNotes.body,
      authorName: employees.fullName,
    })
    .from(leadNotes)
    .leftJoin(employees, eq(employees.id, leadNotes.authorEmployeeId))
    .where(eq(leadNotes.leadId, leadId))
    .orderBy(desc(leadNotes.createdAt))
    .limit(200);
  return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
}

// --- tasks -----------------------------------------------------------------------------

const assignee = employees;

async function taskRows(db: Executor, where: ReturnType<typeof and>, limit: number) {
  const doneBy = sql<
    string | null
  >`(select full_name from employees d where d.id = ${leadTasks.doneBy})`;
  const rows = await db
    .select({
      id: leadTasks.id,
      leadId: leadTasks.leadId,
      leadName: leads.name,
      leadCompanyName: sql<
        string | null
      >`(select c.name from crm_companies c where c.id = ${leads.companyId})`,
      kind: leadTasks.kind,
      title: leadTasks.title,
      dueAt: leadTasks.dueAt,
      assigneeEmployeeId: leadTasks.assigneeEmployeeId,
      assigneeName: assignee.fullName,
      auto: leadTasks.auto,
      createdAt: leadTasks.createdAt,
      doneAt: leadTasks.doneAt,
      doneByName: doneBy,
    })
    .from(leadTasks)
    .innerJoin(leads, eq(leads.id, leadTasks.leadId))
    .leftJoin(assignee, eq(assignee.id, leadTasks.assigneeEmployeeId))
    .where(where)
    .orderBy(asc(leadTasks.doneAt), asc(leadTasks.dueAt))
    .limit(limit);
  return rows.map((row): LeadTask => ({
    ...row,
    kind: row.kind as LeadTaskKind,
    dueAt: row.dueAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    doneAt: iso(row.doneAt),
  }));
}

export const tasksOf = (db: Executor, leadId: string) =>
  taskRows(db, and(eq(leadTasks.leadId, leadId)), 200);

export async function listTasks(
  db: Executor,
  input: {
    assigneeEmployeeId?: string;
    status: 'open' | 'overdue' | 'done' | 'all';
    kind?: LeadTaskKind;
    now?: Date;
  },
): Promise<LeadTask[]> {
  const now = input.now ?? new Date();
  const conditions = [];
  if (input.assigneeEmployeeId)
    conditions.push(eq(leadTasks.assigneeEmployeeId, input.assigneeEmployeeId));
  if (input.kind) conditions.push(eq(leadTasks.kind, input.kind));
  if (input.status === 'open') conditions.push(isNull(leadTasks.doneAt));
  if (input.status === 'overdue')
    conditions.push(and(isNull(leadTasks.doneAt), lt(leadTasks.dueAt, now)));
  if (input.status === 'done') conditions.push(sql`${leadTasks.doneAt} is not null`);
  return taskRows(db, conditions.length > 0 ? and(...conditions) : undefined, 500);
}

export async function createTask(
  db: Database,
  input: {
    leadId: string;
    kind: LeadTaskKind;
    title: string;
    dueAt: Date;
    assigneeEmployeeId: string | null;
    createdBy: string | null;
    auto?: boolean;
  },
): Promise<LeadTask> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(leadTasks)
      .values({
        leadId: input.leadId,
        kind: input.kind,
        title: input.title,
        dueAt: input.dueAt,
        assigneeEmployeeId: input.assigneeEmployeeId,
        createdBy: input.createdBy,
        auto: input.auto ?? false,
      })
      .returning();
    if (!row) throw new Error('task insert returned no row');
    await tx.insert(leadEvents).values({
      leadId: input.leadId,
      kind: 'lead.task_created',
      actorEmployeeId: input.createdBy,
      detail: { taskId: row.id, kind: row.kind, auto: row.auto, dueAt: row.dueAt.toISOString() },
    });
    const [task] = await taskRows(tx, and(eq(leadTasks.id, row.id)), 1);
    if (!task) throw new Error('task not found after insert');
    return task;
  });
}

export async function updateTask(
  db: Database,
  input: {
    taskId: string;
    done?: boolean;
    dueAt?: Date;
    title?: string;
    actorEmployeeId: string | null;
  },
): Promise<LeadTask | null> {
  return db.transaction(async (tx) => {
    const row = await tx.query.leadTasks.findFirst({ where: eq(leadTasks.id, input.taskId) });
    if (!row) return null;
    const now = new Date();
    const patch: Partial<typeof leadTasks.$inferInsert> = {};
    if (input.done === true && !row.doneAt) {
      patch.doneAt = now;
      patch.doneBy = input.actorEmployeeId;
    }
    if (input.done === false && row.doneAt) {
      patch.doneAt = null;
      patch.doneBy = null;
    }
    if (input.dueAt) patch.dueAt = input.dueAt;
    if (input.title) patch.title = input.title;
    if (Object.keys(patch).length > 0) {
      await tx.update(leadTasks).set(patch).where(eq(leadTasks.id, row.id));
      await tx.insert(leadEvents).values({
        leadId: row.leadId,
        kind: input.done === true && !row.doneAt ? 'lead.task_done' : 'lead.task_updated',
        actorEmployeeId: input.actorEmployeeId,
        detail: { taskId: row.id, changed: Object.keys(patch) },
      });
    }
    const [task] = await taskRows(tx, and(eq(leadTasks.id, row.id)), 1);
    return task ?? null;
  });
}

/** The SLA task: one open "Primeiro contato" per lead, for its owner, due in `firstContactSlaHours`. */
export async function ensureFirstContactTask(
  db: Executor,
  lead: { id: string; ownerEmployeeId: string | null },
  actorEmployeeId: string | null,
  now = new Date(),
): Promise<void> {
  if (!lead.ownerEmployeeId) return;
  const open = await db.query.leadTasks.findFirst({
    where: and(
      eq(leadTasks.leadId, lead.id),
      eq(leadTasks.kind, 'first_contact'),
      isNull(leadTasks.doneAt),
    ),
  });
  if (open) {
    if (open.assigneeEmployeeId !== lead.ownerEmployeeId) {
      await db
        .update(leadTasks)
        .set({ assigneeEmployeeId: lead.ownerEmployeeId })
        .where(eq(leadTasks.id, open.id));
    }
    return;
  }
  const [row] = await db
    .insert(leadTasks)
    .values({
      leadId: lead.id,
      kind: 'first_contact',
      title: 'Primeiro contato com o lead',
      dueAt: addBusinessHours(now, config.firstContactSlaHours),
      assigneeEmployeeId: lead.ownerEmployeeId,
      auto: true,
      createdBy: actorEmployeeId,
    })
    .returning();
  if (row) {
    await db.insert(leadEvents).values({
      leadId: lead.id,
      kind: 'lead.task_created',
      actorEmployeeId,
      detail: { taskId: row.id, kind: 'first_contact', auto: true, dueAt: row.dueAt.toISOString() },
    });
  }
}

// --- distribution --------------------------------------------------------------------

/**
 * The next seller of a funnel, round-robin: the active member who waited
 * longest (never assigned first). Locks the funnel's rotation so two leads
 * arriving together go to two people. Null when the rotation is empty.
 */
export async function nextInRotation(
  tx: Executor,
  pipeline: LeadPipeline,
  now = new Date(),
): Promise<string | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`crm:rotation:${pipeline}`}))`);
  const [member] = await tx
    .select({ id: crmDistributionMembers.id, employeeId: crmDistributionMembers.employeeId })
    .from(crmDistributionMembers)
    .innerJoin(employees, eq(employees.id, crmDistributionMembers.employeeId))
    .where(
      and(
        eq(crmDistributionMembers.pipeline, pipeline),
        eq(crmDistributionMembers.active, true),
        eq(employees.status, 'active'),
      ),
    )
    .orderBy(
      sql`${crmDistributionMembers.lastAssignedAt} asc nulls first`,
      asc(crmDistributionMembers.updatedAt),
    )
    .limit(1);
  if (!member) return null;
  await tx
    .update(crmDistributionMembers)
    .set({ lastAssignedAt: now })
    .where(eq(crmDistributionMembers.id, member.id));
  return member.employeeId;
}

export async function distributionOf(db: Executor, pipeline: LeadPipeline): Promise<Distribution> {
  const rows = await db
    .select({
      employeeId: crmDistributionMembers.employeeId,
      name: employees.fullName,
      active: crmDistributionMembers.active,
      lastAssignedAt: crmDistributionMembers.lastAssignedAt,
      openLeads: sql<number>`(select count(*) from ${leads} l where l.owner_employee_id = ${crmDistributionMembers.employeeId} and l.pipeline = ${pipeline} and l.won is null)::int`,
    })
    .from(crmDistributionMembers)
    .innerJoin(employees, eq(employees.id, crmDistributionMembers.employeeId))
    .where(eq(crmDistributionMembers.pipeline, pipeline))
    .orderBy(asc(employees.fullName));
  return {
    pipeline,
    members: rows.map((row) => ({ ...row, lastAssignedAt: iso(row.lastAssignedAt) })),
  };
}

/** Replaces the rotation of a funnel with the given members (a member left out is removed; their leads stay). */
export async function setDistribution(
  db: Database,
  input: {
    pipeline: LeadPipeline;
    members: { employeeId: string; active: boolean }[];
    actorEmployeeId: string;
  },
): Promise<Distribution> {
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ employeeId: crmDistributionMembers.employeeId })
      .from(crmDistributionMembers)
      .where(eq(crmDistributionMembers.pipeline, input.pipeline));
    const wanted = new Set(input.members.map((member) => member.employeeId));
    const gone = current.map((row) => row.employeeId).filter((id) => !wanted.has(id));
    if (gone.length > 0) {
      await tx
        .delete(crmDistributionMembers)
        .where(
          and(
            eq(crmDistributionMembers.pipeline, input.pipeline),
            inArray(crmDistributionMembers.employeeId, gone),
          ),
        );
    }
    for (const member of input.members) {
      await tx
        .insert(crmDistributionMembers)
        .values({
          pipeline: input.pipeline,
          employeeId: member.employeeId,
          active: member.active,
          updatedBy: input.actorEmployeeId,
        })
        .onConflictDoUpdate({
          target: [
            crmDistributionMembers.tenantId,
            crmDistributionMembers.pipeline,
            crmDistributionMembers.employeeId,
          ],
          set: { active: member.active, updatedBy: input.actorEmployeeId, updatedAt: new Date() },
        });
    }
    return distributionOf(tx, input.pipeline);
  });
}

/**
 * The roles that may own a lead and take part in a rotation: the sellers, the
 * sales manager and Diretoria (Eric, 05/10: Thais stays Diretoria and works
 * Formatação). Admin Master is not here.
 */
export const CRM_SELLER_ROLES = [
  'vendedor_expansao',
  'vendedor_formatacao',
  'gerente_comercial',
  'diretoria',
] as const;

/** Employees who may own a lead (`CRM_SELLER_ROLES`). For the owner dropdown and the rotation screen. */
export async function listSellers(db: Executor): Promise<Seller[]> {
  const rows = await db
    .select({
      id: employees.id,
      name: employees.fullName,
      role: roles.key,
      status: employees.status,
    })
    .from(employees)
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .where(inArray(roles.key, [...CRM_SELLER_ROLES]))
    .orderBy(asc(employees.fullName));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    active: row.status === 'active',
  }));
}

// --- kanban ---------------------------------------------------------------------------

export interface BoardFilter extends LeadListFilter {
  pipeline: LeadPipeline;
}

const cardSelect = () => ({
  id: leads.id,
  name: leads.name,
  companyName: sql<
    string | null
  >`(select c.name from crm_companies c where c.id = ${leads.companyId})`,
  contactName: contactNameSql,
  email: leads.email,
  phone: leads.phone,
  valueCents: leads.valueCents,
  brand: leads.brand,
  clientName: clients.name,
  ownerEmployeeId: leads.ownerEmployeeId,
  ownerName: employees.fullName,
  stageId: leads.stageId,
  stageChangedAt: leads.stageChangedAt,
  createdAt: leads.createdAt,
  nextTask: nextTaskSql,
  source: leads.source,
  adPlatform: leads.adPlatform,
  won: leads.won,
});

type CardRow = Awaited<ReturnType<ReturnType<typeof cardQuery>['execute']>>[number];

function cardQuery(db: Executor) {
  return db
    .select(cardSelect())
    .from(leads)
    .innerJoin(clients, eq(clients.id, leads.clientId))
    .leftJoin(employees, eq(employees.id, leads.ownerEmployeeId));
}

const toCard = (row: CardRow): BoardCard => ({
  id: row.id,
  name: row.name,
  companyName: row.companyName,
  contactName: row.contactName,
  email: row.email,
  phone: row.phone,
  valueCents: row.valueCents,
  brand: row.brand,
  clientName: row.clientName,
  ownerEmployeeId: row.ownerEmployeeId,
  ownerName: row.ownerName,
  stageChangedAt: iso(row.stageChangedAt),
  nextTask: row.nextTask,
  source: (row.adPlatform === 'google' ? row.source : row.source) as BoardCard['source'],
  won: row.won,
  createdAt: row.createdAt.toISOString(),
});

/**
 * The board of one funnel under the list's filters: a column per stage with
 * its count, value and probability-weighted value, and the first page of
 * cards (`BOARD_CARDS_PER_STAGE`); `boardColumn` pages the rest. Lost deals
 * are out unless the outcome filter asks for them; the default is "open".
 */
export async function boardOf(db: Executor, filter: BoardFilter): Promise<Board> {
  const stages = await listStages(db, { pipeline: filter.pipeline });
  const outcome = filter.outcome ?? 'open';
  const where = and(
    eq(leads.pipeline, filter.pipeline),
    listConditions({ ...filter, outcome, pipeline: undefined }),
  );
  const probabilityOf = new Map(stages.map((stage) => [stage.id, stage.probability]));
  const totals = await db
    .select({
      stageId: leads.stageId,
      total: sql<number>`count(*)::int`,
      valueCents: sql<number>`coalesce(sum(${leads.valueCents}), 0)::bigint`,
    })
    .from(leads)
    .where(where)
    .groupBy(leads.stageId);
  const rows = await db
    .select({
      ...cardSelect(),
      rank: sql<number>`row_number() over (partition by ${leads.stageId} order by ${leads.stageChangedAt} desc nulls last, ${leads.createdAt} desc)`,
    })
    .from(leads)
    .innerJoin(clients, eq(clients.id, leads.clientId))
    .leftJoin(employees, eq(employees.id, leads.ownerEmployeeId))
    .where(and(where, sql`true`));
  const cards = new Map<string | null, BoardCard[]>();
  for (const row of rows) {
    if (row.rank > BOARD_CARDS_PER_STAGE) continue;
    const list = cards.get(row.stageId) ?? [];
    list.push(toCard(row));
    cards.set(row.stageId, list);
  }
  const totalOf = new Map(totals.map((row) => [row.stageId, row]));
  const column = (stage: CrmStage | null): BoardColumn => {
    const total = totalOf.get(stage?.id ?? null);
    const valueCents = Number(total?.valueCents ?? 0);
    const probability = stage ? (probabilityOf.get(stage.id) ?? 0) : 0;
    return {
      stage,
      total: total?.total ?? 0,
      valueCents,
      weightedCents: Math.round((valueCents * probability) / 100),
      cards: cards.get(stage?.id ?? null) ?? [],
    };
  };
  const columns = stages
    .filter((stage) => stage.active || (totalOf.get(stage.id)?.total ?? 0) > 0)
    .map(column);
  if ((totalOf.get(null)?.total ?? 0) > 0) columns.unshift(column(null));
  return {
    pipeline: filter.pipeline,
    columns,
    total: columns.reduce((sum, item) => sum + item.total, 0),
    valueCents: columns.reduce((sum, item) => sum + item.valueCents, 0),
    weightedCents: columns.reduce((sum, item) => sum + item.weightedCents, 0),
  };
}

/** The next page of one column's cards ("carregar mais"). */
export async function boardColumn(
  db: Executor,
  filter: BoardFilter & { stageId: string | null; offset: number },
): Promise<BoardCard[]> {
  const outcome = filter.outcome ?? 'open';
  const rows = await cardQuery(db)
    .where(
      and(
        eq(leads.pipeline, filter.pipeline),
        filter.stageId ? eq(leads.stageId, filter.stageId) : isNull(leads.stageId),
        listConditions({ ...filter, outcome, pipeline: undefined }),
      ),
    )
    .orderBy(sql`${leads.stageChangedAt} desc nulls last`, desc(leads.createdAt))
    .offset(filter.offset)
    .limit(BOARD_CARDS_PER_STAGE);
  return rows.map(toCard);
}

/** The three numbers at the top of Negociações: new deals nobody touched, today's and overdue tasks. */
export async function boardCounters(
  db: Executor,
  input: { pipeline: LeadPipeline; ownerEmployeeId?: string; now?: Date },
): Promise<{ untouched: number; today: number; overdue: number }> {
  const now = input.now ?? new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(dayStart.getUTCHours() - 3);
  const spDay = new Date(
    Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate(), 3),
  );
  const spNext = new Date(spDay.getTime() + 86_400_000);
  const scope = input.ownerEmployeeId
    ? eq(leads.ownerEmployeeId, input.ownerEmployeeId)
    : undefined;
  const [untouched] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leads)
    .where(
      and(
        eq(leads.pipeline, input.pipeline),
        isNull(leads.won),
        scope,
        sql`not exists (select 1 from lead_activities a where a.lead_id = ${leads.id})`,
        sql`not exists (select 1 from lead_notes n where n.lead_id = ${leads.id})`,
        sql`not exists (select 1 from lead_stage_history h where h.lead_id = ${leads.id} and h.source = 'wings')`,
      ),
    );
  const [tasks] = await db
    .select({
      today: sql<number>`(count(*) filter (where ${leadTasks.dueAt} >= ${spDay} and ${leadTasks.dueAt} < ${spNext}))::int`,
      overdue: sql<number>`(count(*) filter (where ${leadTasks.dueAt} < ${now}))::int`,
    })
    .from(leadTasks)
    .innerJoin(leads, eq(leads.id, leadTasks.leadId))
    .where(and(eq(leads.pipeline, input.pipeline), isNull(leadTasks.doneAt), scope));
  return {
    untouched: untouched?.count ?? 0,
    today: tasks?.today ?? 0,
    overdue: tasks?.overdue ?? 0,
  };
}

export const isPipeline = (value: unknown): value is LeadPipeline =>
  typeof value === 'string' && (LEAD_PIPELINES as readonly string[]).includes(value);

/** Leads of a funnel with a stage name but no stage row yet (after a rename elsewhere): tie them. */
export async function attachStageIds(db: Executor, pipeline: LeadPipeline): Promise<number> {
  const stages = await db.select().from(crmStages).where(eq(crmStages.pipeline, pipeline));
  let attached = 0;
  for (const stage of stages) {
    const rows = await db
      .update(leads)
      .set({ stageId: stage.id, stageOrder: stage.position })
      .where(
        and(eq(leads.pipeline, pipeline), eq(leads.stage, stage.name), or(isNull(leads.stageId))),
      )
      .returning({ id: leads.id });
    attached += rows.length;
  }
  return attached;
}
