import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { employees } from './employees.js';

/**
 * Append-only audit trail for LGPD accountability: who did what, when and from
 * where.
 *
 * `metadata` must never contain personal data — no CPF, full name, e-mail or
 * phone. Record field names that changed, not their values.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorEmployeeId: uuid('actor_employee_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    /** e.g. employee.created, employee.cpf_revealed, role.assigned, session.login */
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    targetEmployeeId: uuid('target_employee_id').references(() => employees.id, {
      onDelete: 'set null',
    }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (table) => [
    index('audit_log_at_idx').on(table.at),
    index('audit_log_actor_idx').on(table.actorEmployeeId),
    index('audit_log_action_idx').on(table.action),
  ],
);
