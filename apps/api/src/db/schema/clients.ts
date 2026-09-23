import { WINGS_CLIENT_ID } from '@wings/shared';
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';

/**
 * Who a piece of work is for. Minimal on purpose: id, name, slug, active.
 * Wings Company is a row too, with a fixed id the migration inserts, so every
 * `client_id` elsewhere can be NOT NULL and default to "for us".
 */
export const clients = pgTable(
  'clients',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .default(WINGS_TENANT_ID)
      .references(() => tenants.id),
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    active: boolean('active').notNull().default(true),
    /** ExpansionEntry[]: where the client is looking for franchisees (docs/leads/intake.md). */
    expansionArea: jsonb('expansion_area').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('clients_tenant_slug_idx').on(table.tenantId, table.slug)],
);

/** `client_id`, defaulting to Wings Company. */
export const clientId = () =>
  uuid('client_id')
    .notNull()
    .default(WINGS_CLIENT_ID)
    .references(() => clients.id);
