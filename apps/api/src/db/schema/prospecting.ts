import { sql } from 'drizzle-orm';
import {
  check,
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
import { employees } from './employees.js';
import { leads } from './leads.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * CRM Vendas → Prospecção (docs/crm/prospeccao.md). Google's terms let us keep
 * only the place_id: the company's name, address, phone, site, rating and
 * reviews are read live on every answer and never written here. Our own data
 * only: who holds the company, its status, the seller's reason and notes, and
 * what the company's own site showed (`enrichment`).
 */
export const prospects = pgTable(
  'prospects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    /** Google's place_id, the one thing of Google's we may store. */
    placeId: text('place_id').notNull(),
    /** A ProspectStatus. */
    status: text('status').notNull(),
    ownerEmployeeId: uuid('owner_employee_id').references(() => employees.id),
    /** Why it was discarded (motivo). */
    reason: text('reason'),
    /** The seller's observações. */
    notes: text('notes'),
    /** ProspectEnrichment: per key { value, source: 'site da empresa', at }; never the URL read. */
    enrichment: jsonb('enrichment').notNull().default({}),
    leadId: uuid('lead_id').references(() => leads.id),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('prospects_place_uq').on(table.tenantId, table.placeId),
    index('prospects_owner_idx').on(table.tenantId, table.ownerEmployeeId),
    check(
      'prospects_status_check',
      sql`${table.status} in ('reservado', 'descartado', 'contatado', 'sem_interesse', 'nao_contatar', 'virou_lead', 'nao_encontrado')`,
    ),
  ],
);

/**
 * Append-only: one row per reservation of calls to Google, written (under a
 * lock) before the calls go. The quota counts these rows; a call that failed
 * still counts, since Google may have billed it. What the seller typed
 * (segment and places), never what Google answered.
 */
export const prospectCalls = pgTable(
  'prospect_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    /** search | details */
    kind: text('kind').notNull(),
    /** The segment the seller typed; null for a ficha. */
    queryText: text('query_text'),
    locations: text('locations').array().notNull().default([]),
    count: integer('count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('prospect_calls_tenant_created_idx').on(table.tenantId, table.createdAt),
    index('prospect_calls_employee_created_idx').on(table.employeeId, table.createdAt),
  ],
);

/** One row per tenant: { icp, quota }. Missing row or part = the defaults. */
export const prospectingSettings = pgTable('prospecting_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id),
  settings: jsonb('settings').notNull(),
  updatedBy: uuid('updated_by').references(() => employees.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
