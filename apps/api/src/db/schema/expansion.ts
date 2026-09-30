import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Expansion intake (docs/expansion-intake.md). Nothing personal: a
 * conversion's key (RD contact uuid + identifier + moment) with what was
 * decided about it. The brands' landing pages live in `lead_source_rules`
 * (pipeline `expansao`) since CRM phase 1.
 */

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
