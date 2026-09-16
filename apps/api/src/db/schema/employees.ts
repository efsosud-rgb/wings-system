import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { employeeStatusEnum } from './enums.js';
import { roles, sectors } from './org.js';

/**
 * Employee records (Cadastro de Funcionários).
 *
 * LGPD: the CPF is never stored in the clear. `cpfEncrypted` holds an
 * AES-256-GCM ciphertext and `cpfIndex` an HMAC-SHA256 blind index used only
 * for uniqueness and exact lookup. Losing CPF_ENCRYPTION_KEY makes the stored
 * CPFs unrecoverable.
 */
export const employees = pgTable(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Bloco 1 — dados pessoais
    fullName: text('full_name').notNull(),
    cpfEncrypted: text('cpf_encrypted').notNull(),
    cpfIndex: text('cpf_index').notNull(),
    birthDate: date('birth_date').notNull(),
    phone: text('phone').notNull(),
    email: text('email').notNull(),

    // Bloco 2 — dados profissionais
    cargo: text('cargo').notNull(),
    sectorId: uuid('sector_id')
      .notNull()
      .references(() => sectors.id),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    admissionDate: date('admission_date').notNull(),
    status: employeeStatusEnum('status').notNull().default('active'),
    /** Sector managers may create/edit employees within their own sector. */
    isSectorManager: boolean('is_sector_manager').notNull().default(false),

    // Bloco 3 — sistema
    createdBy: uuid('created_by').references((): AnyPgColumn => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('employees_cpf_index_uq').on(table.cpfIndex),
    // E-mail is the login, compared case-insensitively.
    uniqueIndex('employees_email_lower_uq').on(sql`lower(${table.email})`),
  ],
);

/**
 * Login credentials, deliberately in their own table so that listing
 * employees can never return a password hash by accident.
 */
export const employeeCredentials = pgTable('employee_credentials', {
  employeeId: uuid('employee_id')
    .primaryKey()
    .references(() => employees.id, { onDelete: 'cascade' }),
  /** Argon2id. Null until the employee accepts the invite and sets a password. */
  passwordHash: text('password_hash'),
  passwordSetAt: timestamp('password_set_at', { withTimezone: true }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  /** Reserved for TOTP in a later phase (Admin Master and PII viewers). */
  mfaSecretEncrypted: text('mfa_secret_encrypted'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const employeesRelations = relations(employees, ({ one }) => ({
  sector: one(sectors, { fields: [employees.sectorId], references: [sectors.id] }),
  role: one(roles, { fields: [employees.roleId], references: [roles.id] }),
  credentials: one(employeeCredentials, {
    fields: [employees.id],
    references: [employeeCredentials.employeeId],
  }),
}));
