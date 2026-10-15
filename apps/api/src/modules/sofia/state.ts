import { WINGS_CLIENT_ID, type SofiaState } from '@wings/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.js';
import type { Executor } from '../leads/crm.js';
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
  /** The conversation is tied to the lead a site form made: its answers are already in `answers`. */
  formKnown?: boolean;
  /** The person's first name from the form, for the greeting (never sent to the AI). */
  formName?: string | null;
  /** The page the form was sent from, without query. */
  formPage?: string | null;
  /** The form's non-contact answers (question -> answer), at most five. */
  formAnswers?: Record<string, string>;
}

export function factsOf(row: { sofiaFacts: unknown }): SofiaFacts {
  const raw = (row.sofiaFacts ?? {}) as Partial<SofiaFacts>;
  return { ...raw, answers: { ...(raw.answers ?? {}) }, step: raw.step ?? null };
}

/** `reason` of a conversation a person gave back to Sofia. */
export const SOFIA_GIVEN_BACK = 'devolvida';

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
  /** The message being routed (already stored). */
  messageId: string;
  /** The person asked not to be written to, and this message is not talk (a sticker, a file). */
  quietOptOut: boolean;
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
export async function routeInbound(db: Executor, input: InboundRoute): Promise<SofiaState> {
  const { conversation, now } = input;
  const current = conversation.attendance as SofiaState;
  const fresh = input.created || current === 'closed';
  let next: SofiaState = current;
  let reason = conversation.reason;
  const patch: PgUpdateSetSource<typeof waConversations> = {};
  // Whatever was said before the conversation became hers is not hers to answer
  // (an old PARAR, a question a person already took): she reads from here on.
  const readFromHere = () => {
    patch.sofiaReadUntil = sql`(select max(m.created_at) from wa_messages m where m.conversation_id = ${conversation.id} and m.id <> ${input.messageId})`;
  };

  if (input.lead?.ownerEmployeeId) {
    // The deal has its seller: the message is the seller's. Sofia keeps it
    // only when the seller gave it back; a deal that got its owner while she
    // talked goes to the owner.
    if (
      fresh ||
      current === 'waiting_human' ||
      (current === 'sofia' && conversation.reason !== SOFIA_GIVEN_BACK)
    )
      next = 'waiting_seller';
    if (next !== current) reason = null;
  } else if (fresh && input.quietOptOut) {
    // Someone who said SAIR and then sent a sticker: nobody writes back.
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
      // What the form told her stays: the place in the script starts over, the knowledge does not.
      ...(old.formKnown
        ? {
            formKnown: true,
            formName: old.formName ?? null,
            formPage: old.formPage ?? null,
            formAnswers: old.formAnswers ?? {},
            ...(old.brandConfirmed ? { brandConfirmed: true } : {}),
          }
        : {}),
    } satisfies SofiaFacts;
    patch.sofiaMisses = 0;
    if (next === 'sofia') readFromHere();
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
      readFromHere();
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
      // Marks a give-back: Sofia keeps a deal's conversation only after one.
      reason: SOFIA_GIVEN_BACK,
      sofiaMisses: 0,
      sofiaFacts: sql`jsonb_set(coalesce(${waConversations.sofiaFacts}, '{}'::jsonb), '{step}', 'null'::jsonb)`,
      // Messages the person sent while a person held it are not hers to answer
      // (by the database's own clock, like the messages').
      sofiaReadUntil: sql`(select max(m.created_at) from wa_messages m where m.conversation_id = ${conversationId})`,
      sofiaDueAt: null,
    })
    .where(eq(waConversations.id, conversationId));
}
