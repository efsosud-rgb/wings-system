import type { AdSetPlacements } from '@wings/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  integer,
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
  'create_campaign',
  // New ads (1 to 5) in the ad set of a campaign that exists, born paused.
  'add_ads',
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
  // Nobody decided in time, or the month turned: the change expired with it.
  'expired',
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
    /**
     * When the platform's account spending limit starts over: `monthly` (on
     * the 1st), or null when nobody has said. The API does not report it —
     * Meta shows "A redefinição ocorre no primeiro dia de cada mês" only on
     * its billing screen — so it is a rule a person sets, never inferred.
     */
    spendCapReset: text('spend_cap_reset'),
    /**
     * Google only: the account's Final URL suffix, as last read ('' when it
     * has none, null when never read). Campaigns inherit it; the cockpit
     * flags one that sets its own.
     */
    finalUrlSuffix: text('final_url_suffix'),
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
    /**
     * Why the platform would not answer a number, in its own words (e.g. a
     * permission the read token lacks). Null when the platform did answer.
     */
    platformLimitNote: text('platform_limit_note'),
    /**
     * The figures behind `platformRemainingCents`, as the platform printed
     * them on the last successful read: Meta's `spend_cap` and
     * `amount_spent`, `balance` (what the next charge will take) and a
     * prepaid balance where the platform states one. Null when unread.
     */
    platformSpendCapCents: bigint('platform_spend_cap_cents', { mode: 'number' }),
    platformAmountSpentCents: bigint('platform_amount_spent_cents', { mode: 'number' }),
    platformAmountDueCents: bigint('platform_amount_due_cents', { mode: 'number' }),
    platformPrepaidBalanceCents: bigint('platform_prepaid_balance_cents', { mode: 'number' }),
    platformFundingKind: text('platform_funding_kind'),
    /**
     * The last attempt to read the platform, successful or not, and why it
     * failed. A failure after the last success means every platform figure
     * above is old and must not be shown as current.
     */
    platformReadAttemptedAt: timestamp('platform_read_attempted_at', { withTimezone: true }),
    platformReadError: text('platform_read_error'),
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
    /**
     * The platform's own objective (Meta: OUTCOME_LEADS, OUTCOME_TRAFFIC, …).
     * Null until the next ingestion fills it, and on Google, which has none.
     * It decides which number a campaign is judged by: a traffic campaign by
     * its cost per click or page view, never by leads it was not built to get.
     */
    objective: text('objective'),
    /**
     * The campaign's own schedule as the platform reports it, as São Paulo
     * days (Meta: start_time/stop_time, falling back to created_time; Google:
     * start_date/end_date). Null end: runs until someone stops it. Orders the
     * dashboard and bounds the month's forecast.
     */
    startDate: date('start_date'),
    endDate: date('end_date'),
    /**
     * Whether the platform is delivering it: Meta's effective_status, Google's
     * serving_status. `status` is what a person set; this is what happens.
     * The Cockpit counts a campaign only when it is ACTIVE (Meta) or ENABLED
     * and SERVING (Google). Null until the next ingestion reads it.
     */
    deliveryStatus: text('delivery_status'),
    /** Google only: the campaign's own Final URL suffix ('' when none, null when never read). */
    finalUrlSuffix: text('final_url_suffix'),
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
    /**
     * The last day this ad set delivers (Meta's `end_time`, in São Paulo). A
     * schedule set on the ad set never reaches the campaign's `end_date`. Null:
     * no end, or not read yet.
     */
    endDate: date('end_date'),
    /**
     * Where it delivers, as the platform reports it (Meta's `targeting`
     * publisher platforms and positions). Null: automatic placements (the
     * platform chooses), or not read yet.
     */
    placements: jsonb('placements').$type<AdSetPlacements>(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ad_sets_campaign_external_uq').on(table.campaignId, table.externalId)],
);

/**
 * The tenant's standing audience: who the ideal customer is and where to reach
 * them. One row per tenant — the minimum model. The campaign builder starts
 * from it, and every draft keeps its own copy in its payload.
 */
export const marketingAudienceProfiles = pgTable('marketing_audience_profiles', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id),
  idealCustomerProfile: text('ideal_customer_profile').notNull(),
  /** `{ states: UF[], cities: { name, state }[] }`, validated by reachSchema. */
  reach: jsonb('reach').notNull(),
  updatedBy: uuid('updated_by').references(() => employees.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only log of drafts the studio sent to Wings' own site. The content
 * itself lives in WordPress; this records that it was sent, by whom, and what
 * the site answered — `unknown` included, so nobody resends blindly.
 */
export const sitePosts = pgTable(
  'site_posts',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    outcome: text('outcome').notNull(),
    wordpressPostId: bigint('wordpress_post_id', { mode: 'number' }),
    editUrl: text('edit_url'),
    /** The site's error code or the transport reason; never the content. */
    detail: text('detail'),
    /** `[{ id, name }]` of the site's categories and tags it was sent with. */
    categories: jsonb('categories').notNull().default([]),
    tags: jsonb('tags').notNull().default([]),
    /** WordPress media id of the featured image, when there is one. */
    featuredMediaId: bigint('featured_media_id', { mode: 'number' }),
    /**
     * Everything this attempt put in the site's media library, in order:
     * `[{ role, position, uploadId, wordpressMediaId, caption, inGallery }]`.
     * Kept for a failed attempt too, so nothing uploaded goes unaccounted for.
     */
    media: jsonb('media').notNull().default([]),
    videoUrl: text('video_url'),
    /** Focus keyword, SEO title and meta description, as typed. Never sent to the site. */
    seo: jsonb('seo'),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('site_posts_created_idx').on(table.createdAt)],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Creative images uploaded in the studio.
 *
 * Kept in the database on purpose: a handful of images of a few MB each, backed
 * up with everything else, and no volume to configure on Coolify. Immutable —
 * a draft's approval hash covers the ids of its creatives, so an image an
 * approver looked at can never become a different image. Width, height and
 * type are read from the bytes on the server, never taken from the client.
 */
export const adCreativeUploads = pgTable('ad_creative_uploads', {
  tenantId: tenantId(),
  id: uuid('id').primaryKey().defaultRandom(),
  mimeType: text('mime_type').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  data: bytea('data').notNull(),
  uploadedBy: uuid('uploaded_by').references(() => employees.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Videos for ads. Too large for a column (Meta takes up to 4 GB), so the bytes
 * live on a mounted volume and this row says where, how big and what hash.
 * Like images, a video under an id never changes.
 */
export const adVideoUploads = pgTable('ad_video_uploads', {
  tenantId: tenantId(),
  id: uuid('id').primaryKey().defaultRandom(),
  mimeType: text('mime_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  /** File name inside CREATIVE_VIDEO_DIR — never a path a client supplied. */
  storageKey: text('storage_key').notNull(),
  uploadedBy: uuid('uploaded_by').references(() => employees.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Wings' standard lead form as it was created on a platform (Meta's instant
 * form on the Page), so the same form is created once and used again: the
 * `fingerprint` is the sha-256 of `leadFormFingerprint` (questions, policy
 * and thank-you, not the funnel). `spec` is the shared `LeadForm` as approved;
 * `external_id` is the platform's id, null while the form was not created.
 * The lead's funnel is not here: it is a `lead_source_rules` row on the
 * form's id, written together with it (`registerLeadFormIntake`).
 */
export const adLeadForms = pgTable(
  'ad_lead_forms',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** meta */
    platform: text('platform').notNull(),
    /** The Facebook Page the form belongs to. */
    pageId: text('page_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    spec: jsonb('spec').notNull(),
    name: text('name').notNull(),
    externalId: text('external_id'),
    /** The execution that created it, for the trail. */
    executionId: uuid('execution_id').references(() => adExecutions.id),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ad_lead_forms_page_fingerprint_idx').on(table.pageId, table.fingerprint)],
);

/**
 * A video on its way up, in parts. One request per part keeps every request
 * short (a proxy's read timeout, Node's request timeout) and moves the bar on
 * screen. The bytes accumulate in `<storage_key>.part` on the volume; once
 * every part is in and the bytes say "video", the file is renamed and a row
 * goes into `ad_video_uploads`. A session nobody finishes expires in a day.
 */
export const adVideoUploadSessions = pgTable('ad_video_upload_sessions', {
  tenantId: tenantId(),
  id: uuid('id').primaryKey().defaultRandom(),
  mimeType: text('mime_type').notNull(),
  byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
  partSize: integer('part_size').notNull(),
  receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
  nextPart: integer('next_part').notNull().default(1),
  /** File name inside CREATIVE_VIDEO_DIR (without `.part`) — never a client's name. */
  storageKey: text('storage_key').notNull(),
  uploadedBy: uuid('uploaded_by').references(() => employees.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/**
 * Wings' standing choice of Facebook Page and Instagram account to advertise
 * as. One row per tenant; every request still carries its own copy.
 */
export const marketingMetaDefaults = pgTable('marketing_meta_defaults', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id),
  pageId: text('page_id').notNull(),
  instagramActorId: text('instagram_actor_id'),
  updatedBy: uuid('updated_by').references(() => employees.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Images for posts on Wings' own site, held here until the draft is sent.
 *
 * The same idea as ad creatives, with the site's rules (WebP allowed, 5 MB).
 * They reach WordPress only when the operator sends the draft. Once one has
 * been uploaded there, its media id is remembered, so a retry after a failure
 * halfway reuses it instead of filling the site's library with duplicates.
 */
export const siteMediaUploads = pgTable('site_media_uploads', {
  tenantId: tenantId(),
  id: uuid('id').primaryKey().defaultRandom(),
  mimeType: text('mime_type').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  byteSize: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  data: bytea('data').notNull(),
  wordpressMediaId: bigint('wordpress_media_id', { mode: 'number' }),
  wordpressSourceUrl: text('wordpress_source_url'),
  uploadedBy: uuid('uploaded_by').references(() => employees.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A campaign somebody built in the studio and asked to have created.
 *
 * Immutable once written: the approval is bound to a hash over `payload`, so
 * there is no update path — a different campaign is a different draft and a
 * different request. `campaignId` is filled in when the executor creates the
 * campaign on the platform, and never before.
 */
export const adCampaignDrafts = pgTable(
  'ad_campaign_drafts',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    name: text('name').notNull(),
    /** Ours (lead, traffic, conversion); mapped to the platform's at the boundary. */
    objective: text('objective').notNull(),
    dailyBudgetCents: bigint('daily_budget_cents', { mode: 'number' }).notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    /** Born paused: never delivers until a separate, separately approved resume. */
    startPaused: boolean('start_paused').notNull().default(true),
    /** The whole validated form, exactly as it was submitted. */
    payload: jsonb('payload').notNull(),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    campaignId: uuid('campaign_id').references(() => adCampaigns.id),
  },
  (table) => [index('ad_campaign_drafts_account_idx').on(table.adAccountId, table.createdAt)],
);

/**
 * A campaign the builder saved to come back to: the whole form, validated by
 * `campaignDraftSchema`, and nothing else. Saving asks for no approval and
 * reserves no budget; loading one only fills the builder. A request made from
 * it is stored in `ad_campaign_drafts` like any other, so nothing here is ever
 * bound to an approval or a hash.
 */
export const adCampaignSavedDrafts = pgTable(
  'ad_campaign_saved_drafts',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** meta | google_search | youtube, as the form's platform. */
    platform: text('platform').notNull(),
    payload: jsonb('payload').notNull(),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ad_campaign_saved_drafts_updated_idx').on(table.updatedAt)],
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
    /**
     * Null only for `create_campaign`, where the campaign does not exist yet
     * and `draftId` says what is being asked for. The migration's CHECK
     * guarantees one of the two is always present.
     */
    campaignId: uuid('campaign_id').references(() => adCampaigns.id),
    draftId: uuid('draft_id').references(() => adCampaignDrafts.id),
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
    /**
     * What exactly was asked, for a change that is more than a number
     * (`add_ads`: the ad set and the creatives). The approval hash covers it.
     */
    payload: jsonb('payload'),
    status: changeStatusEnum('status').notNull().default('pending_approval'),
    /** Null when proposed by the agent rather than a person. */
    requestedBy: uuid('requested_by').references(() => employees.id),
    requestedByAgent: boolean('requested_by_agent').notNull().default(false),
    /**
     * True when a person created this request from a card the traffic agent
     * proposed. The request is still that person's (`requestedBy`), and
     * `requestedByAgent` stays false: the agent has no way to ask for anything.
     */
    suggestedByAgent: boolean('suggested_by_agent').notNull().default(false),
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

/**
 * What one execution made on the platform, object by object, in order.
 *
 * Creating a campaign with its ad set and ads is several writes. If one fails
 * in the middle, this is the record of what already exists out there — written
 * after each write, so a crash loses at most the step in flight.
 */
export const adExecutionSteps = pgTable(
  'ad_execution_steps',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    executionId: uuid('execution_id')
      .notNull()
      .references(() => adExecutions.id),
    seq: integer('seq').notNull(),
    /** campaign | image | video | ad_set | creative | ad */
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    /** created | failed | unknown */
    status: text('status').notNull(),
    externalId: text('external_id'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ad_execution_steps_execution_seq_uq').on(table.executionId, table.seq)],
);

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
    /** The utm_content its creative's link carries (video-1, imagem-2…); null when none. */
    utmContent: text('utm_content'),
    /** Meta: its creative's url_tags ('' when none, null when never read). */
    urlTags: text('url_tags'),
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
    /**
     * image | video | carousel | unknown, read from the creative's object type
     * and story spec. Unknown when the platform did not say, never guessed
     * from the name: the creative ranking groups by this.
     */
    format: text('format').notNull().default('unknown'),
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
    /**
     * Video, when the platform reports it: plays of 3 seconds or more (Meta's
     * `video_view` action), ThruPlays and the four watched quartiles. Zero on
     * an image ad and on a platform that does not report them.
     */
    videoPlays: bigint('video_plays', { mode: 'number' }).notNull().default(0),
    videoThruplays: bigint('video_thruplays', { mode: 'number' }).notNull().default(0),
    videoP25: bigint('video_p25', { mode: 'number' }).notNull().default(0),
    videoP50: bigint('video_p50', { mode: 'number' }).notNull().default(0),
    videoP75: bigint('video_p75', { mode: 'number' }).notNull().default(0),
    videoP100: bigint('video_p100', { mode: 'number' }).notNull().default(0),
    /** Every start of the video, and the total milliseconds watched (Meta's average × starts). */
    videoStarts: bigint('video_starts', { mode: 'number' }).notNull().default(0),
    videoWatchMs: bigint('video_watch_ms', { mode: 'number' }).notNull().default(0),
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
    // The dashboard reads one level of one account over a date range; this is
    // the index every one of its sums walks.
    index('ad_metrics_daily_account_level_day_idx').on(table.adAccountId, table.level, table.day),
  ],
);

/** How a day's figures are split: by placement, age and gender, region, hour. */
export const breakdownKindEnum = pgEnum('ad_breakdown_kind', [
  'placement',
  'age_gender',
  'region',
  'hour',
  'device',
]);

/**
 * Daily performance split one way at a time, per campaign.
 *
 * Campaign level only, on purpose: a breakdown multiplies the platform's
 * aggregation work, and the ad level already needs one-day windows to answer
 * at all (`INSIGHT_WINDOW_DAYS`). Same upsert rule as `ad_metrics_daily`: the
 * newest pull wins. `key` and `sub_key` carry the split as the platform names
 * it (`facebook`/`feed`, `25-34`/`female`, `São Paulo`/``, `14`/``).
 */
export const adMetricsBreakdownDaily = pgTable(
  'ad_metrics_breakdown_daily',
  {
    tenantId: tenantId(),
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    campaignId: uuid('campaign_id').references(() => adCampaigns.id, { onDelete: 'cascade' }),
    campaignExternalId: text('campaign_external_id').notNull(),
    day: date('day').notNull(),
    kind: breakdownKindEnum('kind').notNull(),
    key: text('key').notNull(),
    subKey: text('sub_key').notNull().default(''),
    spendCents: bigint('spend_cents', { mode: 'number' }).notNull().default(0),
    impressions: bigint('impressions', { mode: 'number' }).notNull().default(0),
    clicks: bigint('clicks', { mode: 'number' }).notNull().default(0),
    /** Zero where the platform refuses reach for the split (Meta by hour). */
    reach: bigint('reach', { mode: 'number' }).notNull().default(0),
    conversions: bigint('conversions', { mode: 'number' }).notNull().default(0),
    actions: jsonb('actions').notNull().default({}),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ad_metrics_breakdown_daily_uq').on(
      table.adAccountId,
      table.campaignExternalId,
      table.day,
      table.kind,
      table.key,
      table.subKey,
    ),
    index('ad_metrics_breakdown_daily_account_kind_day_idx').on(
      table.adAccountId,
      table.kind,
      table.day,
    ),
  ],
);

/**
 * One row per account per day: what the platform said about the account
 * itself when the ingest ran, and the budget in force that day.
 *
 * The platform only ever reports its CURRENT balance and cap, so without this
 * the question "how much was there on the 10th?" has no answer after the 11th.
 * The newest pull of a day wins; a closed day is never rewritten because the
 * job does not run for past days.
 */
export const adAccountDaily = pgTable(
  'ad_account_daily',
  {
    tenantId: tenantId(),
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    adAccountId: uuid('ad_account_id')
      .notNull()
      .references(() => adAccounts.id),
    day: date('day').notNull(),
    /** Meta: spend_cap; Google: the approved account budget. Null when the platform sets none. */
    spendCapCents: bigint('spend_cap_cents', { mode: 'number' }),
    /** Meta: amount_spent against the cap; Google: amount served against the budget. */
    amountSpentCents: bigint('amount_spent_cents', { mode: 'number' }),
    /** What the account can still spend as the platform sees it; null when unlimited. */
    platformRemainingCents: bigint('platform_remaining_cents', { mode: 'number' }),
    /** Meta: the prepaid balance when the account has one (`funding_source_details`). */
    prepaidBalanceCents: bigint('prepaid_balance_cents', { mode: 'number' }),
    /** A code, never the display string: `prepaid`, `credit_card`, `unknown`. */
    fundingKind: text('funding_kind'),
    /** Sum of daily budgets in force on active campaigns (their ad sets for ABO), today. */
    activeDailyBudgetCents: bigint('active_daily_budget_cents', { mode: 'number' })
      .notNull()
      .default(0),
    /**
     * What the platform says about its conversion measurement, read once a
     * day: Meta's pixel (`last_fired_time`), Google's conversion actions and
     * their status. `[{ id, name, status: 'active' | 'inactive' | 'unknown',
     * lastEventAt }]`; null when the read failed or the platform has none.
     * NOT verified live on either platform.
     */
    conversionSources: jsonb('conversion_sources'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ad_account_daily_account_day_uq').on(table.adAccountId, table.day)],
);

export const alertKindEnum = pgEnum('ad_alert_kind', [
  'ad_rejected',
  'budget_pacing',
  'creative_fatigue',
  'quality_below_average',
  'conversion_silence',
  'meta_ad_without_utms',
  'google_campaign_own_suffix',
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
