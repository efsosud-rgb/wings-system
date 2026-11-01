import { normalizeBrazilianPhone, type IgWebhookKind } from '@wings/shared';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * What the Meta webhook sends about comments on Wings' posts and ads and about the Direct
 * (docs/prospeccao/instagram.md §5.1, §5.5), read tolerantly. NOT verified live: the field names
 * follow Meta's published examples (comments: `comment_id` or `id`, `from`, `media`; messaging:
 * `sender`, `message`) until the first test event arrives.
 */

export interface IgWebhookEvent {
  /** One id per event: a repeat of Meta's (or a boosted post's second notice) is dropped. */
  eventKey: string;
  kind: IgWebhookKind;
  igAccountId: string;
  occurredAt: Date | null;
  /** The event's own piece (a `change.value` or a `messaging` item), never the whole POST. */
  payload: unknown;
}

const record = z.record(z.string(), z.unknown());
const bodySchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      time: z.number().optional(),
      changes: z.array(z.object({ field: z.string(), value: record })).optional(),
      messaging: z.array(record).optional(),
    }),
  ),
});

/** Meta mixes seconds (`entry.time`) and milliseconds (`timestamp`). */
const dateOf = (value: unknown): Date | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value > 1e12 ? value : value * 1000)
    : null;

const hashOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

/**
 * The events of one POST, Instagram only. Comments and Direct messages (and the echo of what Wings
 * sent); every other field (mentions, live comments, reactions, reads) is left out: the parte 1
 * does not use it and nothing about the person is kept for nothing.
 */
export function instagramWebhookEventsOf(body: unknown): IgWebhookEvent[] {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success || parsed.data.object !== 'instagram') return [];
  return parsed.data.entry.flatMap((entry) => {
    const changes = (entry.changes ?? [])
      .filter((change) => change.field === 'comments')
      .map((change): IgWebhookEvent => {
        const id = change.value.comment_id ?? change.value.id;
        return {
          // No id: stored all the same, and the queue marks it failed (`payload_invalido`).
          eventKey:
            typeof id === 'string' && id
              ? `comment:${id}`
              : `comment:sem-id:${hashOf(change.value)}`,
          kind: 'comment',
          igAccountId: entry.id,
          occurredAt: dateOf(entry.time),
          payload: change.value,
        };
      });
    const messaging = (entry.messaging ?? []).flatMap((item): IgWebhookEvent[] => {
      const message = record.safeParse(item.message);
      const mid = message.success ? message.data.mid : undefined;
      if (!message.success || typeof mid !== 'string' || !mid) return [];
      const echo = message.data.is_echo === true;
      return [
        {
          eventKey: `${echo ? 'echo' : 'message'}:${mid}`,
          kind: echo ? 'echo' : 'message',
          igAccountId: entry.id,
          occurredAt: dateOf(item.timestamp) ?? dateOf(entry.time),
          payload: item,
        },
      ];
    });
    return [...changes, ...messaging];
  });
}

const commentSchema = z.object({
  id: z.string().min(1).optional(),
  comment_id: z.string().min(1).optional(),
  text: z.string().optional(),
  from: z.object({ id: z.string().min(1), username: z.string().optional() }),
  parent_id: z.string().optional(),
  media: z
    .object({
      id: z.string().optional(),
      media_product_type: z.string().optional(),
      ad_id: z.string().optional(),
      ad_title: z.string().optional(),
      original_media_id: z.string().optional(),
    })
    .optional(),
});

export interface InstagramComment {
  commentId: string;
  text: string;
  /** The commenter's Instagram-scoped id (IGSID): the person's key, the @ is only a label. */
  fromId: string;
  fromUsername: string | null;
  parentId: string | null;
  mediaId: string | null;
  mediaProductType: string | null;
  /** Absent on a dynamic ad (Meta does not send it): the comment counts as a post's. */
  adId: string | null;
}

/** A comment event, or null when it lacks the comment's id or the commenter's. */
export function parseInstagramComment(payload: unknown): InstagramComment | null {
  const parsed = commentSchema.safeParse(payload);
  if (!parsed.success) return null;
  const value = parsed.data;
  const commentId = value.comment_id ?? value.id;
  if (!commentId) return null;
  return {
    commentId,
    text: value.text ?? '',
    fromId: value.from.id,
    fromUsername: value.from.username?.trim().replace(/^@/, '').toLowerCase() || null,
    parentId: value.parent_id ?? null,
    mediaId: value.media?.original_media_id ?? value.media?.id ?? null,
    mediaProductType: value.media?.media_product_type ?? null,
    adId: value.media?.ad_id || null,
  };
}

const messageSchema = z.object({
  sender: z.object({ id: z.string().min(1) }),
  recipient: z.object({ id: z.string().min(1) }),
  timestamp: z.number().optional(),
  message: z.object({
    mid: z.string().min(1),
    text: z.string().optional(),
    is_echo: z.boolean().optional(),
  }),
});

export interface InstagramMessage {
  senderId: string;
  recipientId: string;
  mid: string;
  /** Null for a sticker, an audio or a photo: only the window moves. */
  text: string | null;
  isEcho: boolean;
  at: Date | null;
}

export function parseInstagramMessage(payload: unknown): InstagramMessage | null {
  const parsed = messageSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { sender, recipient, timestamp, message } = parsed.data;
  return {
    senderId: sender.id,
    recipientId: recipient.id,
    mid: message.mid,
    text: message.text?.trim() || null,
    isEcho: message.is_echo === true,
    at: dateOf(timestamp),
  };
}

// --- what the person wrote in the Direct (§5.5) --------------------------------------------

const EMAIL_IN_TEXT = /[^\s@<>()[\]:;,]+@[^\s@<>()[\]:;,]+\.[a-z]{2,}/i;
const PHONE_IN_TEXT = /\+?\(?\d(?:[\d\s().-]{6,}\d)/g;

/**
 * The phone and the e-mail the person wrote to us in the Direct, the only ones that may enter the
 * lead (never one found anywhere else). A phone counts only when it is a Brazilian number.
 */
export function contactsInText(text: string): { phone: string | null; email: string | null } {
  const email = text.match(EMAIL_IN_TEXT)?.[0]?.toLowerCase() ?? null;
  const phone =
    [...text.matchAll(PHONE_IN_TEXT)]
      .map((match) => normalizeBrazilianPhone(match[0]))
      .find((value): value is string => value !== null) ?? null;
  return { phone, email };
}
