import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { crmStages } from './crm.js';
import { employees } from './employees.js';
import { leads } from './leads.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * CRM Vendas → Regras de automação. Nothing here holds a name, an e-mail or
 * a phone: rules and steps name people, templates and sequences by id; the
 * e-mail text is a template with `{{variables}}`, filled at send time.
 */

/** One action that runs when a deal enters a stage (optionally after a delay). */
export const crmAutomationRules = pgTable(
  'crm_automation_rules',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    pipeline: text('pipeline').notNull(),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => crmStages.id),
    position: integer('position').notNull().default(1),
    /** An AutomationRuleKind. */
    kind: text('kind').notNull(),
    config: jsonb('config').notNull().default({}),
    delayMinutes: integer('delay_minutes').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('crm_automation_rules_stage_idx').on(table.stageId, table.position)],
);

export const crmSequences = pgTable(
  'crm_sequences',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('crm_sequences_name_uq').on(table.tenantId, table.name)],
);

export const crmSequenceSteps = pgTable(
  'crm_sequence_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sequenceId: uuid('sequence_id')
      .notNull()
      .references(() => crmSequences.id, { onDelete: 'cascade' }),
    /** 1-based. */
    position: integer('position').notNull(),
    /** A SequenceStepKind. */
    kind: text('kind').notNull(),
    /** Hours after the previous step (the first: after the sequence starts). */
    afterHours: integer('after_hours').notNull().default(0),
    config: jsonb('config').notNull().default({}),
    /** Replaced by an edit but still owed to deals already in the sequence; never shown in the list. */
    retired: boolean('retired').notNull().default(false),
  },
  (table) => [
    uniqueIndex('crm_sequence_steps_pos_uq')
      .on(table.sequenceId, table.position)
      .where(sql`${table.retired} = false`),
  ],
);

export const crmEmailTemplates = pgTable(
  'crm_email_templates',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('crm_email_templates_name_uq').on(table.tenantId, table.name)],
);

/**
 * What an automation owes a lead: one row per action still to run (or run).
 * `dedupe_key` makes a re-delivered stage entry a no-op; a deal that leaves
 * the stage (or closes) cancels what is still pending for that entry.
 */
export const crmAutomationRuns = pgTable(
  'crm_automation_runs',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    ruleId: uuid('rule_id').references(() => crmAutomationRules.id),
    sequenceId: uuid('sequence_id').references(() => crmSequences.id),
    stepId: uuid('step_id').references(() => crmSequenceSteps.id),
    /** The stage whose entry started this; leaving it cancels the pending rows. */
    stageId: uuid('stage_id').references(() => crmStages.id),
    /** A rule kind or a sequence step kind, copied so history reads the same after an edit. */
    kind: text('kind').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    /** pending | done | skipped | failed | cancelled */
    status: text('status').notNull().default('pending'),
    /** Ids and counts only, or the short reason it was skipped or failed. */
    result: jsonb('result'),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('crm_automation_runs_dedupe_uq').on(table.dedupeKey),
    index('crm_automation_runs_due_idx').on(table.status, table.runAt),
    index('crm_automation_runs_lead_idx').on(table.leadId, table.createdAt),
  ],
);

/**
 * Every e-mail the CRM composed for a lead. `mode` is the transport that
 * handled it: `test` records and sends nothing (the default everywhere until
 * CRM_EMAIL_MODE=smtp is set), `smtp` went out through the Workspace account.
 */
export const crmEmailOutbox = pgTable(
  'crm_email_outbox',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    templateId: uuid('template_id').references(() => crmEmailTemplates.id),
    runId: uuid('run_id').references(() => crmAutomationRuns.id),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    /** test | smtp */
    mode: text('mode').notNull(),
    /** recorded | sent | failed */
    status: text('status').notNull(),
    sentBy: uuid('sent_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('crm_email_outbox_lead_idx').on(table.leadId, table.createdAt)],
);

/** The panel's notices to a person: the message is the rule's own text, never the lead's data. */
export const crmNotifications = pgTable(
  'crm_notifications',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    recipientEmployeeId: uuid('recipient_employee_id')
      .notNull()
      .references(() => employees.id),
    leadId: uuid('lead_id').references(() => leads.id),
    /** automation | first_contact_overdue | task_overdue | stage_stuck */
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (table) => [
    index('crm_notifications_recipient_idx').on(
      table.recipientEmployeeId,
      table.readAt,
      table.createdAt,
    ),
  ],
);
