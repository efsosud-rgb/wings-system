import { randomBytes } from 'node:crypto';
import { contentDisposition } from '../../lib/storage/index.js';

/**
 * Gmail API `users.messages.send`, with the person's own token: the message
 * leaves from their address and lands in their "Enviados", so the lead's
 * reply reaches their inbox like any other e-mail. Plain `fetch`, no library.
 * The RFC 5322 message is built here (text + HTML alternative, inside a
 * multipart/mixed with the attachments when there are any); its Message-ID is
 * ours, so a reply's In-Reply-To can be matched later.
 */

export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
/** The media upload of the same method: the JSON `raw` one only takes small messages. */
export const GMAIL_UPLOAD_URL =
  'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';

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
  attachments?: MailAttachment[];
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
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

const base64Lines = (bytes: Buffer) => bytes.toString('base64').replace(/(.{76})/g, '$1\r\n');

export function buildRawMessage(input: GmailMessageInput): string {
  const boundary = `wings-${randomBytes(12).toString('hex')}`;
  const mixed = input.attachments?.length ? `wings-${randomBytes(12).toString('hex')}` : null;
  const from = input.from.name
    ? `${encodeHeader(input.from.name)} <${sanitizeAddress(input.from.email)}>`
    : sanitizeAddress(input.from.email);
  const alternative = `multipart/alternative; boundary="${boundary}"`;
  const headers = [
    `From: ${from}`,
    `To: ${sanitizeAddress(input.to)}`,
    `Subject: ${encodeHeader(input.subject.replace(/[\r\n]/g, ' '))}`,
    `Message-ID: ${input.messageId}`,
    ...(input.inReplyTo
      ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`]
      : []),
    'MIME-Version: 1.0',
    `Content-Type: ${mixed ? `multipart/mixed; boundary="${mixed}"` : alternative}`,
  ];
  const part = (type: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=UTF-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(Buffer.from(body, 'utf8')),
    ].join('\r\n');
  const text = [
    part('text/plain', input.text),
    part('text/html', input.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  if (!mixed) return [headers.join('\r\n'), '', text].join('\r\n');
  const attached = (input.attachments ?? []).map((file) => {
    const name = contentDisposition('attachment', file.filename.replace(/[\r\n]/g, ' '));
    return [
      `--${mixed}`,
      `Content-Type: ${file.contentType
        .split(';')[0]!
        .replace(/[\r\n]/g, '')
        .trim()}`,
      `Content-Disposition: ${name}`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(file.content),
    ].join('\r\n');
  });
  return [
    headers.join('\r\n'),
    '',
    `--${mixed}`,
    `Content-Type: ${alternative}`,
    '',
    text,
    ...attached,
    `--${mixed}--`,
    '',
  ].join('\r\n');
}

export async function sendGmail(
  transport: typeof fetch,
  accessToken: string,
  input: GmailMessageInput,
): Promise<GmailSent> {
  const message = buildRawMessage(input);
  const raw = Buffer.from(message, 'utf8').toString('base64url');
  // shortcut: the media upload carries no threadId; nothing sends attachments in a thread yet.
  const upload = Boolean(input.attachments?.length);
  let response: Response;
  try {
    response = await transport(upload ? GMAIL_UPLOAD_URL : GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': upload ? 'message/rfc822' : 'application/json',
      },
      body: upload
        ? message
        : JSON.stringify({ raw, ...(input.threadId ? { threadId: input.threadId } : {}) }),
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
