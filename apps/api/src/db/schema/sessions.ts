import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { employees } from './employees.js';

/**
 * Server-side sessions. The cookie carries a random token; only its SHA-256
 * hash is stored, so a database leak does not hand out live sessions.
 * Deactivating an employee or changing their role revokes sessions immediately.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [index('sessions_employee_idx').on(table.employeeId)],
);
