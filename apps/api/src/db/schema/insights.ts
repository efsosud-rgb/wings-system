import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adAccounts, adCampaigns, adChangeRequests, tenants, WINGS_TENANT_ID } from './ads.js';
import { employees } from './employees.js';

/**
 * Dashboard → Marketing, part 2: what the ingest job says about itself, the
 * insights and campaign suggestions the model writes, the CPL targets a person
 * confirms, and the mirror of the blog.
 *
 * Same rules as the agent's tables: a row here is a card on a screen and
 * nothing else. It reserves no budget and reaches no platform; a change
 * request exists only after a person's click went through the budget guard.
 */

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * One row per run of `ingest-cli`, written when it starts and again when it
 * ends, so the dashboard can say when the last ingestion was, whether it
 * finished, which account failed in which step, and whether the next one is
 * overdue. Append-only.
 */
export const ingestRuns = pgTable(
  'ingest_runs',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * `scheduled` from the Coolify task, `manual` from a shell; the YouTube
     * ingestion writes `scheduled_youtube` (the API's own timer) and
     * `manual_youtube`.
     */
    trigger: text('trigger').notNull().default('scheduled'),
    /** running | ok | failed */
    status: text('status').notNull().default('running'),
    /** First day of the metrics window it pulled. */
    since: date('since'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** `[{ platform, externalId, status, step?, error? }]`, one per account served. */
    accounts: jsonb('accounts').notNull().default([]),
    /** `{ status, posts?, error? }` of the blog mirror step; null when WordPress is not configured. */
    site: jsonb('site'),
    /**
     * The YouTube ingestion's own outcome (`{ channelId, source, videos,
     * calls, units, shorts }`) on its rows (`scheduled_youtube` /
     * `manual_youtube`); null on the ads cycles' rows.
     */
    youtube: jsonb('youtube'),
    /** Codes and names only, never personal data. */
    error: text('error'),
  },
  (table) => [index('ingest_runs_started_idx').on(table.startedAt)],
);

export const insightRunKindEnum = pgEnum('insight_run_kind', ['insights', 'campaign_suggestions']);
export const insightRunTriggerEnum = pgEnum('insight_run_trigger', ['schedule', 'manual']);
export const insightRunStatusEnum = pgEnum('insight_run_status', ['running', 'done', 'failed']);

/**
 * One call chain to the model, scheduled or on demand. Carries what the
 * agent's messages carry (model, tokens, cost, what was consulted), so the
 * AI spend on the dashboard adds these to the agent's ledger.
 */
export const insightRuns = pgTable(
  'marketing_insight_runs',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    kind: insightRunKindEnum('kind').notNull(),
    trigger: insightRunTriggerEnum('trigger').notNull(),
    /**
     * ISO week the scheduled run belongs to (`2026-W39`). Unique per kind for
     * scheduled runs, so two API replicas cannot both run Monday's job.
     */
    weekKey: text('week_key'),
    status: insightRunStatusEnum('status').notNull().default('running'),
    requestedBy: uuid('requested_by').references(() => employees.id),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    model: text('model'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Millionths of a US dollar: the provider's figure when it gives one. */
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull().default(0),
    costSource: text('cost_source'),
    /** `AgentConsultation[]`: "O que consultei". */
    consulted: jsonb('consulted').notNull().default([]),
    /** Every tool call with arguments and result, like `agent_messages.tool_calls`. */
    toolCalls: jsonb('tool_calls').notNull().default([]),
    /** Numbers and enums only: rounds, finish reasons, tokens. */
    diagnostics: jsonb('diagnostics').notNull().default({}),
    produced: integer('produced').notNull().default(0),
    error: text('error'),
  },
  (table) => [
    index('marketing_insight_runs_kind_started_idx').on(table.kind, table.startedAt),
    uniqueIndex('marketing_insight_runs_schedule_week_uq')
      .on(table.kind, table.weekKey)
      .where(sql`trigger = 'schedule'`),
  ],
);

export const insightStatusEnum = pgEnum('marketing_insight_status', [
  'open',
  'seen',
  'requested',
  'refused',
]);

export const insights = pgTable(
  'marketing_insights',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => insightRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    /** Validated against `insightSchema` before it is stored. */
    payload: jsonb('payload').notNull(),
    campaignId: uuid('campaign_id').references(() => adCampaigns.id, { onDelete: 'set null' }),
    campaignExternalId: text('campaign_external_id'),
    status: insightStatusEnum('status').notNull().default('open'),
    actedBy: uuid('acted_by').references(() => employees.id),
    actedAt: timestamp('acted_at', { withTimezone: true }),
    /** Set only after "Criar pedido" went through the budget guard. */
    changeRequestId: uuid('change_request_id').references(() => adChangeRequests.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('marketing_insights_status_created_idx').on(table.status, table.createdAt),
    index('marketing_insights_run_idx').on(table.runId),
  ],
);

export const suggestionStatusEnum = pgEnum('marketing_suggestion_status', [
  'open',
  'applied',
  'dismissed',
]);

/** A campaign the model suggests. It only ever fills the builder; launching is a person's request. */
export const campaignSuggestions = pgTable(
  'marketing_campaign_suggestions',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => insightRuns.id, { onDelete: 'cascade' }),
    /** Validated against `campaignSuggestionSchema` before it is stored. */
    payload: jsonb('payload').notNull(),
    status: suggestionStatusEnum('status').notNull().default('open'),
    actedBy: uuid('acted_by').references(() => employees.id),
    actedAt: timestamp('acted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('marketing_campaign_suggestions_status_idx').on(table.status, table.createdAt)],
);

/**
 * The CPL (or CPC) target per objective kind that the verdicts judge against.
 * The system proposes a figure from the history; only a person's confirmation
 * fills `targetCents`. One row per tenant and kind.
 */
export const cplTargets = pgTable(
  'marketing_cpl_targets',
  {
    tenantId: tenantId(),
    /** leads | traffic */
    objectiveKind: text('objective_kind').notNull(),
    targetCents: bigint('target_cents', { mode: 'number' }),
    confirmedBy: uuid('confirmed_by').references(() => employees.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.objectiveKind] })],
);

/**
 * The CPL target of one ad account, for its leads campaigns. Takes precedence
 * over the tenant-wide target above: Meta and Google leads do not cost the
 * same, and a Google account may stay without a target until its conversions
 * are trustworthy. Like the tenant target, only a person's confirmation fills
 * `targetCents`; the screen may offer a suggestion, never apply one.
 */
export const accountCplTargets = pgTable(
  'marketing_account_cpl_targets',
  {
    tenantId: tenantId(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    /** leads, for now: traffic campaigns are judged by CTR. */
    objectiveKind: text('objective_kind').notNull(),
    targetCents: bigint('target_cents', { mode: 'number' }),
    confirmedBy: uuid('confirmed_by').references(() => employees.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.adAccountId, table.objectiveKind] })],
);

/**
 * Mirror of the published posts on Wings' own site, kept by the ingest job.
 * The dashboard reads this and never the site. The newest pull wins.
 */
export const siteBlogPosts = pgTable(
  'site_blog_posts',
  {
    tenantId: tenantId(),
    /** WordPress post id. */
    wordpressPostId: bigint('wordpress_post_id', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    slug: text('slug').notNull().default(''),
    link: text('link').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    modifiedAt: timestamp('modified_at', { withTimezone: true }),
    /** `[{ id, name }]` resolved when mirrored. */
    categories: jsonb('categories').notNull().default([]),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.wordpressPostId] }),
    index('site_blog_posts_published_idx').on(table.publishedAt),
  ],
);
