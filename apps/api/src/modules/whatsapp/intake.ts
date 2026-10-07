import {
  brazilianPhoneVariants,
  canonicalWhatsAppPhone,
  normalizeBrazilianPhone,
  trackingCodeOf,
  waStatusAdvances,
  type WaMessageStatus,
} from '@wings/shared';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  crmContacts,
  leadContacts,
  leads,
  waContacts,
  waConversations,
  waMessages,
  waTemplates,
  waWebhookEvents,
} from '../../db/schema/index.js';
import { leadFromTrackedMessage } from '../leads/tracked-link.js';
import {
  isOptOut,
  whatsappChangesOf,
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
  log: (facts: Record<string, unknown>) => void;
  now?: () => Date;
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
    if (deps.phoneNumberId && change.phoneNumberId && change.phoneNumberId !== deps.phoneNumberId)
      continue;
    for (const message of change.messages) await applyInbound(deps.db, message);
    for (const status of change.statuses) await applyStatus(deps.db, status);
    for (const template of change.templates) await applyTemplateReview(deps.db, template);
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
        .update(waConversations)
        .set({
          lastMessageAt: sql`greatest(${waConversations.lastMessageAt}, ${waiting.lastMessageAt?.toISOString() ?? null}::timestamptz)`,
          referral: sql`coalesce(${waConversations.referral}, ${waiting.referral === null ? null : JSON.stringify(waiting.referral)}::jsonb)`,
        })
        .where(eq(waConversations.id, existing.id));
      await tx.delete(waConversations).where(eq(waConversations.id, waiting.id));
    } else {
      await tx.update(waConversations).set({ leadId }).where(eq(waConversations.id, waiting.id));
      await tx.update(waMessages).set({ leadId }).where(eq(waMessages.conversationId, target));
    }
  });
}

export async function conversationFor(
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
  if (found) return found;
  await db
    .insert(waConversations)
    .values({ contactId, leadId, referral: first.referral, originCode: first.originCode })
    .onConflictDoNothing();
  return (await match())!;
}

async function applyInbound(db: Database, message: WaInboundMessage) {
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

  const code = trackingCodeOf(message.text);
  const tracked =
    code && normalizeBrazilianPhone(message.from)
      ? await leadFromTrackedMessage(db, {
          code,
          phone,
          text: message.text,
          senderName: message.profileName,
          at: message.at,
          via: 'cloud_api',
        })
      : null;
  const leadId = tracked?.lead.id ?? (await openLeadByPhone(db, phone));
  if (leadId) await adoptUnmatched(db, contact!.id, leadId);
  const conversation = await conversationFor(db, contact!.id, leadId, {
    referral: message.referral,
    originCode: tracked ? code : null,
  });

  await db
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
    .onConflictDoNothing();
  await db
    .update(waConversations)
    .set({
      lastMessageAt: sql`greatest(${waConversations.lastMessageAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(eq(waConversations.id, conversation.id));
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
