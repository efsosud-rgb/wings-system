import type {
  AdCopyPackage,
  AdCopyRequest,
  AgentChangeProposal,
  AuditCheck,
  AuditCounts,
  AuditFindingState,
  AuditLevel,
  AuditPeriodComparison,
  AuditScope,
  AuditStatus,
} from '@wings/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adAccounts, adChangeRequests, tenants, WINGS_TENANT_ID } from './ads.js';
import { employees } from './employees.js';

/**
 * Wings Ads Intelligence (docs/ads/intelligence.md). Same rule as the agent's
 * and the insights' tables: a row here is something on a screen. It reserves
 * no budget and reaches no platform; a change request exists only after a
 * person's click went through the budget guard and the approval gate.
 */

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/** One audit: who asked, over which window and channel, and what it counted. */
export const adAuditRuns = pgTable('ad_audit_runs', {
  tenantId: tenantId(),
  id: uuid('id').primaryKey().defaultRandom(),
  scope: text('scope').$type<AuditScope>().notNull(),
  days: integer('days').notNull(),
  since: text('since').notNull(),
  until: text('until').notNull(),
  /** completed | failed */
  status: text('status').$type<'completed' | 'failed'>().notNull(),
  counts: jsonb('counts').$type<AuditCounts>().notNull(),
  comparison: jsonb('comparison').$type<AuditPeriodComparison[]>().notNull().default([]),
  /** A code, never personal data or a provider's text. */
  error: text('error'),
  requestedBy: uuid('requested_by').references(() => employees.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One check's result. The audit fields never change after the run; only
 * `state` and the request it produced move, and only from `open`, under a
 * conditional update, so two clicks can never make two requests.
 */
export const adAuditFindings = pgTable(
  'ad_audit_findings',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => adAuditRuns.id),
    adAccountId: uuid('ad_account_id').references(() => adAccounts.id),
    check: text('check').$type<AuditCheck>().notNull(),
    platform: text('platform').$type<'meta' | 'google'>(),
    status: text('status').$type<AuditStatus>().notNull(),
    impact: text('impact').$type<AuditLevel>().notNull(),
    confidence: text('confidence').$type<AuditLevel>().notNull(),
    effort: text('effort').$type<AuditLevel>().notNull(),
    priority: real('priority').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    recommendation: text('recommendation').notNull().default(''),
    entityLevel: text('entity_level').$type<'account' | 'campaign' | 'ad'>(),
    entityExternalId: text('entity_external_id'),
    entityName: text('entity_name'),
    action: jsonb('action').$type<AgentChangeProposal>(),
    state: text('state').$type<AuditFindingState>().notNull().default('open'),
    changeRequestId: uuid('change_request_id').references(() => adChangeRequests.id),
    actedBy: uuid('acted_by').references(() => employees.id),
    actedAt: timestamp('acted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ad_audit_findings_run_idx').on(table.runId),
    // One change request per finding, whatever happens between two instances.
    uniqueIndex('ad_audit_findings_change_request_uq')
      .on(table.changeRequestId)
      .where(sql`change_request_id is not null`),
  ],
);

/** One AI ad package: what was asked, what the model wrote, what the rules refused. */
export const adCopyDrafts = pgTable(
  'ad_copy_drafts',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    request: jsonb('request').$type<AdCopyRequest>().notNull(),
    package: jsonb('package').$type<AdCopyPackage>(),
    refused: jsonb('refused')
      .$type<{ headline: string; problems: string[] }[]>()
      .notNull()
      .default([]),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    /** provider | estimate */
    costSource: text('cost_source').notNull().default('provider'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ad_copy_drafts_employee_created_idx').on(table.employeeId, table.createdAt)],
);
