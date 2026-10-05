import {
  boolean,
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
import { leads } from './leads.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * Meta Lead Ads, the queue (docs/leads/meta-lead-ads.md). The webhook only
 * stores the event and answers 200; a worker loop in the API reads the form's
 * answers from the Graph API, creates or merges the lead in the Funil and
 * makes the copy in RD CRM. One row per `leadgen_id`: Meta re-sends webhooks,
 * and the unique index is what makes a re-send a no-op.
 *
 * `payload` is the raw change as Meta sent it (ids and timestamps only, no
 * form answers: those are read from the Graph API and live in `leads`), kept
 * for at most 90 days (`purgeMetaLeadgenPayloads`). `last_error` and
 * `rd_outcome` are codes, never text about the person.
 */
export const metaLeadgenEvents = pgTable(
  'meta_leadgen_events',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadgenId: text('leadgen_id').notNull(),
    formId: text('form_id'),
    pageId: text('page_id'),
    adId: text('ad_id'),
    adgroupId: text('adgroup_id'),
    /** When Meta says the form was sent. */
    createdTime: timestamp('created_time', { withTimezone: true }),
    payload: jsonb('payload'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** pending | done | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** A code: no_token, graph_4xx, graph_unreachable, no_contact_data, ... */
    lastError: text('last_error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    leadId: uuid('lead_id').references(() => leads.id),
    leadCreated: boolean('lead_created'),
    /** The RD CRM deal this lead got (made here or found open on the contact). */
    rdDealId: text('rd_deal_id'),
    /** created | existing_deal | no_pipeline | no_contact_data | disabled | unknown | failed */
    rdOutcome: text('rd_outcome'),
  },
  (table) => [
    uniqueIndex('meta_leadgen_events_leadgen_uq').on(table.leadgenId),
    index('meta_leadgen_events_status_idx').on(table.status, table.nextAttemptAt),
    index('meta_leadgen_events_received_idx').on(table.receivedAt),
  ],
);
