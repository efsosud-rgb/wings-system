import {
  boolean,
  date,
  index,
  bigserial,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employees } from './employees.js';

/**
 * Roadmap: the daily progress report for the CEOs (Umberto and Thais),
 * approved by Eric (Admin Master) before it goes out. A module holds
 * deliverables; each deliverable has a weight (P/M/G) and a status. The
 * generator seeds deliverables from commit history as `source: 'auto_draft'`;
 * a human edit flips a row to `source: 'manual'` and the generator never
 * overwrites it again. See docs/roadmap.md.
 */

export const roadmapDeliverableWeightEnum = pgEnum('roadmap_deliverable_weight', ['P', 'M', 'G']);

export const roadmapDeliverableStatusEnum = pgEnum('roadmap_deliverable_status', [
  'pronto',
  'em_andamento',
  'pendente',
]);

export const roadmapDeliverableSourceEnum = pgEnum('roadmap_deliverable_source', [
  'auto_draft',
  'manual',
]);

export const roadmapReportRunStatusEnum = pgEnum('roadmap_report_run_status', [
  'rascunho',
  'aprovado',
  'enviado',
  'enviado_simulado',
]);

export const roadmapRecipientRoleEnum = pgEnum('roadmap_recipient_role', ['preview', 'ceo']);

export const roadmapModules = pgTable(
  'roadmap_modules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable slug, e.g. the navigation module/submodule key it maps to. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    position: integer('position').notNull().default(0),
    isComingSoon: boolean('is_coming_soon').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('roadmap_modules_key_uq').on(table.key)],
);

export const roadmapDeliverables = pgTable(
  'roadmap_deliverables',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => roadmapModules.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    weight: roadmapDeliverableWeightEnum('weight').notNull().default('M'),
    status: roadmapDeliverableStatusEnum('status').notNull().default('pendente'),
    completedAt: date('completed_at'),
    source: roadmapDeliverableSourceEnum('source').notNull().default('manual'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('roadmap_deliverables_module_idx').on(table.moduleId),
    index('roadmap_deliverables_status_idx').on(table.status),
  ],
);

/**
 * Append-only: every status/weight change a human makes to a deliverable, so
 * history is never mutated in place (same convention as
 * `client_project_status_history` and `employee.role_changed` in the audit
 * log). `previous`/`next` each carry `{ status, weight }`.
 */
export const roadmapDeliverableChanges = pgTable(
  'roadmap_deliverable_changes',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    deliverableId: uuid('deliverable_id')
      .notNull()
      .references(() => roadmapDeliverables.id, { onDelete: 'cascade' }),
    changedBy: uuid('changed_by').references(() => employees.id, { onDelete: 'restrict' }),
    previous: jsonb('previous').notNull(),
    next: jsonb('next').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('roadmap_deliverable_changes_deliverable_idx').on(table.deliverableId)],
);

/**
 * One row per business day the report ran. `computed` holds the whole
 * snapshot (per-module %, weighted total, velocity/forecast) so an approved
 * or sent run reads back exactly what was approved or sent, even if
 * deliverables change afterwards.
 */
export const roadmapReportRuns = pgTable(
  'roadmap_report_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportDate: date('report_date').notNull(),
    status: roadmapReportRunStatusEnum('status').notNull().default('rascunho'),
    computed: jsonb('computed').notNull(),
    messageText: text('message_text').notNull(),
    approvedBy: uuid('approved_by').references(() => employees.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('roadmap_report_runs_date_uq').on(table.reportDate)],
);

/**
 * `preview` = Eric, gets the 17:30 draft link. `ceo` = Umberto/Thais, get the
 * 18:00 final message once a run is approved.
 */
export const roadmapReportRecipients = pgTable(
  'roadmap_report_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    role: roadmapRecipientRoleEnum('role').notNull(),
    name: text('name').notNull(),
    phone: text('phone').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('roadmap_report_recipients_role_idx').on(table.role, table.active)],
);
