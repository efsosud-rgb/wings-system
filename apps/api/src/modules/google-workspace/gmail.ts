import { randomBytes } from 'node:crypto';

/**
 * Gmail API `users.messages.send`, with the person's own token: the message
 * leaves from their address and lands in their "Enviados", so the lead's
 * reply reaches their inbox like any other e-mail. Plain `fetch`, no library.
 * The RFC 5322 message is built here (text + HTML alternative); its
 * Message-ID is ours, so a reply's In-Reply-To can be matched later.
 */

export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export class GmailError extends Error {
  constructor(
    readonly code: 'unauthorized' | 'forbidden' | 'rejected' | 'unreachable',
    readonly status: number | null = null,
  ) {
    super(code);
  }
}

export interface GmailMessageInput {
  from: { email: string; name: string | null };
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Ours: "<id@domain>"; cited by replies in In-Reply-To. */
  messageId: string;
  /** To keep an answer in the same Gmail thread. */
  threadId?: string | null;
  inReplyTo?: string | null;
}

export interface GmailSent {
  gmailMessageId: string;
  gmailThreadId: string;
}

/** "<random@wingssystem.online>", unique per message. */
export const newMessageId = (domain: string) => `<${randomBytes(16).toString('hex')}@${domain}>`;

/** RFC 2047 encoded word, so names and subjects may carry accents. */
const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

const sanitizeAddress = (email: string) => email.replace(/[\r\n<>]/g, '').trim();

export function buildRawMessage(input: GmailMessageInput): string {
  const boundary = `wings-${randomBytes(12).toString('hex')}`;
  const from = input.from.name
    ? `${encodeHeader(input.from.name)} <${sanitizeAddress(input.from.email)}>`
    : sanitizeAddress(input.from.email);
  const headers = [
    `From: ${from}`,
    `To: ${sanitizeAddress(input.to)}`,
    `Subject: ${encodeHeader(input.subject.replace(/[\r\n]/g, ' '))}`,
    `Message-ID: ${input.messageId}`,
    ...(input.inReplyTo
      ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`]
      : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=UTF-8`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body, 'utf8')
        .toString('base64')
        .replace(/(.{76})/g, '$1\r\n'),
    ].join('\r\n');
  return [
    headers.join('\r\n'),
    '',
    part('text/plain', input.text),
    part('text/html', input.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export async function sendGmail(
  transport: typeof fetch,
  accessToken: string,
  input: GmailMessageInput,
): Promise<GmailSent> {
  const raw = Buffer.from(buildRawMessage(input), 'utf8').toString('base64url');
  let response: Response;
  try {
    response = await transport(GMAIL_SEND_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw, ...(input.threadId ? { threadId: input.threadId } : {}) }),
    });
  } catch {
    throw new GmailError('unreachable');
  }
  if (response.status === 401) throw new GmailError('unauthorized', 401);
  if (response.status === 403) throw new GmailError('forbidden', 403);
  if (!response.ok) throw new GmailError('rejected', response.status);
  const body = (await response.json().catch(() => ({}))) as { id?: unknown; threadId?: unknown };
  if (typeof body.id !== 'string' || typeof body.threadId !== 'string') {
    throw new GmailError('rejected', response.status);
  }
  return { gmailMessageId: body.id, gmailThreadId: body.threadId };
}
