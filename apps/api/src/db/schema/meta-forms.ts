import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The Lead Ads forms the access key can see, found by the periodic read
 * (`meta-poll.ts`). Only ids, names and counters: no answer, no person. The
 * name is what classifies a form that has no rule; `polled_through` is how far
 * its leads were listed, so the next pass asks only for what is newer.
 */
export const metaLeadForms = pgTable('meta_lead_forms', {
  formId: text('form_id').primaryKey(),
  pageId: text('page_id').notNull(),
  pageName: text('page_name'),
  name: text('name'),
  /** The form's status on Meta (ACTIVE, ARCHIVED, ...). */
  status: text('status'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** Leads created up to here have been listed (with a safety overlap on the next ask). */
  polledThrough: timestamp('polled_through', { withTimezone: true }),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  /** A short code (`graph_403`, `graph_unreachable`) or null. */
  lastError: text('last_error'),
  leadsListed: integer('leads_listed').notNull().default(0),
});

/** One row (`id = 'leads'`): when the periodic read last ran and what it found, as totals. */
export const metaPollState = pgTable('meta_poll_state', {
  id: text('id').primaryKey(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  lastResult: jsonb('last_result'),
  lastError: text('last_error'),
});
