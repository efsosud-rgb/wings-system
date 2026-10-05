import { z } from 'zod';
import { LEAD_PIPELINES, type LeadPipeline } from './leads.js';

/**
 * CRM Vendas — the Funil as the team's place of work (plano
 * /root/relatorios/plano-crm-sofia-2026-10-05.md, Fase 1). Wings System is
 * the official CRM; RD Station CRM receives a copy during the transition.
 *
 * Stages are configurable per funnel (`crm_stages`): the default set is
 * whatever RD CRM has today, learned from the deals the import and the hourly
 * follow-up read, never invented here. Every stage or outcome change is a
 * `lead_stage_history` row (append-only); every owner change, note and task is
 * on the lead's timeline. Personal data lives only in `leads`.
 */

// --- stages ---------------------------------------------------------------------

export interface CrmStage {
  id: string;
  pipeline: LeadPipeline;
  name: string;
  /** 1-based position inside the funnel. */
  position: number;
  /** A retired stage keeps its leads and its history but takes no new ones. */
  active: boolean;
  /** The RD CRM stage this one mirrors, when known (for the copy to RD). */
  rdStageId: string | null;
  /** Sofia's pre-qualification entry stage (Fase 4); false until Sofia is ready. */
  sofiaEntry: boolean;
  /** Open leads in the stage, when the caller asked for counts. */
  openCount?: number;
}

export const CRM_STAGE_NAME_MAX = 60;

export const crmStageCreateSchema = z.object({
  pipeline: z.enum(LEAD_PIPELINES),
  name: z.string().trim().min(2, 'Informe o nome da etapa').max(CRM_STAGE_NAME_MAX),
  /** Insert here (1-based); omitted puts it last. */
  position: z.number().int().min(1).optional(),
});
export type CrmStageCreateInput = z.infer<typeof crmStageCreateSchema>;

export const crmStageUpdateSchema = z
  .object({
    name: z.string().trim().min(2, 'Informe o nome da etapa').max(CRM_STAGE_NAME_MAX).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.active !== undefined, {
    message: 'Nada para alterar.',
  });
export type CrmStageUpdateInput = z.infer<typeof crmStageUpdateSchema>;

/** The whole order of a funnel's stages, every active stage once. */
export const crmStageOrderSchema = z.object({
  pipeline: z.enum(LEAD_PIPELINES),
  ids: z.array(z.uuid()).min(1).max(50),
});
export type CrmStageOrderInput = z.infer<typeof crmStageOrderSchema>;

// --- the lead's work ----------------------------------------------------------------

/** Who or what moved the lead: a person in the Wings System, RD CRM (mirror), the importer or Sofia. */
export const LEAD_CHANGE_SOURCES = ['wings', 'rd', 'import', 'sofia'] as const;
export type LeadChangeSource = (typeof LEAD_CHANGE_SOURCES)[number];

export interface LeadStageHistoryEntry {
  id: string;
  at: string;
  fromStage: string | null;
  toStage: string | null;
  /** The outcome after the change: true won, false lost, null open. */
  won: boolean | null;
  lostReason: string | null;
  source: LeadChangeSource;
  actorName: string | null;
}

export const LEAD_LOST_REASON_MAX = 200;

/**
 * One request, several things a seller does on a lead: move it, close it,
 * reopen it, hand it to someone else, fix its funnel. The API checks each part
 * against the caller's permissions (`leads.write` own/all for stage and
 * outcome; `leads.assign` for the owner).
 */
export const leadUpdateSchema = z
  .object({
    stageId: z.uuid().optional(),
    pipeline: z.enum(LEAD_PIPELINES).optional(),
    /** An employee id, or null to leave the lead with no owner. */
    ownerEmployeeId: z.uuid().nullable().optional(),
    /** true = won, false = lost (with `lostReason`), null = reopen. */
    won: z.boolean().nullable().optional(),
    lostReason: z.string().trim().max(LEAD_LOST_REASON_MAX).optional(),
  })
  .refine(
    (value) =>
      value.stageId !== undefined ||
      value.pipeline !== undefined ||
      value.ownerEmployeeId !== undefined ||
      value.won !== undefined,
    { message: 'Nada para alterar.' },
  )
  .refine((value) => value.won !== false || (value.lostReason?.length ?? 0) >= 2, {
    message: 'Informe o motivo da perda.',
  });
export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;

// --- notes -----------------------------------------------------------------------------

export const LEAD_NOTE_MAX = 4000;

export interface LeadNote {
  id: string;
  at: string;
  authorName: string | null;
  body: string;
}

export const leadNoteCreateSchema = z.object({
  body: z.string().trim().min(1, 'Escreva a anotação').max(LEAD_NOTE_MAX),
});
export type LeadNoteCreateInput = z.infer<typeof leadNoteCreateSchema>;

// --- tasks -----------------------------------------------------------------------------

export const LEAD_TASK_KINDS = ['first_contact', 'follow_up', 'call', 'meeting', 'other'] as const;
export type LeadTaskKind = (typeof LEAD_TASK_KINDS)[number];
export const LEAD_TASK_KIND_LABELS: Record<LeadTaskKind, string> = {
  first_contact: 'Primeiro contato',
  follow_up: 'Follow-up',
  call: 'Ligação',
  meeting: 'Reunião',
  other: 'Outra',
};

export const LEAD_TASK_TITLE_MAX = 160;

export interface LeadTask {
  id: string;
  leadId: string;
  /** For the task list: who the lead is (as the list already shows it). */
  leadName: string | null;
  kind: LeadTaskKind;
  title: string;
  dueAt: string;
  assigneeEmployeeId: string | null;
  assigneeName: string | null;
  /** Made by the system (the first-contact SLA), not by a person. */
  auto: boolean;
  createdAt: string;
  doneAt: string | null;
  doneByName: string | null;
}

export const leadTaskCreateSchema = z.object({
  kind: z.enum(LEAD_TASK_KINDS).default('follow_up'),
  title: z.string().trim().min(2, 'Informe a tarefa').max(LEAD_TASK_TITLE_MAX),
  dueAt: z.iso.datetime({ offset: true }),
  /** Defaults to the lead's owner, else the caller. */
  assigneeEmployeeId: z.uuid().optional(),
});
export type LeadTaskCreateInput = z.infer<typeof leadTaskCreateSchema>;

export const leadTaskUpdateSchema = z
  .object({
    done: z.boolean().optional(),
    dueAt: z.iso.datetime({ offset: true }).optional(),
    title: z.string().trim().min(2).max(LEAD_TASK_TITLE_MAX).optional(),
  })
  .refine(
    (value) => value.done !== undefined || value.dueAt !== undefined || value.title !== undefined,
    { message: 'Nada para alterar.' },
  );
export type LeadTaskUpdateInput = z.infer<typeof leadTaskUpdateSchema>;

export const taskListQuerySchema = z.object({
  /** `open` (default), `overdue`, `done` or `all`. */
  status: z.enum(['open', 'overdue', 'done', 'all']).default('open'),
  /** Only with a scope wider than own: every seller's tasks. */
  everyone: z.coerce.boolean().optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/** When a task is late: its due time has passed and it is not done. */
export const isTaskOverdue = (task: Pick<LeadTask, 'dueAt' | 'doneAt'>, now = Date.now()) =>
  task.doneAt === null && new Date(task.dueAt).getTime() < now;

// --- distribution -------------------------------------------------------------------

/**
 * The rotation of a funnel: the sellers who take new leads in turn. A new lead
 * with a funnel and no owner goes to the member who waited longest
 * (round-robin); a paused member keeps their leads and takes no new one.
 */
export interface DistributionMember {
  employeeId: string;
  name: string;
  active: boolean;
  lastAssignedAt: string | null;
  /** Open leads the member owns, for the manager to see the load. */
  openLeads: number;
}

export interface Distribution {
  pipeline: LeadPipeline;
  members: DistributionMember[];
}

export const distributionUpdateSchema = z.object({
  pipeline: z.enum(LEAD_PIPELINES),
  members: z
    .array(z.object({ employeeId: z.uuid(), active: z.boolean() }))
    .max(50)
    .refine((list) => new Set(list.map((item) => item.employeeId)).size === list.length, {
      message: 'Um vendedor aparece duas vezes.',
    }),
});
export type DistributionUpdateInput = z.infer<typeof distributionUpdateSchema>;

/** An employee who may own leads (the owner dropdown and the rotation). */
export interface Seller {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

// --- kanban ---------------------------------------------------------------------------

export const BOARD_CARDS_PER_STAGE = 60;

export interface BoardCard {
  id: string;
  name: string | null;
  brand: string | null;
  clientName: string;
  ownerName: string | null;
  stageChangedAt: string | null;
  /** The next open task's due time, when there is one. */
  nextTaskDueAt: string | null;
  createdAt: string;
}

export interface BoardColumn {
  /** Null for the leads of the funnel that have no stage yet. */
  stage: CrmStage | null;
  total: number;
  cards: BoardCard[];
}

export interface Board {
  pipeline: LeadPipeline;
  columns: BoardColumn[];
}

export const boardQuerySchema = z.object({
  pipeline: z.enum(LEAD_PIPELINES),
  owner: z.string().max(60).optional(),
  clientId: z.uuid().optional(),
});
