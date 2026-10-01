import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { clients } from './clients.js';
import { employees } from './employees.js';

/**
 * Gestão → Projetos. One project per client, opened with the client, walked
 * through the eight stages its Drive folders have (`PROJECT_STAGES`). Who may
 * change what is decided in `@wings/shared` (`stageEditableBy`) and re-checked
 * by the API; every change goes to the audit log, and every status change to
 * the append-only history below.
 */

export const clientProjectStatusEnum = pgEnum('client_project_status', [
  'em_andamento',
  'parado',
  'cancelado',
  'finalizado',
]);

export const clientProjectStageProgressEnum = pgEnum('client_project_stage_progress', [
  'nao_iniciada',
  'em_andamento',
  'concluida',
  'bloqueada',
]);

export const clientProjects = pgTable(
  'client_projects',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .default(WINGS_TENANT_ID)
      .references(() => tenants.id),
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    status: clientProjectStatusEnum('status').notNull().default('em_andamento'),
    /** `01`…`08`: the stage the client is at, set by hand or advanced when the current one concludes. */
    currentStage: text('current_stage').notNull().default('01'),
    updatedBy: uuid('updated_by').references(() => employees.id),
    /** Off the board, kept (B5: brands moved to Expansão). Never deleted. */
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('client_projects_client_idx').on(table.clientId),
    index('client_projects_status_idx').on(table.status),
  ],
);

export const clientProjectStages = pgTable(
  'client_project_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => clientProjects.id, { onDelete: 'cascade' }),
    /** `01`…`08`, the same slots as the client's Drive folders. */
    slot: text('slot').notNull(),
    /** The `DriveDepartment` that works this stage; decides who may set its progress. */
    department: text('department').notNull(),
    progress: clientProjectStageProgressEnum('progress').notNull().default('nao_iniciada'),
    /** Free text: what blocks the stage (required when blocked), or anything worth leaving. */
    note: text('note'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => employees.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('client_project_stages_project_slot_idx').on(table.projectId, table.slot),
  ],
);

/**
 * Append-only: every status change, with who, when and why. Parado and
 * Cancelado carry a reason by constraint, not only by validation.
 */
export const clientProjectStatusHistory = pgTable(
  'client_project_status_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => clientProjects.id, { onDelete: 'cascade' }),
    fromStatus: clientProjectStatusEnum('from_status'),
    toStatus: clientProjectStatusEnum('to_status').notNull(),
    reason: text('reason'),
    changedBy: uuid('changed_by').references(() => employees.id, { onDelete: 'restrict' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('client_project_status_history_project_idx').on(table.projectId),
    check(
      'client_project_status_history_reason_check',
      sql`${table.toStatus} not in ('parado', 'cancelado') or length(btrim(coalesce(${table.reason}, ''))) > 0`,
    ),
  ],
);
