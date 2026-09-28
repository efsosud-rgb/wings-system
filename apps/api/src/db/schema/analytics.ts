import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';

/**
 * Dashboard → Marketing, part 3: what happens after the click. The site's
 * sessions by source and campaign (GA4) and a thin copy of the RD Station CRM
 * deals, so a campaign can be followed from impression to sale.
 *
 * Neither table holds personal data: GA4 answers aggregates only, and the RD
 * copy keeps ids, stages, dates and the source/campaign labels, never a deal's
 * title, a contact's name, e-mail or phone.
 */

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/** One day of sessions for one source / medium / campaign, as GA4 reports it. */
export const ga4TrafficDaily = pgTable(
  'ga4_traffic_daily',
  {
    tenantId: tenantId(),
    propertyId: text('property_id').notNull(),
    day: date('day').notNull(),
    source: text('source').notNull(),
    medium: text('medium').notNull(),
    /** sessionCampaignName: the utm_campaign, or the Google Ads campaign name when auto-tagged. */
    campaign: text('campaign').notNull(),
    sessions: integer('sessions').notNull().default(0),
    engagedSessions: integer('engaged_sessions').notNull().default(0),
    /** userEngagementDuration, whole seconds. */
    engagementSeconds: bigint('engagement_seconds', { mode: 'number' }).notNull().default(0),
    pageViews: integer('page_views').notNull().default(0),
    /** keyEvents (GA4's conversions), rounded to whole events. */
    keyEvents: integer('key_events').notNull().default(0),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.propertyId, table.day, table.source, table.medium, table.campaign],
    }),
  ],
);

/**
 * RD Station CRM deals, the minimum a funnel needs: where the deal is now, if
 * it was won, and the source and campaign labels RD gave it. RD keeps no
 * history of stages, so "reached a meeting" is read from the current stage.
 */
export const rdCrmDeals = pgTable(
  'rd_crm_deals',
  {
    tenantId: tenantId(),
    rdId: text('rd_id').primaryKey(),
    pipeline: text('pipeline').notNull(),
    stage: text('stage').notNull(),
    /** Position of the stage in its pipeline (1-based) and how many the pipeline has. */
    stageOrder: integer('stage_order').notNull(),
    /** The stage passed a meeting ("Reunião realizada" or later), or the deal was won. */
    reachedMeeting: boolean('reached_meeting').notNull().default(false),
    /** true won, false lost, null open. */
    win: boolean('win'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** RD's deal source ("Busca Paga | Facebook Ads") and campaign ("META ADS"): labels, not people. */
    sourceLabel: text('source_label'),
    campaignLabel: text('campaign_label'),
    /** meta | google | null: the paid platform the labels point at, when they do. */
    platform: text('platform'),
    /** RD's lost reason, a label ("Sem interesse"); never free text about a person. */
    lostReason: text('lost_reason'),
    /** A test deal (lost reason or title says "teste"): counted in no figure. */
    isTest: boolean('is_test').notNull().default(false),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('rd_crm_deals_created_idx').on(table.createdAt)],
);
