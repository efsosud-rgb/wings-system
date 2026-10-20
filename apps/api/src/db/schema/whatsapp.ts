import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, WINGS_TENANT_ID } from './ads.js';
import { clients } from './clients.js';
import { driveFiles } from './drive.js';
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
    /**
     * Whether the person lets the business call them on WhatsApp, as Meta last
     * said: no_permission | temporary | permanent (Meta's words), or
     * `requested` while our request waits for an answer.
     */
    callPermission: text('call_permission'),
    callPermissionExpiresAt: timestamp('call_permission_expires_at', { withTimezone: true }),
    callPermissionRequestedAt: timestamp('call_permission_requested_at', { withTimezone: true }),
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
    /**
     * Who has the conversation (a SofiaState): Sofia, waiting for the seller or
     * for a person of the team, with a person, or closed (docs/whatsapp/sofia.md).
     */
    attendance: text('attendance').notNull().default('with_person'),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true }),
    /** A SofiaHandoffReason or SofiaCloseReason code. */
    reason: text('reason'),
    /** What the person came for (a SofiaSegment), once known. */
    segment: text('segment'),
    /** Expansão: the brand of interest (a client), from the link, the ad or the person's answer. */
    brandClientId: uuid('brand_client_id').references(() => clients.id),
    /**
     * What Sofia found out: answers by question key, and her place in the
     * script (`step`, the question waiting for an answer). Personal data, read
     * only in the lead's access rule.
     */
    sofiaFacts: jsonb('sofia_facts').notNull().default({}),
    /** Times in a row Sofia did not understand (2 = a person takes over). */
    sofiaMisses: integer('sofia_misses').notNull().default(0),
    /** A turn is waiting: the person wrote and Sofia answers at this time (a few seconds later). */
    sofiaDueAt: timestamp('sofia_due_at', { withTimezone: true }),
    /** A server took the turn (cleared when done; an old one was cut short by a restart). */
    sofiaClaimedAt: timestamp('sofia_claimed_at', { withTimezone: true }),
    /** The person's messages up to here were already answered. */
    sofiaReadUntil: timestamp('sofia_read_until', { withTimezone: true }),
  },
  (table) => [
    index('wa_conversations_attendance_idx').on(table.attendance, table.lastMessageAt),
    index('wa_conversations_sofia_due_idx')
      .on(table.sofiaDueAt)
      .where(sql`${table.sofiaDueAt} is not null`),
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
 * A conversation brought in from a phone's "Exportar conversa" file
 * (docs/whatsapp/importar-conversa.md): one row per import, so "Desfazer"
 * removes exactly the messages it wrote. Ids, counts and times only; the
 * text lives in `wa_messages`, under the lead's access rule.
 */
export const waImportBatches = pgTable(
  'wa_import_batches',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => waConversations.id),
    /** The exported file, kept among the deal's files (its media stays inside it). */
    driveFileId: uuid('drive_file_id').references(() => driveFiles.id, { onDelete: 'set null' }),
    /** android | ios */
    platform: text('platform').notNull(),
    messageCount: integer('message_count').notNull(),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull(),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
    importedBy: uuid('imported_by').references(() => employees.id),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoneBy: uuid('undone_by').references(() => employees.id),
  },
  (table) => [index('wa_import_batches_lead_idx').on(table.leadId, table.importedAt)],
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
    /** contact | employee | sofia | system | app (sent from the phone's app, imported) */
    author: text('author').notNull(),
    employeeId: uuid('employee_id').references(() => employees.id),
    /** A WaMessageKind. */
    kind: text('kind').notNull(),
    /** Text, caption or button title: what the screen shows and search reads. */
    text: text('text'),
    /**
     * The rest, without the text: media id, type and file name; template name,
     * language and parameters; the message replied to; a reaction's target; a
     * contact card's names and numbers; a location's point, name and address.
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
    /** An imported message takes its time from the file, so the conversation keeps its order. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set on a message imported from a phone export: never Sofia's, never unread, no window. */
    importBatchId: uuid('import_batch_id').references(() => waImportBatches.id),
    /** SHA-256 of time, author, text and repeat: the same line imported again is skipped. */
    importHash: text('import_hash'),
  },
  (table) => [
    uniqueIndex('wa_messages_wamid_uq')
      .on(table.wamid)
      .where(sql`${table.wamid} is not null`),
    uniqueIndex('wa_messages_import_hash_uq')
      .on(table.leadId, table.importHash)
      .where(sql`${table.importHash} is not null`),
    index('wa_messages_import_batch_idx')
      .on(table.importBatchId)
      .where(sql`${table.importBatchId} is not null`),
    index('wa_messages_conversation_idx').on(table.conversationId, table.createdAt),
    index('wa_messages_lead_idx').on(table.leadId, table.createdAt),
    // The file queue looks only at messages that have a file.
    index('wa_messages_media_idx')
      .on(table.createdAt)
      .where(sql`(${table.content} -> 'media' ->> 'id') is not null`),
  ],
);

/**
 * A received file, copied to our storage (R2) soon after it arrives, so it
 * outlives the 30 days Meta keeps it (docs/whatsapp/cloud-api.md). The queue
 * in `media-store.ts` copies each message's file once; the screen opens it by
 * a 5-minute signed address. The file lives as long as its message, and a
 * message as long as its deal: a message deleted leaves the row without one,
 * and the queue deletes the object, then the row.
 */
export const waMessageFiles = pgTable(
  'wa_message_files',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null once the message is gone: the object is deleted next. */
    messageId: uuid('message_id').references(() => waMessages.id, { onDelete: 'set null' }),
    /** `whatsapp/2026-10/<uuid>`: made here, nothing of the person's file name. */
    storageKey: text('storage_key').notNull(),
    /** pending | stored | failed */
    status: text('status').notNull().default('pending'),
    mimeType: text('mime_type'),
    byteSize: integer('byte_size'),
    attempts: integer('attempts').notNull().default(0),
    /** Why the last copy failed (`too_large`, `media_unavailable`, a Meta code): never the person's data. */
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    storedAt: timestamp('stored_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('wa_message_files_message_uq').on(table.messageId),
    index('wa_message_files_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    index('wa_message_files_orphan_idx')
      .on(table.id)
      .where(sql`${table.messageId} is null`),
  ],
);

/**
 * When each person last opened a conversation: the WhatsApp screen counts the
 * person's messages after it as unread, for that reader only.
 */
export const waConversationReads = pgTable(
  'wa_conversation_reads',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => waConversations.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id),
    readAt: timestamp('read_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.employeeId] })],
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

/**
 * Every WhatsApp voice call, both ways (Calling API; the browser carries the
 * audio). An outgoing call is written before Meta is called and its id is
 * sent as `biz_opaque_callback_data`, so a webhook that beats Meta's answer
 * still finds it. The SDP lives here only while the call is being set up and
 * is cleared when it ends. A finished call goes on the deal once
 * (`activity_logged_at`).
 */
export const waCalls = pgTable(
  'wa_calls',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** Meta's call id (wacid...). */
    callId: text('call_id'),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => waContacts.id),
    conversationId: uuid('conversation_id').references(() => waConversations.id),
    leadId: uuid('lead_id').references(() => leads.id),
    /** in (the person called) | out (the business called) */
    direction: text('direction').notNull(),
    /** dialing | ringing | accepted | completed | rejected | missed | failed */
    status: text('status').notNull(),
    /** Who placed it, or who answered it. */
    employeeId: uuid('employee_id').references(() => employees.id),
    /** The person's SDP offer (incoming) or Meta's answer (outgoing), while setting up. */
    remoteSdp: text('remote_sdp'),
    errorCode: integer('error_code'),
    errorTitle: text('error_title'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    activityLoggedAt: timestamp('activity_logged_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('wa_calls_call_id_uq')
      .on(table.callId)
      .where(sql`${table.callId} is not null`),
    index('wa_calls_status_idx').on(table.status, table.startedAt),
    index('wa_calls_lead_idx').on(table.leadId, table.startedAt),
  ],
);

/**
 * The art of a template's header as Meta holds it (docs/whatsapp/arte-modelos.md):
 * `POST /{phone-number-id}/media` once per art and number, and the id kept with
 * the day it went up. Meta keeps an uploaded file for 30 days, so it goes up
 * again after 25, when the Drive file changed (`fileVersion`), or when Meta
 * answered a send saying the file is gone (`invalidAt`). Never retried inside
 * a send: the message that failed stays failed.
 */
export const waMediaUploads = pgTable(
  'wa_media_uploads',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    driveFileId: uuid('drive_file_id')
      .notNull()
      .references(() => driveFiles.id, { onDelete: 'cascade' }),
    fileVersion: integer('file_version').notNull(),
    phoneNumberId: text('phone_number_id').notNull(),
    mediaId: text('media_id').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull(),
    invalidAt: timestamp('invalid_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('wa_media_uploads_file_number_uq').on(
      table.tenantId,
      table.driveFileId,
      table.phoneNumberId,
    ),
    index('wa_media_uploads_media_idx').on(table.mediaId),
  ],
);

/**
 * One row per tenant: whether the official number is live (Eric, 14/10). Until the swap of the
 * number the sellers see WhatsApp as "em breve" and cannot start a conversation; an Admin Master
 * switches it on the day, on the WhatsApp screen, with no deploy. Missing row = not live.
 */
export const whatsappSettings = pgTable('whatsapp_settings', {
  tenantId: tenantId().primaryKey(),
  officialNumberLive: boolean('official_number_live').notNull().default(false),
  updatedBy: uuid('updated_by').references(() => employees.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
