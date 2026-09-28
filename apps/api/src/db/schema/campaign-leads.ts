import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { adAds, adCampaigns, tenants, WINGS_TENANT_ID } from './ads.js';
import { employees } from './employees.js';

/**
 * Leads das Campanhas (docs/dashboard-marketing.md): the RD CRM deals of the
 * Formatação funnel created since 28/09/2026, with the campaign and ad they
 * came from. Unlike `rd_crm_deals` this table holds personal data, on
 * purpose and approved: the contact's name in text (the list shows it), the
 * e-mail and phone only encrypted (AES-256-GCM under CPF_ENCRYPTION_KEY) plus
 * a mask; a reveal is audited. Nothing here is ever logged. Read only from
 * RD: the sync never writes back.
 */

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

export const campaignLeads = pgTable(
  'campaign_leads',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    rdDealId: text('rd_deal_id').notNull().unique(),
    enteredAt: timestamp('entered_at', { withTimezone: true }).notNull(),
    pipeline: text('pipeline').notNull(),
    stage: text('stage').notNull(),
    stageOrder: integer('stage_order').notNull(),
    win: boolean('win'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lostReason: text('lost_reason'),
    /** A test deal: out of the list and of every figure, counted apart. */
    isTest: boolean('is_test').notNull().default(false),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),

    name: text('name'),
    company: text('company'),
    segment: text('segment'),
    city: text('city'),
    emailEncrypted: text('email_encrypted'),
    phoneEncrypted: text('phone_encrypted'),
    emailMasked: text('email_masked'),
    phoneMasked: text('phone_masked'),

    /** The deal's owner in RD, and the employee with the same e-mail (scopes a salesperson to their own). */
    ownerRdId: text('owner_rd_id'),
    ownerName: text('owner_name'),
    ownerEmployeeId: uuid('owner_employee_id').references(() => employees.id),

    rating: integer('rating'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),

    rdSourceLabel: text('rd_source_label'),
    rdCampaignLabel: text('rd_campaign_label'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    utmContent: text('utm_content'),
    /** When RD Marketing was asked for the conversion's UTMs (asked once per lead). */
    utmCheckedAt: timestamp('utm_checked_at', { withTimezone: true }),
    platform: text('platform'),
    campaignId: uuid('campaign_id').references(() => adCampaigns.id),
    adId: uuid('ad_id').references(() => adAds.id),
    /** utm | rd_origin; null with `unattributedReason` set. */
    attribution: text('attribution'),
    unattributedReason: text('unattributed_reason'),

    /** First contact: the earliest note/task in RD, or the stage leaving "Sem contato" as the sync saw it. */
    firstContactAt: timestamp('first_contact_at', { withTimezone: true }),
    firstContactSource: text('first_contact_source'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('campaign_leads_entered_idx').on(table.enteredAt),
    index('campaign_leads_owner_idx').on(table.ownerEmployeeId),
  ],
);
