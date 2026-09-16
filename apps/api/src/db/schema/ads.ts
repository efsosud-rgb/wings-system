import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employees } from './employees.js';

/**
 * Paid traffic (Marketing module).
 *
 * Every cap is **per ad account**, never pooled: Meta R$4.000, Google R$4.000
 * and TikTok R$2.000 are independent budgets, and exhausting one must have no
 * effect on the others. Meta is the only platform wired in V1, but nothing
 * here is Meta-specific.
 *
 * All money is integer cents of BRL.
 */

export const adPlatformEnum = pgEnum('ad_platform', ['meta', 'google', 'tiktok']);

export const adCampaignStatusEnum = pgEnum('ad_campaign_status', [
  'ACTIVE',
  'PAUSED',
  'DELETED',
  'ARCHIVED',
]);

export const changeKindEnum = pgEnum('ad_change_kind', [
  'set_daily_budget',
  'pause_campaign',
  'resume_campaign',
]);

export const changeStatusEnum = pgEnum('ad_change_status', [
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'executed',
  'failed',
  'unknown',
  'expired',
  'superseded',
]);

export const guardrailEventKindEnum = pgEnum('ad_guardrail_event_kind', [
  'cap_would_be_exceeded',
  'usable_would_be_exceeded',
  'kill_switch_engaged',
  'kill_switch_released',
  'reconciliation_stale',
  'implausible_amount',
  'unknown_execution_outcome',
  'cap_change',
]);

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: adPlatformEnum('platform').notNull(),
    /** Platform's own account id, e.g. act_123456789 for Meta. */
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull().default('BRL'),
    timezone: text('timezone').notNull().default('America/Sao_Paulo'),
    /** When engaged, no change of any kind may be reserved or executed. */
    killSwitchEngaged: boolean('kill_switch_engaged').notNull().default(false),
    killSwitchReason: text('kill_switch_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ad_accounts_platform_external_uq').on(table.platform, table.externalId)],
);

/**
 * The guardrail lives here. One row per ad account per month, carrying the
 * cap and the two running totals. The CHECK constraints added in the migration
 * make a breach impossible at the database level — not merely unlikely.
 */
export const budgetPeriods = pgTable(
  'ad_budget_periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    /** First day of the month this period covers. */
    periodMonth: date('period_month').notNull(),
    /** Hard ceiling for the account this month. */
    capCents: bigint('cap_cents', { mode: 'number' }).notNull(),
    /** Portion the agent may plan against (70%); the rest absorbs overdelivery. */
    usableCents: bigint('usable_cents', { mode: 'number' }).notNull(),
    /** Planned future exposure from active budgets, including overdelivery. */
    committedCents: bigint('committed_cents', { mode: 'number' }).notNull().default(0),
    /** Spend the platform has actually reported. */
    spentCents: bigint('spent_cents', { mode: 'number' }).notNull().default(0),
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ad_budget_periods_account_month_uq').on(table.adAccountId, table.periodMonth),
  ],
);

/** Append-only record of cap changes. Caps are never edited silently. */
export const budgetCapHistory = pgTable('ad_budget_cap_history', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  adAccountId: uuid('ad_account_id')
    .notNull()
    .references(() => adAccounts.id),
  periodMonth: date('period_month').notNull(),
  previousCapCents: bigint('previous_cap_cents', { mode: 'number' }),
  newCapCents: bigint('new_cap_cents', { mode: 'number' }).notNull(),
  usablePercent: bigint('usable_percent', { mode: 'number' }).notNull(),
  changedBy: uuid('changed_by').references(() => employees.id),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adCampaigns = pgTable(
  'ad_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    status: adCampaignStatusEnum('status').notNull().default('PAUSED'),
    dailyBudgetCents: bigint('daily_budget_cents', { mode: 'number' }).notNull().default(0),
    lifetimeBudgetCents: bigint('lifetime_budget_cents', { mode: 'number' }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ad_campaigns_account_external_uq').on(table.adAccountId, table.externalId),
  ],
);

/**
 * A proposed change and its reserved exposure.
 *
 * Every change requires approval by Admin Master or Diretoria — there is no
 * auto-approval threshold. The reservation is taken when the request is
 * created, so two pending requests cannot both fit under a cap that only has
 * room for one.
 */
export const adChangeRequests = pgTable(
  'ad_change_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => adCampaigns.id),
    budgetPeriodId: uuid('budget_period_id')
      .notNull()
      .references(() => budgetPeriods.id),
    kind: changeKindEnum('kind').notNull(),
    fromValueCents: bigint('from_value_cents', { mode: 'number' }),
    toValueCents: bigint('to_value_cents', { mode: 'number' }),
    /** Exposure this change adds (or releases, when negative). */
    exposureDeltaCents: bigint('exposure_delta_cents', { mode: 'number' }).notNull(),
    /** Hash over the exact change; an approval is bound to this value. */
    payloadHash: text('payload_hash').notNull(),
    status: changeStatusEnum('status').notNull().default('pending_approval'),
    /** Null when proposed by the agent rather than a person. */
    requestedBy: uuid('requested_by').references(() => employees.id),
    requestedByAgent: boolean('requested_by_agent').notNull().default(false),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => employees.id),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    /** True while this request holds exposure in committed_cents. */
    reservationActive: boolean('reservation_active').notNull().default(true),
  },
  (table) => [
    index('ad_change_requests_account_status_idx').on(table.adAccountId, table.status),
    index('ad_change_requests_campaign_idx').on(table.campaignId),
  ],
);

/** Append-only: every refusal, kill-switch trip and anomaly. */
export const adGuardrailEvents = pgTable(
  'ad_guardrail_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    adAccountId: uuid('ad_account_id').references(() => adAccounts.id),
    kind: guardrailEventKindEnum('kind').notNull(),
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ad_guardrail_events_account_idx').on(table.adAccountId, table.createdAt)],
);

/** Append-only spend as reported by the platform, for reconciliation. */
export const adSpendSnapshots = pgTable(
  'ad_spend_snapshots',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    campaignId: uuid('campaign_id').references(() => adCampaigns.id),
    spendDate: date('spend_date').notNull(),
    spendCents: bigint('spend_cents', { mode: 'number' }).notNull(),
    asOf: timestamp('as_of', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull().default('platform'),
  },
  (table) => [index('ad_spend_snapshots_account_date_idx').on(table.adAccountId, table.spendDate)],
);

/** Append-only log of platform calls. `unknown` is a real outcome, not an error. */
export const adExecutions = pgTable('ad_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  changeRequestId: uuid('change_request_id')
    .notNull()
    .references(() => adChangeRequests.id),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(),
  outcome: text('outcome'),
  platformResponse: jsonb('platform_response').notNull().default({}),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

/** Convenience: the SQL used by the guard to lock a period row. */
export const LOCK_PERIOD_SQL = sql`select id from ad_budget_periods where id = $1 for update`;
