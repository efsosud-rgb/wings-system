import { sql } from 'drizzle-orm';
import {
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
import { employees } from './employees.js';
import { leads } from './leads.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(WINGS_TENANT_ID)
    .references(() => tenants.id);

/**
 * The official WhatsApp (Cloud API) in the CRM (docs/whatsapp/cloud-api.md),
 * after Eric's model of 04/10 (docs/whatsapp/estrutura-dados.md) with the
 * project's English names. Phones and message text are personal data: these
 * tables are read only through the lead's access rule (`leadInScope` with
 * `leads.whatsapp`), never granted to `wings_ro`, and never logged.
 */

/**
 * Who writes to the Wings number, one row per phone. The 24-hour window is
 * Meta's rule per phone (not per deal): it opens on the person's last
 * message, so it lives here.
 */
export const waContacts = pgTable(
  'wa_contacts',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** Digits only, 55 + DDD + number, in the same form as `leads.phone`. */
    phone: text('phone').notNull(),
    /** The id Meta gives the person (their number as WhatsApp knows it; may lack the 9th digit). */
    waId: text('wa_id'),
    /** The name on the person's WhatsApp profile. */
    profileName: text('profile_name'),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    /** The person asked not to receive messages: only replies inside the window go out. */
    optOutAt: timestamp('opt_out_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('wa_contacts_phone_uq').on(table.tenantId, table.phone),
    index('wa_contacts_wa_id_idx').on(table.waId),
  ],
);

/**
 * One conversation per phone and deal (Eric's "atendimento"): a message from
 * the person goes to the most recent open deal of that phone. Without one it
 * waits in a conversation with no deal, which only a full-scope reader sees.
 */
export const waConversations = pgTable(
  'wa_conversations',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => waContacts.id),
    leadId: uuid('lead_id').references(() => leads.id),
    /** open | closed */
    status: text('status').notNull().default('open'),
    /** The ad the person came from (`referral` of the first message), ids and texts of the ad only. */
    referral: jsonb('referral'),
    /** The tracking code the first message started with, when there was one. */
    originCode: text('origin_code'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('wa_conversations_contact_lead_uq')
      .on(table.contactId, table.leadId)
      .where(sql`${table.leadId} is not null`),
    uniqueIndex('wa_conversations_contact_unmatched_uq')
      .on(table.contactId)
      .where(sql`${table.leadId} is null`),
    index('wa_conversations_lead_idx').on(table.leadId),
    index('wa_conversations_last_idx').on(table.lastMessageAt),
  ],
);

/**
 * Every message, both ways. An outgoing one is written before Meta is called
 * (status `pending`) and sent once, never retried; `wamid` arrives with
 * Meta's answer. Status only moves forward (`waStatusAdvances`), so a
 * status that arrives late never moves a message back.
 */
export const waMessages = pgTable(
  'wa_messages',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** Meta's message id. Unique: a re-sent webhook is the same message. */
    wamid: text('wamid'),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => waConversations.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => waContacts.id),
    /** The conversation's deal, copied for the deal's queries. */
    leadId: uuid('lead_id').references(() => leads.id),
    /** in | out */
    direction: text('direction').notNull(),
    /** contact | employee | system */
    author: text('author').notNull(),
    employeeId: uuid('employee_id').references(() => employees.id),
    /** A WaMessageKind. */
    kind: text('kind').notNull(),
    /** Text, caption or button title: what the screen shows and search reads. */
    text: text('text'),
    /**
     * The rest, without the text: media id, type and file name; template name,
     * language and parameters; the message replied to; a reaction's target.
     * Never a media URL (they carry Meta's signature and expire).
     */
    content: jsonb('content').notNull().default({}),
    /** Outgoing only: a WaMessageStatus. */
    status: text('status'),
    errorCode: integer('error_code'),
    /** Meta's error title (a category such as "Re-engagement message"), never the person's data. */
    errorTitle: text('error_title'),
    /** When Meta says the message was sent or received. */
    waTimestamp: timestamp('wa_timestamp', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('wa_messages_wamid_uq')
      .on(table.wamid)
      .where(sql`${table.wamid} is not null`),
    index('wa_messages_conversation_idx').on(table.conversationId, table.createdAt),
    index('wa_messages_lead_idx').on(table.leadId, table.createdAt),
  ],
);

/**
 * Every webhook call Meta made, as it came (it carries phones and texts):
 * stored before the 200, processed by the queue (`whatsapp/intake.ts`), the
 * payload cleared after 90 days.
 */
export const waWebhookEvents = pgTable(
  'wa_webhook_events',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb('payload'),
    /** pending | done | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** A code (bad_payload, db_error, ...), never text about the person. */
    lastError: text('last_error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    index('wa_webhook_events_status_idx').on(table.status, table.receivedAt),
    index('wa_webhook_events_received_idx').on(table.receivedAt),
  ],
);

/** The message templates of the WhatsApp account, as read from Meta (the list is Meta's). */
export const waTemplates = pgTable(
  'wa_templates',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    metaId: text('meta_id'),
    name: text('name').notNull(),
    language: text('language').notNull(),
    /** MARKETING | UTILITY | AUTHENTICATION */
    category: text('category'),
    /** APPROVED | PENDING | REJECTED | PAUSED | DISABLED ... as Meta says. */
    status: text('status').notNull(),
    components: jsonb('components').notNull().default([]),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('wa_templates_name_lang_uq').on(table.tenantId, table.name, table.language),
  ],
);
