import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';

/**
 * Expansion intake (docs/expansion-intake.md). Neither table holds anything
 * personal: a landing page's identifier and its brand, and a conversion's key
 * (RD contact uuid + identifier + moment) with what was decided about it.
 */

/** Landing pages of client brands: a conversion on one becomes an Expansão deal. */
export const expansionLandingPages = pgTable('expansion_landing_pages', {
  tenantId: uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id),
  /** RD Marketing's `conversion_identifier`. */
  identifier: text('identifier').primaryKey(),
  brand: text('brand').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per conversion the intake decided about; the unique key is what stops a second deal. */
export const expansionIntakeLedger = pgTable('expansion_intake_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversionKey: text('conversion_key').notNull().unique(),
  target: text('target', { enum: ['expansao', 'formatacao'] }).notNull(),
  outcome: text('outcome', {
    enum: ['created', 'existing_deal', 'no_contact_data', 'failed'],
  }).notNull(),
  rdDealId: text('rd_deal_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
});
