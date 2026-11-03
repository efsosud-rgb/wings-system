import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
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

/**
 * What Business Discovery said about a company's Instagram business account
 * (docs/prospeccao/instagram.md §2.2, parte 3). Numbers only, with the source
 * and the date: never the name, bio, site, picture, captions or media ids, and
 * never the place_id (the link with Google is made live, on the screen). A row
 * is the cache of the score for `discovery.cacheDias`, and is deleted 30 days
 * after `fetched_at` (prospect-ai housekeeping).
 */
export const instagramBusinessSnapshots = pgTable(
  'instagram_business_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    /** normalizeInstagram: lower case, no @. */
    username: text('username').notNull(),
    status: text('status').notNull(),
    followersCount: integer('followers_count'),
    mediaCount: integer('media_count'),
    recentMediaRead: smallint('recent_media_read'),
    /** Average × 1000; null when no post brought the field. */
    avgLikesMilli: integer('avg_likes_milli'),
    avgCommentsMilli: integer('avg_comments_milli'),
    /** Null when no post brought a timestamp. */
    postsLast30d: smallint('posts_last_30d'),
    lastPostAt: timestamp('last_post_at', { withTimezone: true }),
    /** The Graph error code when status = 'erro'. */
    errorCode: integer('error_code'),
    source: text('source').notNull().default('meta_business_discovery'),
    apiVersion: text('api_version').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('instagram_business_snapshots_username_uq').on(table.tenantId, table.username),
    index('instagram_business_snapshots_fetched_idx').on(table.fetchedAt),
    check(
      'instagram_business_snapshots_status_check',
      sql`${table.status} in ('encontrada', 'nao_comercial', 'erro')`,
    ),
  ],
);

/**
 * Insert-only: one row per call to Business Discovery, written (under a lock)
 * before the call goes, as the Google quota (`prospect_calls`). The daily
 * ceiling `discovery.porDia` counts these rows; a call that failed still counts.
 * Who asked and when, never the @; deleted after 30 days (prospect-ai housekeeping).
 */
export const instagramDiscoveryCalls = pgTable(
  'instagram_discovery_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('instagram_discovery_calls_created_idx').on(table.tenantId, table.createdAt)],
);
