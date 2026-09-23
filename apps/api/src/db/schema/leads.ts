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
import { clientId, clients } from './clients.js';
import { employees } from './employees.js';
import { jobs } from './jobs.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * Funil Sofia, part 1 (docs/leads/intake.md). A lead is a person who reached
 * out: through a landing page (RD Station), a tracked WhatsApp link, a Meta
 * Lead Ads form, or a person typing one in. Name, e-mail and phone are
 * personal data: they are never written to a log, an audit row or a job's
 * error, and the worker refers to a lead only by id.
 */
export const leads = pgTable(
  'leads',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: clientId(),
    /** False when no source rule named the client: filed under Wings Company until someone adds one. */
    clientMapped: boolean('client_mapped').notNull().default(true),
    name: text('name'),
    /** Lower-cased. */
    email: text('email'),
    /** Digits only, 55 + DDD + number. */
    phone: text('phone'),
    /** Part 1 knows only `new`; the SDR handoff (part 2) adds the rest. */
    status: text('status').notNull().default('new'),
    ownerEmployeeId: uuid('owner_employee_id').references(() => employees.id),
    /** rd_station | whatsapp_link | meta_lead_ads | manual */
    source: text('source').notNull(),
    /** A LeadChannel, or null when nothing said. */
    channel: text('channel'),
    landingPage: text('landing_page'),
    campaignId: text('campaign_id'),
    campaignName: text('campaign_name'),
    formId: text('form_id'),
    trackingLinkId: uuid('tracking_link_id'),
    /** RD's lead uuid or Meta's leadgen id, unique per source so a retried webhook is the same lead. */
    externalId: text('external_id'),
    /** The first WhatsApp message, for the SDR to read; nothing is derived from it but the code. */
    firstMessage: text('first_message'),
    whatsappProfileName: text('whatsapp_profile_name'),
    whatsappPhotoUrl: text('whatsapp_photo_url'),
    /** LGPD: a LeadLegalBasis, when it was given and where (docs/leads/intake.md). */
    legalBasis: text('legal_basis'),
    consentedAt: timestamp('consented_at', { withTimezone: true }),
    consentSource: text('consent_source'),
    consentText: text('consent_text'),
    /** none | pending | running | done | failed; the worker writes the rest. */
    enrichmentState: text('enrichment_state').notNull().default('none'),
    enrichmentJobId: uuid('enrichment_job_id').references(() => jobs.id),
    enrichmentSummary: text('enrichment_summary'),
    enrichmentScore: integer('enrichment_score'),
    enrichmentCriteria: jsonb('enrichment_criteria').notNull().default([]),
    enrichmentLinks: jsonb('enrichment_links').notNull().default([]),
    enrichmentFacts: jsonb('enrichment_facts'),
    enrichmentError: text('enrichment_error'),
    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('leads_source_external_uq').on(table.source, table.externalId),
    index('leads_phone_idx').on(table.tenantId, table.phone),
    index('leads_email_idx').on(table.tenantId, table.email),
    index('leads_client_created_idx').on(table.clientId, table.createdAt),
    index('leads_owner_idx').on(table.ownerEmployeeId),
    index('leads_created_idx').on(table.createdAt),
  ],
);

/**
 * Append-only timeline of a lead: received from where, tagged by which code,
 * research started and finished. `detail` is context (ids, counts, step
 * names), never a name, e-mail or phone.
 */
export const leadEvents = pgTable(
  'lead_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull(),
    actorEmployeeId: uuid('actor_employee_id').references(() => employees.id),
    detail: jsonb('detail').notNull().default({}),
  },
  (table) => [index('lead_events_lead_idx').on(table.leadId, table.at)],
);

/**
 * Landing page / Meta form / Meta campaign -> client. Kept by whoever holds
 * `clients.manage` (Administração → Clientes). A conversion that matches no
 * rule still becomes a lead, under Wings Company and flagged as unmapped.
 */
export const leadSourceRules = pgTable(
  'lead_source_rules',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** landing_page | meta_form | meta_campaign */
    kind: text('kind').notNull(),
    /** Normalised: lower-case, no scheme, no trailing slash. */
    pattern: text('pattern').notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('lead_source_rules_kind_pattern_uq').on(table.tenantId, table.kind, table.pattern)],
);

/**
 * One wa.me link per client and channel: `wa.me/<Wings number>?text=<code>`.
 * The code is what an inbound message starts with; the number is recorded so
 * a link printed in a bio stays explainable after the number changes.
 */
export const leadTrackingLinks = pgTable(
  'lead_tracking_links',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    /** A LeadLinkChannel. */
    channel: text('channel').notNull(),
    code: text('code').notNull(),
    phone: text('phone').notNull(),
    hits: integer('hits').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('lead_tracking_links_code_uq').on(table.code),
    index('lead_tracking_links_client_idx').on(table.clientId),
  ],
);

/**
 * Append-only: every enrichment step of every lead, with what it cost in
 * micro-dollars. The daily ceiling (ENRICH_DAILY_USD) is a sum over this
 * table, taken under a lock before each paid call; the row is written before
 * the call is made, and the call is made once.
 */
export const leadEnrichmentLedger = pgTable(
  'lead_enrichment_ledger',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    jobId: uuid('job_id').references(() => jobs.id),
    /** zapi_profile | ddd | email_domain | web_search | brasilapi_cnpj */
    step: text('step').notNull(),
    /** started | done | failed | skipped | refused */
    status: text('status').notNull(),
    usdMicro: integer('usd_micro').notNull().default(0),
    /** Counts and codes only; never a query string, a name or a snippet. */
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('lead_enrichment_ledger_created_idx').on(table.createdAt),
    index('lead_enrichment_ledger_lead_idx').on(table.leadId, table.createdAt),
  ],
);
