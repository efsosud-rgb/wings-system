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
 * The single tenant every row currently belongs to.
 *
 * Wings System is single-tenant today. Diretoria is considering offering it
 * to other companies later, and adding this column now — while staging holds
 * a handful of rows — costs nothing, whereas retrofitting it across live data
 * later would be painful. Nothing routes by tenant yet: there is one row, and
 * all logic still assumes it.
 */
export const WINGS_TENANT_ID = '00000000-0000-0000-0000-000000000001';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Every ads table carries this, so scoping later needs no migration. */
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

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

/** Where a campaign's budget actually lives: CBO (campaign) or ABO (ad set). */
export const budgetLevelEnum = pgEnum('ad_budget_level', ['campaign', 'ad_set', 'none']);

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

/** Lifecycle of a human decision on a money-moving change. */
export const approvalStatusEnum = pgEnum('ad_approval_status', [
  'pending',
  'escalated',
  'approved',
  'rejected',
]);

/** Why the gate demanded a human decision. */
export const approvalTriggerEnum = pgEnum('ad_approval_trigger', [
  'policy_always',
  'above_single_threshold',
  'cumulative_24h',
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
    tenantId: tenantId(),
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
    /**
     * Set when an account stops being the operation we mirror. Archived
     * accounts keep every row they ever produced — the approvals, the audit
     * trail and the guardrail events still reference them — but they are
     * excluded from ingestion, the cockpit and the alert engine.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedReason: text('archived_reason'),
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
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    /** First day of the month this period covers. */
    periodMonth: date('period_month').notNull(),
    /**
     * What the platform itself still allows, read from its API — Meta's
     * spend_cap minus amount_spent, Google's account budget minus amount
     * served. Null when never synced or when the platform sets no limit.
     *
     * The effective ceiling is the SMALLER of this and our internal cap: an
     * internal cap above what the platform permits is fiction.
     */
    platformRemainingCents: bigint('platform_remaining_cents', { mode: 'number' }),
    platformLimitSource: text('platform_limit_source'),
    platformLimitSyncedAt: timestamp('platform_limit_synced_at', { withTimezone: true }),
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
  tenantId: tenantId(),
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
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    status: adCampaignStatusEnum('status').notNull().default('PAUSED'),
    dailyBudgetCents: bigint('daily_budget_cents', { mode: 'number' }).notNull().default(0),
    lifetimeBudgetCents: bigint('lifetime_budget_cents', { mode: 'number' }),
    /**
     * Which level owns the money. Meta accounts mix both: a CBO campaign
     * carries its own budget, while an ABO campaign has none and its ad sets
     * do. Exposure must follow the budget, or an ABO campaign would look free.
     */
    budgetLevel: budgetLevelEnum('budget_level').notNull().default('none'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ad_campaigns_account_external_uq').on(table.adAccountId, table.externalId),
  ],
);

/**
 * Ad sets (ABO). An ad set only delivers when both it and its campaign are
 * active, which is why the live account showed ACTIVE ad sets spending
 * nothing under PAUSED campaigns.
 */
export const adSets = pgTable(
  'ad_sets',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => adCampaigns.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    status: adCampaignStatusEnum('status').notNull().default('PAUSED'),
    dailyBudgetCents: bigint('daily_budget_cents', { mode: 'number' }).notNull().default(0),
    lifetimeBudgetCents: bigint('lifetime_budget_cents', { mode: 'number' }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ad_sets_campaign_external_uq').on(table.campaignId, table.externalId)],
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
    tenantId: tenantId(),
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
    /**
     * Set when the change was allowed to proceed without a human decision.
     * Only possible under the threshold policy; it also feeds the rolling
     * 24h cumulative rule, so small changes cannot add up unnoticed.
     */
    autoApproved: boolean('auto_approved').notNull().default(false),
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
    tenantId: tenantId(),
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
    tenantId: tenantId(),
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
  tenantId: tenantId(),
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

/**
 * The approvals gate.
 *
 * Kept separate from ad_change_requests on purpose: the change request tracks
 * what should happen to a budget, this tracks the human decision about it.
 * One row per decision needed, never edited into a different meaning — the
 * status moves forward only.
 */
export const adApprovalRequests = pgTable(
  'ad_approval_requests',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    changeRequestId: uuid('change_request_id')
      .notNull()
      .references(() => adChangeRequests.id)
      .unique(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    /** Size of the money movement being judged, in cents (absolute). */
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    trigger: approvalTriggerEnum('trigger').notNull(),
    status: approvalStatusEnum('status').notNull().default('pending'),
    /** Null when the agent asked; set when a person did. */
    requestedBy: uuid('requested_by').references(() => employees.id),
    requestedByAgent: boolean('requested_by_agent').notNull().default(false),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    /** Moment it was escalated to Diretoria. Escalation never expires it. */
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => employees.id),
    decisionReason: text('decision_reason'),
    /** Bound to the exact change; a drifted payload voids the approval. */
    payloadHash: text('payload_hash').notNull(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    notificationError: text('notification_error'),
  },
  (table) => [
    index('ad_approval_requests_status_idx').on(table.status, table.requestedAt),
    index('ad_approval_requests_account_idx').on(table.adAccountId),
  ],
);

/** Level an insights row belongs to. */
export const metricsLevelEnum = pgEnum('ad_metrics_level', ['campaign', 'ad_set', 'ad']);

/**
 * Ads (the creative-carrying layer) and the minimum creative detail the
 * cockpit shows. Deliberately small: the builder is out of scope, so there is
 * no ad-creation machinery here, only a mirror of what exists.
 */
export const adAds = pgTable(
  'ad_ads',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    adSetId: uuid('ad_set_id').references(() => adSets.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').references(() => adCampaigns.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    status: adCampaignStatusEnum('status').notNull().default('PAUSED'),
    /** Meta's effective_status: DISAPPROVED, WITH_ISSUES, CAMPAIGN_PAUSED… */
    effectiveStatus: text('effective_status'),
    creativeExternalId: text('creative_external_id'),
    /**
     * The real rejection reason. The spike found ad_review_feedback carries it
     * while issues_info is empty on disapproved ads, so both are stored and
     * the UI prefers review feedback.
     */
    reviewFeedback: jsonb('review_feedback'),
    issuesInfo: jsonb('issues_info'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ad_ads_account_external_uq').on(table.adAccountId, table.externalId)],
);

export const adCreatives = pgTable(
  'ad_creatives',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    externalId: text('external_id').notNull(),
    name: text('name'),
    thumbnailUrl: text('thumbnail_url'),
    title: text('title'),
    body: text('body'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('ad_creatives_account_external_uq').on(table.adAccountId, table.externalId),
  ],
);

/**
 * Daily performance, one row per entity per day per level.
 *
 * Upserted rather than append-only: platforms revise these figures for days
 * afterwards, and the cockpit should show the current truth. Money stays in
 * ad_spend_snapshots, which IS append-only — analytics and the guardrail must
 * not share a table.
 *
 * Ratios are stored as integers (x1000) so no float ever touches a metric.
 * CPL and CPA are deliberately NOT stored: with no conversion events on this
 * account, a derived number would be fiction. They are computed at query time
 * when conversions exist.
 */
export const adMetricsDaily = pgTable(
  'ad_metrics_daily',
  {
    tenantId: tenantId(),
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    level: metricsLevelEnum('level').notNull(),
    /** The platform's id for the entity this row measures. */
    entityExternalId: text('entity_external_id').notNull(),
    campaignId: uuid('campaign_id').references(() => adCampaigns.id, { onDelete: 'cascade' }),
    adSetId: uuid('ad_set_id').references(() => adSets.id, { onDelete: 'cascade' }),
    adId: uuid('ad_id').references(() => adAds.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    spendCents: bigint('spend_cents', { mode: 'number' }).notNull().default(0),
    impressions: bigint('impressions', { mode: 'number' }).notNull().default(0),
    clicks: bigint('clicks', { mode: 'number' }).notNull().default(0),
    reach: bigint('reach', { mode: 'number' }).notNull().default(0),
    /** CTR percentage x1000 (1.425% -> 1425). */
    ctrMilli: bigint('ctr_milli', { mode: 'number' }).notNull().default(0),
    /** Frequency x1000 (1.27 -> 1270). */
    frequencyMilli: bigint('frequency_milli', { mode: 'number' }).notNull().default(0),
    /** Conversions of the account's lead action type, when one exists. */
    conversions: bigint('conversions', { mode: 'number' }).notNull().default(0),
    /** Every action type reported, kept raw so the lead type can be chosen later. */
    actions: jsonb('actions').notNull().default({}),
    /**
     * The daily budget in force for this entity on this day, captured at
     * ingest. The platform APIs join the CURRENT budget to historical metrics,
     * so without this snapshot any later "did it overdeliver?" question is
     * unanswerable after the first budget change.
     */
    dailyBudgetCents: bigint('daily_budget_cents', { mode: 'number' }),
    qualityRanking: text('quality_ranking'),
    engagementRateRanking: text('engagement_rate_ranking'),
    conversionRateRanking: text('conversion_rate_ranking'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Scoped by account: entity ids are unique within a platform, but the
    // guarantee we want is per account, and a cross-account collision would
    // silently overwrite another account's numbers.
    uniqueIndex('ad_metrics_daily_entity_day_uq').on(
      table.adAccountId,
      table.level,
      table.entityExternalId,
      table.day,
    ),
    index('ad_metrics_daily_account_day_idx').on(table.adAccountId, table.day),
  ],
);

export const alertKindEnum = pgEnum('ad_alert_kind', [
  'ad_rejected',
  'budget_pacing',
  'creative_fatigue',
  'quality_below_average',
  'conversion_silence',
]);

export const alertSeverityEnum = pgEnum('ad_alert_severity', ['info', 'warning', 'critical']);

/**
 * Cockpit alerts.
 *
 * One open row per (account, kind, entity): a condition that persists updates
 * `lastSeenAt` rather than piling up duplicates, so a rejected ad does not
 * produce a new alert every hour. Critical alerts also reach WhatsApp; the
 * rest live in the in-app feed.
 */
export const adAlerts = pgTable(
  'ad_alerts',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    kind: alertKindEnum('kind').notNull(),
    severity: alertSeverityEnum('severity').notNull(),
    /** Which entity triggered it, at the platform's own id. */
    entityLevel: metricsLevelEnum('entity_level'),
    entityExternalId: text('entity_external_id'),
    title: text('title').notNull(),
    detail: jsonb('detail').notNull().default({}),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the condition stops holding. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: uuid('acknowledged_by').references(() => employees.id),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    notificationError: text('notification_error'),
  },
  (table) => [
    index('ad_alerts_account_idx').on(table.adAccountId, table.resolvedAt),
    // At most one OPEN alert per condition per entity.
    uniqueIndex('ad_alerts_open_uq')
      .on(table.adAccountId, table.kind, table.entityExternalId)
      .where(sql`resolved_at is null`),
  ],
);
