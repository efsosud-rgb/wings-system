import { graphErrorKindOf } from '@wings/shared';
import type { Env } from '../../env.js';

/**
 * The Instagram Graph calls of parte 1 (docs/prospeccao/instagram.md §5.3): the one private reply
 * to a comment and the permalink of Wings' own post. Plain HTTP, never throws; the token travels in
 * the Authorization header only, never in a URL, a log or an answer. A reply is sent once: a
 * timeout, a 5xx or an answer without `message_id` may have reached the person and is `unknown`,
 * never sent again. Only a certain limit error (the message did not go) may be tried later.
 */

export const INSTAGRAM_GRAPH_VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${INSTAGRAM_GRAPH_VERSION}`;
const TIMEOUT_MS = 15_000;

export interface InstagramMessagingConfig {
  token: string;
  accountId: string;
}

/** The reply can leave once the switch is on and the Instagram-only token and account are set. */
export function instagramMessagingOf(env: Env): InstagramMessagingConfig | null {
  if (env.INSTAGRAM_AUTO_REPLY_ENABLED !== 'true') return null;
  if (!env.INSTAGRAM_MESSAGING_TOKEN || !env.INSTAGRAM_ACCOUNT_ID) return null;
  return { token: env.INSTAGRAM_MESSAGING_TOKEN, accountId: env.INSTAGRAM_ACCOUNT_ID };
}

export type PrivateReplyOutcome =
  | { kind: 'sent'; messageId: string }
  /** Meta said "wait": the message did not go. */
  | { kind: 'rate_limited'; code: string }
  /** Meta refused (permission, token, comment gone, 7 days passed on its side): not tried again. */
  | { kind: 'failed'; code: string }
  /** It may have reached the person: never sent again. */
  | { kind: 'unknown'; code: string };

/** Meta's limit codes, plus 80006 (messaging) and HTTP 429 (spec PA, annex 3 §5.6). */
const isLimit = (status: number, error: { code?: unknown } | undefined) =>
  status === 429 || error?.code === 80006 || graphErrorKindOf(error) === 'rate_limit';

/** `POST /<IG_ID>/messages` with `recipient.comment_id`: one call, whatever happens. */
export async function sendPrivateReply(
  fetchImpl: typeof fetch,
  config: InstagramMessagingConfig,
  commentId: string,
  text: string,
): Promise<PrivateReplyOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${GRAPH}/${config.accountId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unknown', code: 'sem_resposta' };
  }
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.ok) {
    const messageId = parsed?.message_id;
    return typeof messageId === 'string' && messageId
      ? { kind: 'sent', messageId }
      : { kind: 'unknown', code: 'sem_message_id' };
  }
  const error = (parsed?.error ?? undefined) as { code?: unknown } | undefined;
  const code = typeof error?.code === 'number' ? String(error.code) : `http_${response.status}`;
  if (response.status >= 500) return { kind: 'unknown', code };
  if (isLimit(response.status, error)) return { kind: 'rate_limited', code };
  return { kind: 'failed', code };
}

/** The public link of one of Wings' posts (or ads); null when Meta does not give it. */
export async function mediaPermalink(
  fetchImpl: typeof fetch,
  token: string,
  mediaId: string,
): Promise<string | null> {
  if (!/^\d{1,40}$/.test(mediaId)) return null;
  try {
    const response = await fetchImpl(`${GRAPH}/${mediaId}?fields=permalink`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { permalink?: unknown } | null;
    const link = body?.permalink;
    return typeof link === 'string' && link.startsWith('https://www.instagram.com/') ? link : null;
  } catch {
    return null;
  }
}
