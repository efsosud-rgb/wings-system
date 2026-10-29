import type { WaFieldSpec } from '@wings/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
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
    /**
     * A person's work number the chat is on (docs/whatsapp/central.md): one chat per contact per
     * number, as on the phone, never Sofia's. Null is the official number.
     */
    numberId: uuid('number_id').references(() => waNumbers.id),
    /** The name the number's owner saved for the person in the phone (`smb_app_state_sync`). */
    phoneContactName: text('phone_contact_name'),
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
    /** A person paused Sofia in this conversation: she never takes it until someone turns her on. */
    sofiaPaused: boolean('sofia_paused').notNull().default(false),
    /**
     * Who answers it (docs/whatsapp/central.md, "Atendimento"). Null: the deal's owner holds it on
     * the official number, the number's owner on a work number; with neither, it waits in its queue.
     */
    assigneeEmployeeId: uuid('assignee_employee_id').references(() => employees.id),
    /** The department (a SectorSlug) whose queue it waits in; null: the number's, or none. */
    queue: text('queue'),
    /** Moves on every change of hands: an action made on an older one is refused (compare-and-set). */
    version: integer('version').notNull().default(0),
    /** "Outra pessoa está respondendo": who is typing and until when (renewed while they type). */
    replyingEmployeeId: uuid('replying_employee_id').references(() => employees.id),
    replyingUntil: timestamp('replying_until', { withTimezone: true }),
  },
  (table) => [
    index('wa_conversations_attendance_idx').on(table.attendance, table.lastMessageAt),
    index('wa_conversations_assignee_idx').on(table.assigneeEmployeeId),
    index('wa_conversations_sofia_due_idx')
      .on(table.sofiaDueAt)
      .where(sql`${table.sofiaDueAt} is not null`),
    uniqueIndex('wa_conversations_contact_lead_uq')
      .on(table.contactId, table.leadId)
      .where(sql`${table.leadId} is not null and ${table.numberId} is null`),
    uniqueIndex('wa_conversations_contact_unmatched_uq')
      .on(table.contactId)
      .where(sql`${table.leadId} is null and ${table.numberId} is null`),
    uniqueIndex('wa_conversations_number_contact_uq')
      .on(table.numberId, table.contactId)
      .where(sql`${table.numberId} is not null`),
    index('wa_conversations_lead_idx').on(table.leadId),
    index('wa_conversations_last_idx').on(table.lastMessageAt),
  ],
);

/**
 * The history of who had a conversation (docs/whatsapp/central.md, "Atendimento"): every take,
 * transfer, queue, resolve, reopen, and Sofia's pauses and handovers, with who did it (null: the
 * system or Sofia). Append-only; ids and codes, never the person's data.
 */
export const waConversationEvents = pgTable(
  'wa_conversation_events',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => waConversations.id),
    /** A WaConversationEventKind. */
    kind: text('kind').notNull(),
    fromEmployeeId: uuid('from_employee_id').references(() => employees.id),
    toEmployeeId: uuid('to_employee_id').references(() => employees.id),
    queue: text('queue'),
    /** A code (a SofiaHandoffReason, `sofia_pausada`...), never free text. */
    reason: text('reason'),
    actorEmployeeId: uuid('actor_employee_id').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('wa_conversation_events_conversation_idx').on(table.conversationId, table.createdAt),
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
 * "Importar em lote" (docs/whatsapp/importar-conversa.md): the lote-pai of many conversations. The
 * name→phone map lives here only until the lote is written or undone, then it is cleared.
 */
export const waBulkImports = pgTable('wa_bulk_imports', {
  tenantId: tenantId(),
  id: uuid('id').primaryKey().defaultRandom(),
  /** tela | cli */
  source: text('source').notNull(),
  /** previa | gravando | gravado | desfeito */
  state: text('state').notNull().default('previa'),
  ourName: text('our_name'),
  nameMap: jsonb('name_map').$type<Record<string, string>>(),
  createdBy: uuid('created_by').references(() => employees.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
  undoneBy: uuid('undone_by').references(() => employees.id),
});

/**
 * One conversation of a lote: its pair, its counts and, once written, its own import
 * (`wa_import_batches`). `chat_text` waits here between the preview and the write, then is cleared:
 * the messages live in `wa_messages`.
 */
export const waBulkImportItems = pgTable(
  'wa_bulk_import_items',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    bulkId: uuid('bulk_id')
      .notNull()
      .references(() => waBulkImports.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    fileName: text('file_name').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    chatText: text('chat_text'),
    platform: text('platform'),
    contactName: text('contact_name'),
    participants: jsonb('participants')
      .$type<{ name: string; messages: number }[]>()
      .notNull()
      .default([]),
    leadId: uuid('lead_id').references(() => leads.id),
    /** telefone | mapa | nome | manual */
    match: text('match'),
    candidates: integer('candidates').notNull().default(0),
    messageCount: integer('message_count').notNull().default(0),
    newCount: integer('new_count').notNull().default(0),
    firstAt: timestamp('first_at', { withTimezone: true }),
    lastAt: timestamp('last_at', { withTimezone: true }),
    /** pendente | pulada | gravada | sem_novas | falhou | desfeita */
    state: text('state').notNull().default('pendente'),
    error: text('error'),
    batchId: uuid('batch_id').references(() => waImportBatches.id),
    driveFileId: uuid('drive_file_id').references(() => driveFiles.id, { onDelete: 'set null' }),
  },
  (table) => [uniqueIndex('wa_bulk_import_items_position_uq').on(table.bulkId, table.position)],
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
    /** A failed try waits longer each time (`intake.ts`). */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
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
    /** Meta's reason when it refused the template (NONE otherwise). */
    rejectedReason: text('rejected_reason'),
    components: jsonb('components').notNull().default([]),
    /** What fills each {{n}} and its fallback, set on the Modelos screen; null = the system's own list. */
    fields: jsonb('fields').$type<WaFieldSpec[]>(),
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
  /**
   * Who gets a conversation nobody holds (a WaAssignmentMode): `manual`, it waits in its queue for
   * a person to take it; `rodizio`, the funnel's rotation (`crm_distribution_members`) picks.
   */
  assignmentMode: text('assignment_mode').notNull().default('manual'),
  updatedBy: uuid('updated_by').references(() => employees.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The company's work numbers (docs/whatsapp/central.md, conectar-numero.md): an Admin Master
 * registers each one (owner, department, the phone checks), then connects it by coexistence. One
 * row per number, each with its own WABA and business portfolio: nothing assumes one portfolio for
 * all. Meta's ids, the token and `connected_at` stay null until the connection. `token_enc` is the
 * business token Meta gave, sealed by `secret-box.ts` under INTEGRATIONS_ENCRYPTION_KEY; it is
 * never sent to the browser, never logged, and this table is not granted to `wings_ro`.
 */
export const waNumbers = pgTable(
  'wa_numbers',
  {
    tenantId: tenantId(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** The number as registered: 55 + DDD + number, digits only. */
    phone: text('phone'),
    /** A name for it on the screens ("Comercial Expansão"). */
    label: text('label'),
    /** Its department, a SectorSlug. */
    sector: text('sector'),
    /** a_confirmar | confirmado | inelegivel (WaNumberEligibility). */
    eligibility: text('eligibility').notNull().default('a_confirmar'),
    eligibilityNotes: text('eligibility_notes'),
    /** The phone checks done so far (WA_NUMBER_CHECKS keys). */
    checks: text('checks')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    phoneNumberId: text('phone_number_id'),
    wabaId: text('waba_id'),
    businessId: text('business_id'),
    displayPhone: text('display_phone'),
    verifiedName: text('verified_name'),
    ownerEmployeeId: uuid('owner_employee_id')
      .notNull()
      .references(() => employees.id),
    tokenEnc: text('token_enc'),
    /** When Meta said the token ends (`expires_in` of the exchange); null: Meta gave no end. */
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    /** registered | connected | disconnected */
    status: text('status').notNull().default('registered'),
    connectedBy: uuid('connected_by').references(() => employees.id),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    /** Meta's event and reason when the number left: a code, never a message. */
    disconnectReason: text('disconnect_reason'),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    webhooksSubscribed: boolean('webhooks_subscribed').notNull().default(false),
    /** The two syncs Meta allows once per connection: requested | failed | unknown, and Meta's id. */
    contactsSync: text('contacts_sync'),
    contactsSyncRequest: text('contacts_sync_request'),
    historySync: text('history_sync'),
    historySyncRequest: text('history_sync_request'),
    /** 0–100, the highest Meta reported in a `history` webhook. */
    historyProgress: integer('history_progress'),
    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('wa_numbers_phone_number_uq').on(table.tenantId, table.phoneNumberId),
    uniqueIndex('wa_numbers_phone_uq')
      .on(table.tenantId, table.phone)
      .where(sql`${table.phone} is not null`),
    index('wa_numbers_waba_idx').on(table.wabaId),
  ],
);
