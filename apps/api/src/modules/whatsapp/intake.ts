import {
  brazilianPhoneVariants,
  canonicalWhatsAppPhone,
  normalizeBrazilianPhone,
  trackingCodeOf,
  waStatusAdvances,
  type WaMessageStatus,
} from '@wings/shared';
import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  crmContacts,
  leadContacts,
  leadEvents,
  leadTasks,
  leadTrackingLinks,
  leads,
  sofiaAiRuns,
  waCalls,
  waContacts,
  waConversations,
  waMessages,
  waTemplates,
  waWebhookEvents,
} from '../../db/schema/index.js';
import { addActivity } from '../leads/activities.js';
import { leadByFormRef } from '../leads/form-ref.js';
import { trackingLinkByCode } from '../leads/service.js';
import { leadFromTrackedMessage } from '../leads/tracked-link.js';
import { enqueueTriage } from '../leads/triage-queue.js';
import { leadTriageEnabled, scheduleLeadTriage } from '../leads/triage-schedule.js';
import { formContextOf } from '../sofia/form-context.js';
import { loadSofiaSettings } from '../sofia/settings.js';
import { factsOf, routeInbound } from '../sofia/state.js';
import { ART_MEDIA_GONE_CODES, invalidateArtMedia } from './art.js';
import { notifyCallsChanged } from './call-signal.js';
import { callingOn } from './calling.js';
import { callPermissionPayload, type WhatsAppConfig } from './graph.js';
import { officialNumberLive } from './official-number.js';
import { deliverWhatsApp, type Contact } from './outbox.js';
import { brandOf, callPermissionText, permissionOf } from './thread.js';
import { applyNumberChange, isSellerNumberChange } from './numbers.js';
import {
  isOptOut,
  whatsappChangesOf,
  type WaCallEvent,
  type WaCallStatusUpdate,
  type WaInboundMessage,
  type WaStatusUpdate,
  type WaTemplateUpdate,
} from './webhook-parse.js';

/**
 * The WhatsApp webhook queue. The route stores Meta's body and answers 200 at
 * once; this loop reads each stored body: messages go to the deal of the
 * phone, statuses move messages forward, template reviews update the list.
 * Every step is safe to repeat — Meta re-sends for days, and a message id
 * already stored is the same message — so a crash halfway is only retried.
 */

export const WHATSAPP_JOB = 'whatsapp_intake';
const MAX_ATTEMPTS = 5;
const PAYLOAD_DAYS = 90;

export async function storeWhatsAppEvent(db: Database, payload: unknown): Promise<string> {
  const [row] = await db
    .insert(waWebhookEvents)
    .values({ payload: payload as object })
    .returning({ id: waWebhookEvents.id });
  return row!.id;
}

export interface WhatsAppIntakeDeps {
  db: Database;
  /** Our number. A change for another number of the same app is skipped. */
  phoneNumberId: string | null;
  /** Our number's WABA: its changes are never mistaken for a seller's number. */
  wabaId?: string | null;
  log: (facts: Record<string, unknown>) => void;
  now?: () => Date;
  /** How Meta's call-permission request answers a "Prefiro uma ligação"; absent, the owner's task only. */
  send?: { config: WhatsAppConfig; fetch: typeof fetch } | null;
}

export interface WhatsAppIntakeResult {
  processed: number;
  done: number;
  retried: number;
  failed: number;
}

export async function processWhatsAppEvents(
  deps: WhatsAppIntakeDeps & { limit?: number },
): Promise<WhatsAppIntakeResult> {
  const { db } = deps;
  const now = () => deps.now?.() ?? new Date();
  const result: WhatsAppIntakeResult = { processed: 0, done: 0, retried: 0, failed: 0 };
  // A body left half-way by a stopped server goes back to the queue.
  await db
    .update(waWebhookEvents)
    .set({ status: 'pending' })
    .where(
      and(
        eq(waWebhookEvents.status, 'processing'),
        lt(waWebhookEvents.receivedAt, new Date(now().getTime() - 10 * 60_000)),
      ),
    );
  for (let i = 0; i < (deps.limit ?? 100); i++) {
    const claimed = await db.execute<{ id: string; payload: unknown; attempts: number }>(sql`
      update wa_webhook_events set status = 'processing', attempts = attempts + 1
      where id = (
        select id from wa_webhook_events where status = 'pending'
        order by received_at limit 1 for update skip locked
      )
      returning id, payload, attempts`);
    const event = claimed.rows[0];
    if (!event) break;
    result.processed++;
    try {
      await applyWhatsAppPayload(deps, event.payload);
      await db
        .update(waWebhookEvents)
        .set({ status: 'done', processedAt: now(), lastError: null })
        .where(eq(waWebhookEvents.id, event.id));
      result.done++;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? `db_${error.code}`
          : 'error';
      const giveUp = event.attempts >= MAX_ATTEMPTS;
      await db
        .update(waWebhookEvents)
        .set({ status: giveUp ? 'failed' : 'pending', lastError: code })
        .where(eq(waWebhookEvents.id, event.id));
      if (giveUp) result.failed++;
      else result.retried++;
      deps.log({ job: WHATSAPP_JOB, event: event.id, error: code });
    }
  }
  await sweepCalls(db, now());
  return result;
}

/** Meta's bodies carry phones and texts: cleared after 90 days, the row kept. */
export async function purgeWhatsAppPayloads(db: Database, now = new Date()) {
  const rows = await db
    .update(waWebhookEvents)
    .set({ payload: null })
    .where(
      and(
        lt(waWebhookEvents.receivedAt, new Date(now.getTime() - PAYLOAD_DAYS * 86_400_000)),
        sql`${waWebhookEvents.payload} is not null`,
        inArray(waWebhookEvents.status, ['done', 'failed']),
      ),
    )
    .returning({ id: waWebhookEvents.id });
  return { purged: rows.length };
}

export async function applyWhatsAppPayload(deps: WhatsAppIntakeDeps, body: unknown) {
  for (const change of whatsappChangesOf(body)) {
    // A seller's connected number: only whether it left and how far its history is. Its
    // messages, echoes and templates do not enter the CRM yet (docs/whatsapp/conectar-numero.md).
    if (await isSellerNumberChange(deps.db, change, deps.wabaId ?? null)) {
      await applyNumberChange(deps.db, change, deps.now?.() ?? new Date());
      continue;
    }
    if (deps.phoneNumberId && change.phoneNumberId && change.phoneNumberId !== deps.phoneNumberId)
      continue;
    for (const message of change.messages)
      await applyInbound(deps, message, deps.now?.() ?? new Date());
    for (const status of change.statuses) await applyStatus(deps.db, status);
    for (const template of change.templates) await applyTemplateReview(deps.db, template);
    for (const call of change.calls) await applyCallEvent(deps.db, call);
    for (const status of change.callStatuses) await applyCallStatus(deps.db, status);
    // A call rang, was answered elsewhere or ended: the open ringing streams look again.
    if (change.calls.length > 0 || change.callStatuses.length > 0) notifyCallsChanged();
  }
}

// --- an incoming message ------------------------------------------------------------------

/** The most recent open deal of a phone: the lead's own number, or one of its contacts'. */
export async function openLeadByPhone(db: Database, phone: string): Promise<string | null> {
  const variants = brazilianPhoneVariants(phone);
  const [own] = await db
    .select({ id: leads.id, createdAt: leads.createdAt })
    .from(leads)
    .where(and(inArray(leads.phone, variants), isNull(leads.won)))
    .orderBy(desc(leads.createdAt))
    .limit(1);
  const [viaContact] = await db
    .select({ id: leads.id, createdAt: leads.createdAt })
    .from(leads)
    .innerJoin(leadContacts, eq(leadContacts.leadId, leads.id))
    .innerJoin(crmContacts, eq(crmContacts.id, leadContacts.contactId))
    .where(
      and(
        inArray(crmContacts.phone, variants),
        isNull(crmContacts.mergedIntoId),
        isNull(leads.won),
      ),
    )
    .orderBy(desc(leads.createdAt))
    .limit(1);
  if (own && viaContact) return own.createdAt >= viaContact.createdAt ? own.id : viaContact.id;
  return own?.id ?? viaContact?.id ?? null;
}

/**
 * A conversation that waited with no deal moves to the deal of its phone, as
 * soon as there is one (a deal created by hand with that number, or a later
 * message that finds one): its messages go with it.
 */
export async function adoptUnmatched(db: Database, contactId: string, leadId: string) {
  const waiting = await db.query.waConversations.findFirst({
    where: and(eq(waConversations.contactId, contactId), isNull(waConversations.leadId)),
  });
  if (!waiting) return;
  await db.transaction(async (tx) => {
    const existing = await tx.query.waConversations.findFirst({
      where: and(eq(waConversations.contactId, contactId), eq(waConversations.leadId, leadId)),
    });
    const target = existing?.id ?? waiting.id;
    if (existing) {
      await tx
        .update(waMessages)
        .set({ conversationId: existing.id, leadId })
        .where(eq(waMessages.conversationId, waiting.id));
      await tx
        .update(waCalls)
        .set({ conversationId: existing.id, leadId })
        .where(eq(waCalls.conversationId, waiting.id));
      await tx
        .update(sofiaAiRuns)
        .set({ conversationId: existing.id })
        .where(eq(sofiaAiRuns.conversationId, waiting.id));
      await tx
        .update(waConversations)
        .set({
          lastMessageAt: sql`greatest(${waConversations.lastMessageAt}, ${waiting.lastMessageAt?.toISOString() ?? null}::timestamptz)`,
          referral: sql`coalesce(${waConversations.referral}, ${waiting.referral === null ? null : JSON.stringify(waiting.referral)}::jsonb)`,
          // A deal's conversation that had ended takes the live one's state.
          ...(existing.attendance === 'closed'
            ? {
                attendance: waiting.attendance,
                stateChangedAt: waiting.stateChangedAt,
                reason: waiting.reason,
                segment: waiting.segment,
                brandClientId: waiting.brandClientId,
                sofiaFacts: waiting.sofiaFacts,
                sofiaMisses: waiting.sofiaMisses,
                // Copied in SQL: a JS Date would drop the microseconds Sofia compares.
                sofiaDueAt: sql`(select w.sofia_due_at from wa_conversations w where w.id = ${waiting.id})`,
                sofiaReadUntil: sql`(select w.sofia_read_until from wa_conversations w where w.id = ${waiting.id})`,
              }
            : {}),
        })
        .where(eq(waConversations.id, existing.id));
      await tx.delete(waConversations).where(eq(waConversations.id, waiting.id));
    } else {
      await tx.update(waConversations).set({ leadId }).where(eq(waConversations.id, waiting.id));
      await tx.update(waMessages).set({ leadId }).where(eq(waMessages.conversationId, target));
    }
  });
}

export async function openConversation(
  db: Database,
  contactId: string,
  leadId: string | null,
  first: { referral: Record<string, unknown> | null; originCode: string | null },
) {
  const match = () =>
    db.query.waConversations.findFirst({
      where: and(
        eq(waConversations.contactId, contactId),
        leadId === null ? isNull(waConversations.leadId) : eq(waConversations.leadId, leadId),
      ),
    });
  const found = await match();
  if (found) return { conversation: found, created: false };
  const [inserted] = await db
    .insert(waConversations)
    .values({ contactId, leadId, referral: first.referral, originCode: first.originCode })
    .onConflictDoNothing()
    .returning();
  return inserted
    ? { conversation: inserted, created: true }
    : { conversation: (await match())!, created: false };
}

export async function conversationFor(
  db: Database,
  contactId: string,
  leadId: string | null,
  first: { referral: Record<string, unknown> | null; originCode: string | null },
) {
  return (await openConversation(db, contactId, leadId, first)).conversation;
}

async function applyInbound(deps: WhatsAppIntakeDeps, message: WaInboundMessage, now: Date) {
  const { db } = deps;
  // A re-sent webhook: the message is already here, and nothing runs twice.
  const known = await db.query.waMessages.findFirst({
    where: eq(waMessages.wamid, message.wamid),
    columns: { id: true },
  });
  if (known) return;

  const phone = canonicalWhatsAppPhone(normalizeBrazilianPhone(message.from) ?? message.from);
  const at = message.at ?? new Date();
  const talks = ['text', 'button', 'interactive'].includes(message.kind);
  const optOut = isOptOut(message.text)
    ? at
    : talks
      ? null // writing again, about anything else, is talking again
      : undefined;
  const [contact] = await db
    .insert(waContacts)
    .values({
      phone,
      waId: message.from,
      profileName: message.profileName,
      lastInboundAt: at,
      optOutAt: optOut ?? null,
    })
    .onConflictDoUpdate({
      target: [waContacts.tenantId, waContacts.phone],
      set: {
        waId: message.from,
        profileName: sql`coalesce(excluded.profile_name, ${waContacts.profileName})`,
        lastInboundAt: sql`greatest(${waContacts.lastInboundAt}, excluded.last_inbound_at)`,
        ...(optOut === undefined ? {} : { optOutAt: optOut }),
        updatedAt: new Date(),
      },
    })
    .returning();

  const permission = message.content.callPermission as
    { response?: string | null; isPermanent?: boolean; expiresAt?: string | null } | undefined;
  if (permission)
    await db
      .update(waContacts)
      .set({
        callPermission:
          permission.response === 'accept'
            ? permission.isPermanent
              ? 'permanent'
              : 'temporary'
            : 'no_permission',
        callPermissionExpiresAt:
          permission.response === 'accept' && permission.expiresAt
            ? new Date(permission.expiresAt)
            : null,
      })
      .where(eq(waContacts.id, contact!.id));

  // A tracking code tells the brand and the channel. With Sofia on, she makes
  // the deal at the end of her questions; off, the link makes it at once, as
  // before her (and as the Z-API door still does).
  const sofiaSettings = await loadSofiaSettings(db);
  const sofiaOn = sofiaSettings.enabled;
  const code = trackingCodeOf(message.text);
  const link = code ? await trackingLinkByCode(db, code) : null;
  let leadId = await openLeadByPhone(db, phone);
  // `<code> <ref>`: the ref is the lead a site form just made, even when the person writes from
  // another number. It wins over the phone match, and no second lead is made for the message.
  const formLead = link ? await leadByFormRef(db, message.text, now) : null;
  const formLeadId = formLead?.id ?? null;
  if (formLeadId) leadId = formLeadId;
  if (link && code && normalizeBrazilianPhone(message.from)) {
    if (!sofiaOn && !formLeadId) {
      const tracked = await leadFromTrackedMessage(db, {
        code,
        phone,
        text: message.text,
        senderName: message.profileName,
        at: message.at,
        via: 'cloud_api',
      });
      leadId = tracked?.lead.id ?? leadId;
    } else
      await db
        .update(leadTrackingLinks)
        .set({ hits: sql`${leadTrackingLinks.hits} + 1`, lastHitAt: at })
        .where(eq(leadTrackingLinks.id, link.id));
  }
  // No open deal, but a seller is talking to this person from a closed one
  // (a reactivation template): the answer is that seller's, in that conversation.
  if (!leadId) leadId = await heldDealOf(db, contact!.id, now);
  if (leadId) await adoptUnmatched(db, contact!.id, leadId);
  const opened = await openConversation(db, contact!.id, leadId, {
    referral: message.referral,
    originCode: link ? code : null,
  });
  let conversation = opened.conversation;
  const created = opened.created;
  if (formLeadId) {
    // Sofia starts knowing what the form told: the answers are hers, the greeting uses the name.
    const known = factsOf(conversation);
    if (!known.formKnown) {
      const context = await formContextOf(db, formLeadId, sofiaSettings);
      if (context) {
        // The greeting says the form's name only to the number the form gave: the ref alone is a hint.
        if (!formLead?.phone || !brazilianPhoneVariants(phone).includes(formLead.phone))
          context.formName = null;
        const facts = { ...known, ...context, answers: { ...context.answers, ...known.answers } };
        await db
          .update(waConversations)
          .set({ sofiaFacts: facts })
          .where(eq(waConversations.id, conversation.id));
        conversation = { ...conversation, sofiaFacts: facts };
      }
    }
    if (created) {
      await db.insert(leadEvents).values({
        leadId: formLeadId,
        kind: 'lead.whatsapp_linked',
        detail: { via: 'cloud_api', trackingLinkId: link?.id ?? null },
      });
    }
  }

  // Sofia off and no deal: the first text of a new conversation waits for the Jev triage when
  // it is on (docs/leads/triagem-jev.md), which makes the deal or tells the team a person is
  // needed. It goes on the triage's list inside the transaction that stores the message, so a
  // restart or an error before the triage runs cannot leave the conversation unnoticed.
  let triageQueued = false;
  let storedNow = false;
  // The message and who answers it are one step: a failure in between is
  // retried whole (a stored message is never left without its routing).
  await db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(waMessages)
      .values({
        wamid: message.wamid,
        conversationId: conversation.id,
        contactId: contact!.id,
        leadId,
        direction: 'in',
        author: 'contact',
        kind: message.kind,
        text: message.text,
        content: message.content,
        waTimestamp: message.at,
      })
      .onConflictDoNothing()
      .returning({ id: waMessages.id });
    if (!stored) return;
    storedNow = true;
    await tx
      .update(waConversations)
      .set({
        lastMessageAt: sql`greatest(${waConversations.lastMessageAt}, ${at.toISOString()}::timestamptz)`,
        ...(link && !conversation.originCode ? { originCode: code } : {}),
        ...(message.referral && !conversation.referral ? { referral: message.referral } : {}),
      })
      .where(eq(waConversations.id, conversation.id));

    const [lead] = leadId
      ? await tx
          .select({
            id: leads.id,
            ownerEmployeeId: leads.ownerEmployeeId,
            pipeline: leads.pipeline,
            clientId: leads.clientId,
          })
          .from(leads)
          .where(eq(leads.id, leadId))
      : [];
    await routeInbound(tx, {
      conversation,
      created,
      messageId: stored.id,
      quietOptOut: Boolean(contact!.optOutAt) && !talks,
      lead: lead ?? null,
      link: link ? { id: link.id, clientId: link.clientId, channel: link.channel } : null,
      sofiaOn,
      now,
    });
    if (
      !sofiaOn &&
      !leadId &&
      message.kind === 'text' &&
      message.text?.trim() &&
      leadTriageEnabled()
    ) {
      // The first text of the conversation, decided here and not from `created`: a retry after a
      // first attempt that was cut short sees the conversation as already there, but it is still
      // this message that opens it.
      const [earlier] = await tx
        .select({ id: waMessages.id })
        .from(waMessages)
        .where(
          and(
            eq(waMessages.conversationId, conversation.id),
            eq(waMessages.direction, 'in'),
            ne(waMessages.id, stored.id),
          ),
        )
        .limit(1);
      if (!earlier) {
        await enqueueTriage(tx, { conversationId: conversation.id });
        triageQueued = true;
      }
    }
  });
  // Otherwise the conversation just waits for an attendant.
  if (triageQueued) scheduleLeadTriage({ conversationId: conversation.id });
  if (storedNow && talks && message.text?.trim().toLowerCase() === CALL_REQUEST)
    await answerCallRequest(deps, {
      contact: contact!,
      conversationId: conversation.id,
      leadId,
      at,
    });
}

/** The quick reply of our welcome templates where the person asks for a call. */
const CALL_REQUEST = 'prefiro uma ligação';
export const CALL_REQUEST_TASK = 'Ligar: o lead pediu uma ligação pelo WhatsApp';
const DAY_MS = 24 * 3_600_000;

/**
 * "Prefiro uma ligação" (Eric, 26/10): the deal's owner gets a task to call
 * now, and, with the official number live and calling on, Meta's call-permission
 * request goes at once (the tap just opened the 24 h window). Not again while
 * the person allows calls or within a day of the last request (Meta allows 1 a
 * day); sent once, never retried, nothing about the person logged.
 */
async function answerCallRequest(
  deps: WhatsAppIntakeDeps,
  target: { contact: Contact; conversationId: string; leadId: string | null; at: Date },
) {
  const { db } = deps;
  const { contact, leadId, at } = target;
  const [lead] = leadId
    ? await db.select({ owner: leads.ownerEmployeeId }).from(leads).where(eq(leads.id, leadId))
    : [];
  if (leadId && lead?.owner) {
    const open = await db.query.leadTasks.findFirst({
      where: and(
        eq(leadTasks.leadId, leadId),
        eq(leadTasks.title, CALL_REQUEST_TASK),
        isNull(leadTasks.doneAt),
      ),
      columns: { id: true },
    });
    if (!open) {
      const [task] = await db
        .insert(leadTasks)
        .values({
          leadId,
          kind: 'call',
          title: CALL_REQUEST_TASK,
          dueAt: at,
          assigneeEmployeeId: lead.owner,
          auto: true,
        })
        .returning({ id: leadTasks.id });
      await db.insert(leadEvents).values({
        leadId,
        kind: 'lead.task_created',
        detail: { taskId: task!.id, kind: 'call', auto: true, dueAt: at.toISOString() },
      });
    }
  }
  const send = deps.send;
  const state = permissionOf(contact, at).status;
  const askedToday =
    contact.callPermissionRequestedAt !== null &&
    at.getTime() - contact.callPermissionRequestedAt.getTime() < DAY_MS;
  if (
    !send ||
    state === 'temporary' ||
    state === 'permanent' ||
    askedToday ||
    !(await officialNumberLive(db)) ||
    !(await callingOn(send.fetch, send.config))
  )
    return;
  const shown = callPermissionText(await brandOf(db, leadId, target.conversationId));
  const delivered = await deliverWhatsApp(db, send.fetch, send.config, {
    contact,
    conversationId: target.conversationId,
    leadId,
    author: 'system',
    employeeId: null,
    kind: 'interactive',
    shown,
    content: { callPermissionRequest: true },
    payload: callPermissionPayload(shown),
    at,
  });
  if (delivered.outcome === 'sent')
    await db
      .update(waContacts)
      .set({ callPermission: 'requested', callPermissionRequestedAt: at })
      .where(eq(waContacts.id, contact.id));
}

/** How long a seller's message from a closed deal keeps the person's answers with that seller. */
const HELD_DAYS = 30;

/**
 * The closed deal whose conversation a seller holds with this person (they
 * wrote from it in the last 30 days), so the person's answer reaches them
 * rather than starting over with Sofia.
 */
async function heldDealOf(db: Database, contactId: string, now: Date): Promise<string | null> {
  const [held] = await db
    .select({ leadId: waConversations.leadId })
    .from(waConversations)
    .where(
      and(
        eq(waConversations.contactId, contactId),
        sql`${waConversations.leadId} is not null`,
        inArray(waConversations.attendance, ['with_person', 'waiting_seller']),
        sql`exists (select 1 from wa_messages o where o.conversation_id = ${waConversations.id}
              and o.author = 'employee'
              and o.created_at > ${new Date(now.getTime() - HELD_DAYS * 86_400_000).toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(desc(waConversations.lastMessageAt))
    .limit(1);
  return held?.leadId ?? null;
}

// --- a status of one of our messages --------------------------------------------------------

const STAMP: Partial<Record<WaMessageStatus, 'sentAt' | 'deliveredAt' | 'readAt' | 'failedAt'>> = {
  sent: 'sentAt',
  delivered: 'deliveredAt',
  read: 'readAt',
  failed: 'failedAt',
};

async function applyStatus(db: Database, update: WaStatusUpdate) {
  if (!update.status) return;
  const row = await db.query.waMessages.findFirst({ where: eq(waMessages.wamid, update.wamid) });
  if (!row || row.direction !== 'out') return;
  const at = update.at ?? new Date();
  const stamp = STAMP[update.status];
  const current = (row.status ?? 'pending') as WaMessageStatus;
  if (waStatusAdvances(current, update.status)) {
    await db
      .update(waMessages)
      .set({
        status: update.status,
        ...(stamp ? { [stamp]: at } : {}),
        ...(update.status === 'failed'
          ? { errorCode: update.errorCode, errorTitle: update.errorTitle }
          : {}),
      })
      .where(eq(waMessages.id, row.id));
    // A message with the art that Meta failed later because of the file: the art goes up again next time.
    const art = (row.content as { art?: { mediaId?: unknown } } | null)?.art;
    if (
      update.status === 'failed' &&
      typeof art?.mediaId === 'string' &&
      update.errorCode !== null &&
      ART_MEDIA_GONE_CODES.has(update.errorCode)
    )
      await invalidateArtMedia(db, art.mediaId, at);
  } else if (stamp && stamp !== 'failedAt' && row[stamp] === null && current !== 'failed') {
    // Arrived late (a "delivered" after the "read"): only its time is filled in.
    await db
      .update(waMessages)
      .set({ [stamp]: at })
      .where(eq(waMessages.id, row.id));
  }
}

// --- a template review ------------------------------------------------------------------------

async function applyTemplateReview(db: Database, update: WaTemplateUpdate) {
  await db
    .update(waTemplates)
    .set({ status: update.status, syncedAt: new Date() })
    .where(
      and(
        eq(waTemplates.name, update.name),
        update.language ? eq(waTemplates.language, update.language) : sql`true`,
      ),
    );
}

// --- calls ---------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENDED = ['completed', 'rejected', 'missed', 'failed'];

/** Our row for a call: by Meta's id, or by our own id that went out as opaque data. */
async function callRow(db: Database, callId: string, opaque: string | null) {
  const byId = await db.query.waCalls.findFirst({ where: eq(waCalls.callId, callId) });
  if (byId) return byId;
  if (opaque && UUID.test(opaque)) {
    const ours = await db.query.waCalls.findFirst({ where: eq(waCalls.id, opaque) });
    if (ours && (ours.callId === null || ours.callId === callId)) {
      if (ours.callId === null)
        await db.update(waCalls).set({ callId }).where(eq(waCalls.id, ours.id));
      return { ...ours, callId };
    }
  }
  return null;
}

/** A person calling in: their contact, the deal of the phone, a ringing row. */
async function incomingCall(db: Database, event: WaCallEvent) {
  if (!event.person) return null;
  const phone = canonicalWhatsAppPhone(normalizeBrazilianPhone(event.person) ?? event.person);
  const at = event.at ?? new Date();
  // A call opens the 24-hour window like a message (Meta's rule), answered or not.
  const [contact] = await db
    .insert(waContacts)
    .values({ phone, waId: event.person, profileName: event.profileName, lastInboundAt: at })
    .onConflictDoUpdate({
      target: [waContacts.tenantId, waContacts.phone],
      set: {
        waId: event.person,
        profileName: sql`coalesce(excluded.profile_name, ${waContacts.profileName})`,
        lastInboundAt: sql`greatest(${waContacts.lastInboundAt}, excluded.last_inbound_at)`,
        updatedAt: new Date(),
      },
    })
    .returning();
  const leadId = await openLeadByPhone(db, phone);
  if (leadId) await adoptUnmatched(db, contact!.id, leadId);
  const conversation = await conversationFor(db, contact!.id, leadId, {
    referral: null,
    originCode: null,
  });
  const [row] = await db
    .insert(waCalls)
    .values({
      callId: event.callId,
      contactId: contact!.id,
      conversationId: conversation.id,
      leadId,
      direction: 'in',
      status: 'ringing',
      remoteSdp: event.event === 'connect' ? event.sdp : null,
      startedAt: at,
    })
    .onConflictDoNothing()
    .returning();
  return (
    row ?? (await db.query.waCalls.findFirst({ where: eq(waCalls.callId, event.callId) })) ?? null
  );
}

async function applyCallEvent(db: Database, event: WaCallEvent) {
  let row = await callRow(db, event.callId, event.opaque);
  if (event.event === 'connect') {
    if (event.direction === 'in') {
      if (!row) await incomingCall(db, event);
      return;
    }
    // Meta's answer to the offer our browser made: the browser applies it.
    if (row && !ENDED.includes(row.status) && event.sdpType === 'answer' && event.sdp)
      await db
        .update(waCalls)
        .set({ remoteSdp: event.sdp, status: row.status === 'dialing' ? 'ringing' : row.status })
        .where(eq(waCalls.id, row.id));
    return;
  }
  // terminate: may come before the connect, and more than once.
  if (!row && event.direction === 'in') row = await incomingCall(db, event);
  if (!row || row.endedAt !== null) {
    // Already closed here (our hang-up): Meta's duration is the real one.
    if (row && row.activityLoggedAt === null && event.durationSeconds !== null)
      await db
        .update(waCalls)
        .set({
          durationSeconds: event.durationSeconds,
          ...(event.durationSeconds > 0 ? { status: 'completed' } : {}),
        })
        .where(eq(waCalls.id, row.id));
    if (row) await logCallOnDeal(db, row.id);
    return;
  }
  const talked = event.outcome === 'completed' && (event.durationSeconds ?? 0) > 0;
  const status = talked
    ? 'completed'
    : row.status === 'rejected'
      ? 'rejected'
      : event.outcome === 'failed' && row.status === 'accepted'
        ? 'failed'
        : 'missed';
  await db
    .update(waCalls)
    .set({
      status,
      remoteSdp: null,
      endedAt: event.endedAt ?? event.at ?? new Date(),
      connectedAt: row.connectedAt ?? (talked ? event.startedAt : null),
      durationSeconds: talked ? event.durationSeconds : 0,
      errorCode: event.errorCode,
      errorTitle: event.errorTitle,
    })
    .where(eq(waCalls.id, row.id));
  await logCallOnDeal(db, row.id);
}

async function applyCallStatus(db: Database, update: WaCallStatusUpdate) {
  const row = await callRow(db, update.callId, update.opaque);
  if (!row || ENDED.includes(row.status)) return;
  if (update.status === 'RINGING' && row.status === 'dialing')
    await db.update(waCalls).set({ status: 'ringing' }).where(eq(waCalls.id, row.id));
  else if (update.status === 'ACCEPTED')
    await db
      .update(waCalls)
      .set({ status: 'accepted', connectedAt: row.connectedAt ?? update.at ?? new Date() })
      .where(eq(waCalls.id, row.id));
  else if (update.status === 'REJECTED')
    await db.update(waCalls).set({ status: 'rejected' }).where(eq(waCalls.id, row.id));
}

/**
 * A finished call goes on its deal's history once: who called or answered,
 * the result and the real duration, "pelo WhatsApp". A call with no deal
 * stays only in the WhatsApp record.
 */
export async function logCallOnDeal(db: Database, callRowId: string) {
  const claimed = await db
    .update(waCalls)
    .set({ activityLoggedAt: new Date() })
    .where(
      and(
        eq(waCalls.id, callRowId),
        isNull(waCalls.activityLoggedAt),
        sql`${waCalls.leadId} is not null`,
        sql`${waCalls.endedAt} is not null`,
      ),
    )
    .returning();
  const call = claimed[0];
  if (!call?.leadId) return;
  const answered = call.status === 'completed';
  const way = call.direction === 'in' ? 'ligação recebida' : 'ligação feita';
  await addActivity(db, {
    leadId: call.leadId,
    actorEmployeeId: call.employeeId,
    kind: 'call',
    outcome: answered ? 'answered' : 'no_answer',
    durationSeconds: answered ? (call.durationSeconds ?? undefined) : undefined,
    note: `Pelo WhatsApp · ${way}${answered ? '' : call.status === 'rejected' ? ', recusada' : ', não atendida'}`,
    at: call.startedAt.toISOString(),
  });
}

/**
 * Calls nobody closed: one that rang out without a webhook becomes missed; one
 * ended by our hang-up but whose final webhook never came goes on the deal
 * with what we know; one that never ended is closed after 4 hours.
 */
export async function sweepCalls(db: Database, now: Date) {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  await db
    .update(waCalls)
    .set({ status: 'missed', endedAt: now, remoteSdp: null, durationSeconds: 0 })
    .where(
      and(inArray(waCalls.status, ['dialing', 'ringing']), lt(waCalls.startedAt, ago(3 * 60_000))),
    );
  await db
    .update(waCalls)
    .set({ status: 'failed', endedAt: now, remoteSdp: null })
    .where(and(eq(waCalls.status, 'accepted'), lt(waCalls.startedAt, ago(4 * 3_600_000))));
  const late = await db
    .select({ id: waCalls.id })
    .from(waCalls)
    .where(
      and(
        isNull(waCalls.activityLoggedAt),
        sql`${waCalls.leadId} is not null`,
        lt(waCalls.endedAt, ago(2 * 60_000)),
      ),
    )
    .limit(50);
  for (const call of late) await logCallOnDeal(db, call.id);
}

// --- the loop -----------------------------------------------------------------------------

export function startWhatsAppIntake(deps: WhatsAppIntakeDeps & { tickMs?: number }) {
  let running: Promise<WhatsAppIntakeResult> | null = null;
  const runOnce = () => {
    if (running) return running;
    running = processWhatsAppEvents(deps)
      .catch((error: unknown) => {
        deps.log({
          job: WHATSAPP_JOB,
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        });
        return { processed: 0, done: 0, retried: 0, failed: 0 };
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
  let purgedOn = '';
  const tick = async () => {
    const result = await runOnce();
    if (result.processed > 0) deps.log({ job: WHATSAPP_JOB, ...result });
    const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    if (purgedOn !== today) {
      purgedOn = today;
      const { purged } = await purgeWhatsAppPayloads(deps.db, deps.now?.());
      if (purged > 0) deps.log({ job: WHATSAPP_JOB, purgedPayloads: purged });
    }
  };
  const timer = setInterval(() => void tick().catch(() => undefined), deps.tickMs ?? 60_000);
  timer.unref();
  return {
    kick: () => void runOnce(),
    runOnce,
    stop: () => clearInterval(timer),
  };
}
