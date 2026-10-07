import { WINGS_CLIENT_ID, type SofiaState } from '@wings/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { waConversations } from '../../db/schema/index.js';

/**
 * Who has a WhatsApp conversation (docs/whatsapp/sofia.md), and the rule for
 * each incoming message (Eric, 07/10):
 * - a deal of that phone that is open and has an owner: straight to the owner;
 * - otherwise a new (or closed) conversation is Sofia's, when she is on, and
 *   waits for a person when she is off;
 * - a conversation a person already holds stays with that person.
 * A person writing in the conversation takes it (`takeConversation`); the
 * seller can give it back to Sofia.
 */

export type ConversationRow = typeof waConversations.$inferSelect;

/** What Sofia keeps about a conversation (`wa_conversations.sofia_facts`). */
export interface SofiaFacts {
  /** Answers by question key. */
  answers: Record<string, string>;
  /** What she asked last: a question key, or objective | other | brand_confirm | brand. */
  step: string | null;
  greeted?: boolean;
  askedOther?: boolean;
  brandConfirmed?: boolean;
  /** Expansão: the brand as the person wrote it, when no client matched. */
  brandText?: string | null;
  mediaAsked?: boolean;
  /** The tracking link of the first message (channel and id), for the deal's origin. */
  trackingLinkId?: string | null;
  channel?: string | null;
}

export function factsOf(row: { sofiaFacts: unknown }): SofiaFacts {
  const raw = (row.sofiaFacts ?? {}) as Partial<SofiaFacts>;
  return { ...raw, answers: { ...(raw.answers ?? {}) }, step: raw.step ?? null };
}

/** Quiet time before Sofia answers, so a burst of short messages gets one reply. */
export const SOFIA_DEBOUNCE_MS = 4_000;

const PERSON_TAKES: SofiaState[] = ['sofia', 'waiting_seller', 'waiting_human', 'closed'];

/** A person wrote in the conversation: it is theirs now, and Sofia stops. */
export async function takeConversation(db: Database, conversationId: string, at: Date) {
  await db
    .update(waConversations)
    .set({ attendance: 'with_person', stateChangedAt: at, reason: null, sofiaDueAt: null })
    .where(
      and(
        eq(waConversations.id, conversationId),
        inArray(waConversations.attendance, PERSON_TAKES),
      ),
    );
}

export async function setAttendance(
  db: Database,
  conversationId: string,
  state: SofiaState,
  at: Date,
  reason: string | null = null,
) {
  await db
    .update(waConversations)
    .set({
      attendance: state,
      stateChangedAt: at,
      reason,
      ...(state === 'sofia' ? {} : { sofiaDueAt: null }),
    })
    .where(eq(waConversations.id, conversationId));
}

export interface InboundRoute {
  conversation: ConversationRow;
  /** The conversation was opened by this message. */
  created: boolean;
  lead: {
    id: string;
    ownerEmployeeId: string | null;
    pipeline: string | null;
    clientId: string;
  } | null;
  /** The tracking link the message started with, when one of ours. */
  link: { id: string; clientId: string; channel: string } | null;
  sofiaOn: boolean;
  now: Date;
}

/** Decides who answers an incoming message, and wakes Sofia when it is hers. */
export async function routeInbound(db: Database, input: InboundRoute): Promise<SofiaState> {
  const { conversation, now } = input;
  const current = conversation.attendance as SofiaState;
  const fresh = input.created || current === 'closed';
  let next: SofiaState = current;
  let reason = conversation.reason;
  const patch: Partial<typeof waConversations.$inferInsert> = {};

  if (input.lead?.ownerEmployeeId) {
    // The deal has its seller: the message is the seller's, unless the
    // seller gave the conversation back to Sofia.
    if (fresh || current === 'waiting_human') next = 'waiting_seller';
    if (next !== current) reason = null;
  } else if (fresh) {
    next = input.sofiaOn ? 'sofia' : 'waiting_human';
    reason = input.sofiaOn ? null : 'sofia_desligada';
    // A new conversation (or one that ended) starts over: the answers stay
    // (no need to ask again), the place in the script does not.
    const old = factsOf(conversation);
    // The brand of the link, or of the open deal Sofia now works on.
    const brand =
      input.link && input.link.clientId !== WINGS_CLIENT_ID
        ? input.link.clientId
        : input.lead?.pipeline === 'expansao' && input.lead.clientId !== WINGS_CLIENT_ID
          ? input.lead.clientId
          : null;
    patch.sofiaFacts = {
      answers: old.answers,
      step: null,
      trackingLinkId: input.link?.id ?? old.trackingLinkId ?? null,
      channel: input.link?.channel ?? old.channel ?? null,
    } satisfies SofiaFacts;
    patch.sofiaMisses = 0;
    patch.segment = brand
      ? 'expansao'
      : input.lead?.pipeline === 'formatacao'
        ? 'formatacao'
        : null;
    patch.brandClientId = brand;
  } else if (current === 'waiting_human' && conversation.reason === 'sofia_desligada') {
    // It waited only because Sofia was off; she is on now.
    if (input.sofiaOn) {
      next = 'sofia';
      reason = null;
    }
  }

  // A brand link in the middle of Sofia's conversation still tells the brand.
  if (
    next === 'sofia' &&
    !fresh &&
    input.link &&
    input.link.clientId !== WINGS_CLIENT_ID &&
    !conversation.brandClientId
  ) {
    patch.brandClientId = input.link.clientId;
    if (!conversation.segment) patch.segment = 'expansao';
  }

  if (next === 'sofia') patch.sofiaDueAt = new Date(now.getTime() + SOFIA_DEBOUNCE_MS);
  if (next !== current) {
    patch.attendance = next;
    patch.stateChangedAt = now;
    patch.reason = reason;
  }
  if (Object.keys(patch).length > 0)
    await db.update(waConversations).set(patch).where(eq(waConversations.id, conversation.id));
  return next;
}

/** The seller gives the conversation back: Sofia answers the person's next message. */
export async function giveBackToSofia(db: Database, conversationId: string, at: Date) {
  await db
    .update(waConversations)
    .set({
      attendance: 'sofia',
      stateChangedAt: at,
      reason: null,
      sofiaMisses: 0,
      sofiaFacts: sql`jsonb_set(coalesce(${waConversations.sofiaFacts}, '{}'::jsonb), '{step}', 'null'::jsonb)`,
      // Messages the person sent while a person held it are not hers to answer
      // (by the database's own clock, like the messages').
      sofiaReadUntil: sql`(select max(m.created_at) from wa_messages m where m.conversation_id = ${conversationId})`,
      sofiaDueAt: null,
    })
    .where(eq(waConversations.id, conversationId));
}
