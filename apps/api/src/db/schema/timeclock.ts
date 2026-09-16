import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  adjustmentStatusEnum,
  holidayScopeEnum,
  timeEntryKindEnum,
  timeEntrySourceEnum,
} from './enums.js';
import { employees } from './employees.js';

/**
 * RH/DP time clock.
 *
 * ⚠️ Portaria MTP 671/2021 compliance is NOT yet legally confirmed. The model
 * is built compliance-ready — entries are append-only, always carry their
 * origin, and can be exported — but this must not be used for payroll until
 * Jurídico signs off.
 */

/** A single company-wide schedule for now: 09:00–18:00, Mon–Fri, 30 min tolerance. */
export const workSchedules = pgTable('work_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  breakMinutes: integer('break_minutes').notNull().default(60),
  toleranceMinutes: integer('tolerance_minutes').notNull().default(30),
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  weekdays: integer('weekdays').array().notNull(),
  /** Calculations run in this zone; the server itself is UTC. */
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const holidays = pgTable('holidays', {
  day: date('day').primaryKey(),
  name: text('name').notNull(),
  scope: holidayScopeEnum('scope').notNull().default('national'),
});

/**
 * Append-only: a database trigger rejects UPDATE and DELETE. Corrections are
 * recorded as new rows via time_adjustments.
 */
export const timeEntries = pgTable(
  'time_entries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    kind: timeEntryKindEnum('kind').notNull(),
    source: timeEntrySourceEnum('source').notNull(),
    /** Session that produced a login/logout entry, for traceability. */
    sessionId: text('session_id'),
    /** Set when the row came from an approved adjustment. */
    adjustmentId: uuid('adjustment_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('time_entries_employee_occurred_idx').on(table.employeeId, table.occurredAt)],
);

/** Correction requests. Approving one inserts a new time_entries row. */
export const timeAdjustments = pgTable(
  'time_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    relatedEntryId: bigint('related_entry_id', { mode: 'bigint' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => employees.id),
    approvedBy: uuid('approved_by').references(() => employees.id),
    reason: text('reason').notNull(),
    proposedOccurredAt: timestamp('proposed_occurred_at', { withTimezone: true }).notNull(),
    proposedKind: timeEntryKindEnum('proposed_kind').notNull(),
    status: adjustmentStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [index('time_adjustments_employee_idx').on(table.employeeId, table.status)],
);

/** Nightly rollup used by RH/DP screens; always recomputable from time_entries. */
export const dailyTimesheets = pgTable(
  'daily_timesheets',
  {
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    workDate: date('work_date').notNull(),
    workedMinutes: integer('worked_minutes').notNull().default(0),
    expectedMinutes: integer('expected_minutes').notNull().default(0),
    lateMinutes: integer('late_minutes').notNull().default(0),
    absent: boolean('absent').notNull().default(false),
    /** Employees on leave are never flagged as absent. */
    onLeave: boolean('on_leave').notNull().default(false),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.employeeId, table.workDate] })],
);
