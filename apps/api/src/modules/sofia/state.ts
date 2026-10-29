import {
  WINGS_CLIENT_ID,
  type SofiaFact,
  type SofiaSegment,
  type SofiaSettings,
  type SofiaState,
} from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Executor } from '../leads/crm.js';
import { waConversationEvents, waConversations } from '../../db/schema/index.js';

/**
 * Who has a WhatsApp conversation (docs/whatsapp/sofia.md), and the rule for
 * each incoming message (Eric, 07/10):
 * - a deal of that phone that is open and has an owner: straight to the owner;
 * - otherwise a new (or closed) conversation is Sofia's, when she is on, and
 *   waits for a person when she is off;
 * - a conversation a person already holds stays with that person, and one
 *   assigned to a person goes back to that person (whatsapp/attendance.ts).
 * A person writing in the conversation takes it (`holdForSend`); the seller
 * can give it back to Sofia, and anyone can pause her in it.
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
  /** Her questions Meta refused (or never answered) in a row: two, and a person takes over. */
  lostAsks?: number;
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

/** What Sofia found out, in the order of the funnel's questions, then the rest. */
export function factListOf(
  row: { sofiaFacts: unknown },
  settings: SofiaSettings,
  segment: SofiaSegment | null,
): SofiaFact[] {
  const facts = factsOf(row);
  const questions = segment === 'expansao' ? settings.expansao : settings.formatacao;
  const listed: SofiaFact[] = questions
    .filter((q) => facts.answers[q.key] !== undefined)
    .map((q) => ({ key: q.key, label: q.label, answer: facts.answers[q.key]! }));
  const others: SofiaFact[] = Object.entries(facts.answers)
    .filter(([key]) => !questions.some((q) => q.key === key))
    .map(([key, answer]) => ({ key, label: key, answer }));
  if (facts.brandText)
    others.push({ key: 'marca', label: 'Marca citada', answer: facts.brandText });
  return [...listed, ...others];
}

/** `reason` of a conversation a person gave back to Sofia. */
export const SOFIA_GIVEN_BACK = 'devolvida';

/** Quiet time before Sofia answers, so a burst of short messages gets one reply. */
export const SOFIA_DEBOUNCE_MS = 4_000;

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
  const { now } = input;
  // The row as it is now, locked until the message is stored: a person taking it meanwhile
  // waits, and an older read never hands Sofia a conversation a person just took.
  const [conversation = input.conversation] = await db
    .select()
    .from(waConversations)
    .where(eq(waConversations.id, input.conversation.id))
    .for('update');
  const current = conversation.attendance as SofiaState;
  const sofiaOn = input.sofiaOn && !conversation.sofiaPaused;
  const fresh = input.created || current === 'closed';
  let next: SofiaState = current;
  let reason = conversation.reason;
  const patch: PgUpdateSetSource<typeof waConversations> = {};
  // Whatever was said before the conversation became hers is not hers to answer
  // (an old PARAR, a question a person already took): she reads from here on.
  const readFromHere = () => {
    patch.sofiaReadUntil = sql`(select max(m.created_at) from wa_messages m where m.conversation_id = ${conversation.id} and m.id <> ${input.messageId})`;
  };

  // A conversation that ended starts over (Eric, 07/10): whoever had it then does not keep it.
  if (fresh && conversation.assigneeEmployeeId) {
    patch.assigneeEmployeeId = null;
    patch.queue = null;
  }
  if (input.lead?.ownerEmployeeId || (!fresh && conversation.assigneeEmployeeId)) {
    // The deal has its seller (or a person was given the conversation): the message is theirs.
    // Sofia keeps it only when it was given back to her; a deal that got its owner while she
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
    next = sofiaOn ? 'sofia' : 'waiting_human';
    reason = sofiaOn ? null : input.sofiaOn ? 'sofia_pausada' : 'sofia_desligada';
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
    if (sofiaOn) {
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
    // A change of hands: an action on the version a screen saw before it is refused.
    patch.version = sql`${waConversations.version} + 1`;
  }
  if (Object.keys(patch).length > 0)
    await db.update(waConversations).set(patch).where(eq(waConversations.id, conversation.id));
  if (current === 'closed' && next !== 'closed')
    await db.insert(waConversationEvents).values({
      conversationId: conversation.id,
      kind: 'reopened',
      reason: 'mensagem_da_pessoa',
      createdAt: now,
    });
  return next;
}

/**
 * The change that gives a conversation back to Sofia (and lifts a pause): she answers the
 * person's next message, never one a person already had (by the database's clock).
 */
export const givenBack = (conversationId: string): PgUpdateSetSource<typeof waConversations> => ({
  attendance: 'sofia',
  // Marks a give-back: Sofia keeps a deal's conversation only after one.
  reason: SOFIA_GIVEN_BACK,
  sofiaPaused: false,
  sofiaMisses: 0,
  sofiaFacts: sql`jsonb_set(coalesce(${waConversations.sofiaFacts}, '{}'::jsonb), '{step}', 'null'::jsonb)`,
  sofiaReadUntil: sql`(select max(m.created_at) from wa_messages m where m.conversation_id = ${conversationId})`,
  sofiaDueAt: null,
});
