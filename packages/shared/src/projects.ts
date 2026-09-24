import { z } from 'zod';
import {
  DRIVE_CLIENT_STAGES,
  DRIVE_ROLE_DEPARTMENTS,
  type DriveDepartment,
  type DriveStageSlot,
} from './drive.js';
import { grantedScope, type Actor } from './rbac/policy.js';

/**
 * Gestão → Projetos: one project per client, born with the client, walked
 * through the same eight stages the client's Drive folders have. The board,
 * the tag on the client's folder, Administração → Clientes and, later, the
 * Client Portal all read the one `/projects` API described at the end.
 *
 * Who may change what is decided by `projects.manage`: at scope `all` (Admin
 * Master, Diretoria, Processos e Projetos) the status, the current stage and
 * every stage; at scope `sector` only the progress of the stages whose
 * department the role works in (`stageEditableBy`). The API re-checks every
 * rule here; the screens only hide what these answers refuse.
 */

// ---------------------------------------------------------------------------
// Status and progress
// ---------------------------------------------------------------------------

export const PROJECT_STATUSES = ['em_andamento', 'parado', 'cancelado', 'finalizado'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  em_andamento: 'Em Andamento',
  parado: 'Parado',
  cancelado: 'Cancelado',
  finalizado: 'Finalizado',
};

/** Parado and Cancelado always say why: the history table enforces it too. */
export const projectStatusRequiresReason = (status: ProjectStatus) =>
  status === 'parado' || status === 'cancelado';

/** A closed project keeps its stages as they are until it is reopened. */
export const projectIsClosed = (status: ProjectStatus) =>
  status === 'cancelado' || status === 'finalizado';

export const STAGE_PROGRESSES = ['nao_iniciada', 'em_andamento', 'concluida', 'bloqueada'] as const;
export type StageProgress = (typeof STAGE_PROGRESSES)[number];

export const STAGE_PROGRESS_LABELS: Record<StageProgress, string> = {
  nao_iniciada: 'Não iniciada',
  em_andamento: 'Em andamento',
  concluida: 'Concluída',
  bloqueada: 'Bloqueada',
};

export const PROJECT_REASON_MAX = 500;
export const PROJECT_NOTE_MAX = 500;

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** The eight stages, in order, with the department that works each one. */
export const PROJECT_STAGES = DRIVE_CLIENT_STAGES;
export type ProjectStageSlot = DriveStageSlot;
export const PROJECT_STAGE_SLOTS = PROJECT_STAGES.map((stage) => stage.slot) as [
  ProjectStageSlot,
  ...ProjectStageSlot[],
];

export function projectStageOf(slot: string) {
  return PROJECT_STAGES.find((stage) => stage.slot === slot) ?? null;
}

export const isProjectStageSlot = (value: string): value is ProjectStageSlot =>
  PROJECT_STAGE_SLOTS.includes(value as ProjectStageSlot);

/**
 * Whether `actor` may set the progress of a stage of `department`. One rule
 * for the board and the API: `projects.manage` at `all` reaches every stage;
 * at `sector`, the stages of the departments the role works in (the same
 * list the Drive writes by), so Financeiro edits 04, Jurídico 06, Comercial
 * 07 and Marketing 08. 01–03 and 05 belong to Processos e Projetos, which
 * holds `all`.
 */
export function stageEditableBy(actor: Actor, department: DriveDepartment): boolean {
  const scope = grantedScope(actor, 'projects.manage');
  if (scope === 'all') return true;
  if (scope !== 'sector') return false;
  return (DRIVE_ROLE_DEPARTMENTS[actor.role] ?? []).includes(department);
}

/** Status and current stage: only the `all` holders. */
export const projectStatusEditableBy = (actor: Actor) =>
  grantedScope(actor, 'projects.manage') === 'all';

/** The next stage after `current` that is not concluded, or null when none is left. */
export function nextOpenStage(
  current: ProjectStageSlot,
  progress: Partial<Record<ProjectStageSlot, StageProgress>>,
): ProjectStageSlot | null {
  const lookup = (slot: ProjectStageSlot) => progress[slot];
  const from = PROJECT_STAGE_SLOTS.indexOf(current);
  for (const slot of PROJECT_STAGE_SLOTS.slice(from + 1)) {
    if (lookup(slot) !== 'concluida') return slot;
  }
  return null;
}

// ---------------------------------------------------------------------------
// What the API answers
// ---------------------------------------------------------------------------

export interface ClientProjectStage {
  slot: ProjectStageSlot;
  name: string;
  department: DriveDepartment;
  progress: StageProgress;
  note: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  /** Whether the person asking may set this stage's progress. */
  canEdit: boolean;
}

export interface ClientProject {
  id: string;
  clientId: string;
  clientName: string;
  clientNumber: number | null;
  clientActive: boolean;
  status: ProjectStatus;
  currentStage: ProjectStageSlot;
  updatedAt: string;
  updatedByName: string | null;
  stages: ClientProjectStage[];
  /** Whether the person asking may change the status and the current stage. */
  canManage: boolean;
}

export interface ProjectStatusChange {
  id: string;
  fromStatus: ProjectStatus | null;
  toStatus: ProjectStatus;
  reason: string | null;
  changedAt: string;
  changedByName: string | null;
}

// ---------------------------------------------------------------------------
// What the API takes
// ---------------------------------------------------------------------------

const reasonSchema = z
  .string()
  .trim()
  .max(PROJECT_REASON_MAX, `No máximo ${PROJECT_REASON_MAX} caracteres`);

export const projectStatusChangeSchema = z
  .object({
    status: z.enum(PROJECT_STATUSES, { error: 'Escolha um status' }),
    reason: reasonSchema.optional(),
  })
  .superRefine((body, context) => {
    if (projectStatusRequiresReason(body.status) && !body.reason) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `Informe o motivo para marcar como ${PROJECT_STATUS_LABELS[body.status]}`,
      });
    }
  });
export type ProjectStatusChangeInput = z.output<typeof projectStatusChangeSchema>;

export const projectCurrentStageSchema = z.object({
  stage: z.enum(PROJECT_STAGE_SLOTS, { error: 'Escolha uma etapa' }),
});

export const projectStageUpdateSchema = z
  .object({
    progress: z.enum(STAGE_PROGRESSES, { error: 'Escolha o andamento' }),
    note: z
      .string()
      .trim()
      .max(PROJECT_NOTE_MAX, `No máximo ${PROJECT_NOTE_MAX} caracteres`)
      .optional(),
  })
  .superRefine((body, context) => {
    if (body.progress === 'bloqueada' && !body.note) {
      context.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'Diga o que bloqueia a etapa',
      });
    }
  });
export type ProjectStageUpdateInput = z.output<typeof projectStageUpdateSchema>;

export const projectListQuerySchema = z.object({
  status: z.enum(PROJECT_STATUSES).optional(),
  /** Inactive clients keep their project but leave the board unless asked for. */
  inactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const PROJECT_REFUSALS = {
  not_found: 'Projeto não encontrado.',
  same_status: 'O projeto já está neste status.',
  project_closed:
    'O projeto está finalizado ou cancelado. Volte-o para Em Andamento antes de mexer nas etapas.',
  stage_forbidden: 'Esta etapa é de outro departamento.',
} as const;
export type ProjectRefusal = keyof typeof PROJECT_REFUSALS;

//   GET   /projects?status=&inactive=true        -> { projects: ClientProject[] }        projects.read
//   GET   /projects/:clientId                    -> { project, history: ProjectStatusChange[] }
//   PATCH /projects/:clientId/status             { status, reason? }   projects.manage at `all`; reason required for parado/cancelado
//   PATCH /projects/:clientId/current-stage      { stage }             projects.manage at `all`; 409 project_closed
//   PATCH /projects/:clientId/stages/:slot       { progress, note? }   projects.manage; `sector` only in the role's departments; 409 project_closed
//   Every change is on the audit trail; status changes also fill `client_project_status_history`, append-only.
