import { index, pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { credentialTokenPurposeEnum } from './enums.js';
import { employees } from './employees.js';

/**
 * One-time links for setting a password: the invite sent when an employee is
 * created, and self-service password resets.
 *
 * Only the SHA-256 hash of the token is stored, so a database leak cannot be
 * turned into an account takeover. Tokens are single-use (`usedAt`) and always
 * expire.
 */
export const credentialTokens = pgTable(
  'credential_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    purpose: credentialTokenPurposeEnum('purpose').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Who issued the invite; null for a self-service reset. */
    createdBy: uuid('created_by').references((): AnyPgColumn => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('credential_tokens_employee_idx').on(table.employeeId, table.purpose)],
);
