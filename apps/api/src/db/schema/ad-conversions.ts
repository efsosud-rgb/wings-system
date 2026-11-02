import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { crmStages, leadStageHistory } from './crm.js';
import { employees } from './employees.js';
import { leads } from './leads.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * Closing the loop (docs/ads/fechar-ciclo.md): the CRM tells Meta and Google
 * which leads reached a stage, so the platforms look for people like the ones
 * who close. Nothing here holds a name, an e-mail or a phone: e-mail and phone
 * are hashed in memory at send time and never written anywhere.
 */

/**
 * The ad identifiers a lead arrived with, each with where and when it was seen:
 * Meta's lead id (instant form), the click ids (fbclid, gclid, gbraid, wbraid)
 * and the Meta browser ids (`_fbc`, `_fbp` cookies). One row per value, so a
 * person who comes back by another ad keeps both. Pseudonymous identifiers:
 * never in a log, an audit row, a report or the dw, and not granted to `wings_ro`.
 */
export const leadAdIdentifiers = pgTable(
  'lead_ad_identifiers',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    /** An AdIdentifierKind: meta_lead_id | fbclid | fbc | fbp | gclid | gbraid | wbraid */
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    /** The door it came through (`leads.source` of that arrival: site_form, meta_lead_ads…). */
    source: text('source').notNull(),
    /** When the person brought it (the form's moment, Meta's created_time); not the row's own time. */
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('lead_ad_identifiers_uq').on(table.leadId, table.kind, table.value)],
);

/**
 * Which stage becomes which event, per platform. Bound to the stage's id, never
 * to its name: renaming a stage changes nothing and resends nothing. For Google,
 * `google_conversion_action_id` is the conversion action (Data Manager's
 * `productDestinationId`) a person created in Google Ads.
 */
export const adConversionStageEvents = pgTable(
  'ad_conversion_stage_events',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => crmStages.id),
    /** meta | google */
    platform: text('platform').notNull(),
    /** Meta's `event_name`; for Google the label the panel shows. */
    eventName: text('event_name').notNull(),
    googleConversionActionId: text('google_conversion_action_id'),
    active: boolean('active').notNull().default(true),
    updatedBy: uuid('updated_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ad_conversion_stage_events_uq').on(table.stageId, table.platform),
    check(
      'ad_conversion_stage_events_google_action',
      sql`${table.platform} <> 'google' or ${table.googleConversionActionId} is not null`,
    ),
  ],
);

/**
 * The outbox of stage events: one row per lead, stage and platform, written
 * before any call (the unique index is the guard against a duplicate, even
 * with two cycles at once). Its id is the event's id at the platform (Meta's
 * `event_id`, Google's `transactionId`), so a retry carries the same id. Never
 * deleted. Holds names of the fields sent and codes, never their values.
 */
export const adConversionSends = pgTable(
  'ad_conversion_sends',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => crmStages.id),
    /** The first entry of the lead in the stage, the event's moment. */
    historyId: uuid('history_id')
      .notNull()
      .references(() => leadStageHistory.id),
    platform: text('platform').notNull(),
    eventName: text('event_name').notNull(),
    /** The dataset (Meta) or the conversion action (Google) it went to. Not a secret. */
    destination: text('destination'),
    eventTime: timestamp('event_time', { withTimezone: true }).notNull(),
    /** pending | sending | sent | failed | skipped */
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** meta_lead_id | click_id | hashed: which path matched the lead. */
    identifierKind: text('identifier_kind'),
    /** Names of the user fields sent (`lead_id`, `fbc`, `em`, `gclid`…), never values. */
    fieldsSent: text('fields_sent').array(),
    /** A code: the platform's HTTP status and error code, or ours (`unreachable`, `timeout`). */
    lastError: text('last_error'),
    /** A ConversionSkipReason when nothing was sent. */
    skipReason: text('skip_reason'),
    /** The platform's request id when it gave one (Google's `requestId`, Meta's `fbtrace_id`). */
    platformRequestId: text('platform_request_id'),
    /** Key names and numbers of the last answer (`shapeOf`), never its strings. */
    responseShape: jsonb('response_shape'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('ad_conversion_sends_uq').on(table.leadId, table.stageId, table.platform),
    index('ad_conversion_sends_due_idx').on(table.state, table.nextAttemptAt),
    index('ad_conversion_sends_created_idx').on(table.platform, table.createdAt),
  ],
);
