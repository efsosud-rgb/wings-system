import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { employees } from './employees.js';
import { leads } from './leads.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * CRM Vendas, the Funil as the place of work (Fase 1 of
 * /root/relatorios/plano-crm-sofia-2026-10-05.md). The Wings System is the
 * official CRM since 05/10/2026; RD CRM gets a copy while the transition
 * lasts. Nothing here holds a name, an e-mail or a phone: that stays in
 * `leads`; notes are the one free text, and they belong to the lead's page.
 */

/**
 * The stages of a funnel, one list per pipeline. The defaults are RD CRM's
 * own stages, learned from the deals the import and the hourly follow-up read
 * (`ensureStage`); a manager renames, reorders, adds or retires them in
 * Administração → CRM. `rd_stage_id` keeps the copy to RD possible.
 */
export const crmStages = pgTable(
  'crm_stages',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** A LeadPipeline. */
    pipeline: text('pipeline').notNull(),
    name: text('name').notNull(),
    /** 1-based; unique among the active stages of a pipeline in practice, re-numbered on every reorder. */
    position: integer('position').notNull(),
    active: boolean('active').notNull().default(true),
    rdStageId: text('rd_stage_id'),
    /** Sofia's entry stage (Fase 4): a lead there is hers until she hands it over. */
    sofiaEntry: boolean('sofia_entry').notNull().default(false),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('crm_stages_pipeline_name_uq').on(table.tenantId, table.pipeline, table.name),
    index('crm_stages_pipeline_position_idx').on(table.pipeline, table.position),
  ],
);

/**
 * Append-only: every change of stage or outcome of a lead, by whom and from
 * where (a person in the Wings System, the RD mirror, the importer, Sofia).
 * Stage names are copied so the history reads the same after a rename.
 */
export const leadStageHistory = pgTable(
  'lead_stage_history',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    fromStageId: uuid('from_stage_id').references(() => crmStages.id),
    toStageId: uuid('to_stage_id').references(() => crmStages.id),
    fromStage: text('from_stage'),
    toStage: text('to_stage'),
    /** Outcome after the change: true won, false lost, null open. */
    won: boolean('won'),
    lostReason: text('lost_reason'),
    /** A LeadChangeSource: wings | rd | import | sofia. */
    source: text('source').notNull(),
    actorEmployeeId: uuid('actor_employee_id').references(() => employees.id),
  },
  (table) => [index('lead_stage_history_lead_idx').on(table.leadId, table.at)],
);

/** Append-only notes a person writes on a lead. The one free text of the CRM; shown only on the lead's page. */
export const leadNotes = pgTable(
  'lead_notes',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    authorEmployeeId: uuid('author_employee_id').references(() => employees.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('lead_notes_lead_idx').on(table.leadId, table.createdAt)],
);

/**
 * Follow-up tasks on a lead. `auto` ones are made by the system (the
 * first-contact SLA when a lead gets an owner); done ones keep who and when.
 */
export const leadTasks = pgTable(
  'lead_tasks',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    /** A LeadTaskKind. */
    kind: text('kind').notNull().default('follow_up'),
    title: text('title').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    assigneeEmployeeId: uuid('assignee_employee_id').references(() => employees.id),
    auto: boolean('auto').notNull().default(false),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
    doneBy: uuid('done_by').references(() => employees.id),
  },
  (table) => [
    index('lead_tasks_lead_idx').on(table.leadId, table.dueAt),
    index('lead_tasks_assignee_due_idx').on(table.assigneeEmployeeId, table.doneAt, table.dueAt),
  ],
);

/**
 * The rotation of a funnel: who takes the next lead that arrives with no
 * owner. Round-robin by `last_assigned_at` (the member who waited longest);
 * a paused member keeps their leads and takes no new one. Seeded from
 * `rd_user_map` (our RD users linked to employees), never from invented names.
 */
export const crmDistributionMembers = pgTable(
  'crm_distribution_members',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** A LeadPipeline. */
    pipeline: text('pipeline').notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    active: boolean('active').notNull().default(true),
    lastAssignedAt: timestamp('last_assigned_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => employees.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('crm_distribution_members_uq').on(table.tenantId, table.pipeline, table.employeeId),
  ],
);
