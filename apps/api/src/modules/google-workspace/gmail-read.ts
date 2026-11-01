/**
 * Gmail API reads, with the person's own token (scope `gmail.readonly`), for the leads' replies
 * (t083, docs/crm/automacoes.md "E-mail recebido"). Plain `fetch`, no library. Only what the
 * reading needs: the mailbox's history point, the ids added since then, a search by sender, two
 * reference headers (and the arrival time) of one message, one whole message and one attachment. Every answer is cut to
 * the fields asked for (`fields`), so a message the reading does not keep never brings its sender,
 * subject or text along. Nothing here logs an address, a subject or a text.
 */

import { GOOGLE_FILE_TIMEOUT_MS, GOOGLE_TIMEOUT_MS } from './oauth.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailReadError extends Error {
  constructor(
    /** history_expired (404 on the history point), unauthorized, forbidden, rejected, unreachable. */
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(code);
  }
}

async function get<T>(
  transport: typeof fetch,
  token: string,
  path: string,
  query: [string, string][],
  timeoutMs = GOOGLE_TIMEOUT_MS,
): Promise<T> {
  const url = `${GMAIL_API}${path}?${new URLSearchParams(query).toString()}`;
  // The time limit covers the answer's body too: a stalled read must not hold the pass.
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await transport(url, { headers: { authorization: `Bearer ${token}` }, signal });
  } catch {
    throw new GmailReadError('unreachable');
  }
  if (response.status === 401) throw new GmailReadError('unauthorized', 401);
  if (response.status === 403) throw new GmailReadError('forbidden', 403);
  if (!response.ok) throw new GmailReadError('rejected', response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new GmailReadError(signal.aborted ? 'unreachable' : 'rejected', response.status);
  }
}

/** The mailbox's current history point: where the first reading starts. */
export async function gmailHistoryPoint(transport: typeof fetch, token: string): Promise<string> {
  const body = await get<{ historyId?: unknown }>(transport, token, '/profile', [
    ['fields', 'historyId'],
  ]);
  if (typeof body.historyId !== 'string') throw new GmailReadError('rejected');
  return body.historyId;
}

export interface HistoryPage {
  /** In order; each record's id is a point the next reading may start after. */
  records: { id: string; messages: { id: string; threadId: string }[] }[];
  /** The mailbox's point when the last page was read. */
  historyId: string;
  nextPageToken: string | null;
}

/** Messages added to the inbox after `start` (ids only). A point too old answers `history_expired`. */
export async function gmailInboxHistory(
  transport: typeof fetch,
  token: string,
  start: string,
  pageToken: string | null,
): Promise<HistoryPage> {
  let body: {
    history?: { id: string; messagesAdded?: { message: { id: string; threadId: string } }[] }[];
    historyId?: string;
    nextPageToken?: string;
  };
  try {
    body = await get(transport, token, '/history', [
      ['startHistoryId', start],
      ['historyTypes', 'messageAdded'],
      ['labelId', 'INBOX'],
      ['maxResults', '100'],
      ['fields', 'history(id,messagesAdded/message(id,threadId)),historyId,nextPageToken'],
      ...(pageToken ? ([['pageToken', pageToken]] as [string, string][]) : []),
    ]);
  } catch (error) {
    // Gmail keeps the history for about a week: an older point has to start again from now.
    if (error instanceof GmailReadError && error.status === 404)
      throw new GmailReadError('history_expired', 404);
    throw error;
  }
  return {
    records: (body.history ?? []).map((record) => ({
      id: record.id,
      messages: (record.messagesAdded ?? []).map((added) => added.message),
    })),
    historyId: body.historyId ?? start,
    nextPageToken: body.nextPageToken ?? null,
  };
}

/** Ids of the inbox messages from any of these addresses since `after`: Gmail's own search filters. */
export async function gmailSearchFrom(
  transport: typeof fetch,
  token: string,
  addresses: string[],
  after: Date,
): Promise<string[]> {
  const from = addresses.map((a) => a.replace(/[\s()"{}]/g, '')).join(' OR ');
  const q = `in:inbox from:(${from}) after:${Math.floor(after.getTime() / 1000)}`;
  const body = await get<{ messages?: { id: string }[] }>(transport, token, '/messages', [
    ['q', q],
    ['maxResults', '500'],
    ['fields', 'messages(id)'],
  ]);
  return (body.messages ?? []).map((m) => m.id);
}

/**
 * In-Reply-To and References of one message, and when it arrived (to tell whether Gmail's search may
 * not have indexed it yet), and nothing else of it.
 */
export async function gmailReferences(
  transport: typeof fetch,
  token: string,
  id: string,
): Promise<{ ids: string[]; at: Date }> {
  const body = await get<{
    internalDate?: string;
    payload?: { headers?: { name: string; value: string }[] };
  }>(transport, token, `/messages/${encodeURIComponent(id)}`, [
    ['format', 'metadata'],
    ['metadataHeaders', 'In-Reply-To'],
    ['metadataHeaders', 'References'],
    ['fields', 'internalDate,payload/headers'],
  ]);
  return {
    ids: messageIdsIn(
      (body.payload?.headers ?? [])
        .filter((h) => /^(in-reply-to|references)$/i.test(h.name))
        .map((h) => h.value)
        .join(' '),
    ),
    at: new Date(Number(body.internalDate ?? Date.now())),
  };
}

/** The `<…>` ids in a header value, as written. */
export const messageIdsIn = (value: string) => value.match(/<[^<>\s]+>/g) ?? [];

interface Part {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: Part[];
}

export interface GmailAttachmentRef {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  receivedAt: Date;
  /** Header name in lower case → its first value. */
  headers: Map<string, string>;
  text: string | null;
  html: string | null;
  attachments: GmailAttachmentRef[];
}

const headerOf = (part: Part, name: string) =>
  part.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';

/** A part's text in its own charset (Brazilian mail often comes in ISO-8859-1). */
function decodeText(part: Part): string {
  const bytes = Buffer.from(part.body?.data ?? '', 'base64url');
  const charset = /charset="?([\w-]+)"?/i.exec(headerOf(part, 'content-type'))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** One whole message: its headers, its first text and HTML bodies, and its attachments (not their bytes). */
export async function gmailMessage(
  transport: typeof fetch,
  token: string,
  id: string,
): Promise<GmailMessage> {
  const body = await get<{
    id: string;
    threadId: string;
    labelIds?: string[];
    internalDate?: string;
    payload?: Part;
  }>(transport, token, `/messages/${encodeURIComponent(id)}`, [
    ['format', 'full'],
    ['fields', 'id,threadId,labelIds,internalDate,payload'],
  ]);
  const message: GmailMessage = {
    id: body.id,
    threadId: body.threadId,
    labelIds: body.labelIds ?? [],
    receivedAt: new Date(Number(body.internalDate ?? Date.now())),
    headers: new Map(),
    text: null,
    html: null,
    attachments: [],
  };
  for (const h of body.payload?.headers ?? []) {
    const name = h.name.toLowerCase();
    if (!message.headers.has(name)) message.headers.set(name, h.value);
  }
  const walk = (part: Part) => {
    const disposition = headerOf(part, 'content-disposition').toLowerCase();
    if (part.filename && part.body?.attachmentId) {
      // An inline image (a signature's logo) is part of the text's look, not a file the lead sent.
      if (!disposition.startsWith('inline'))
        message.attachments.push({
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType ?? 'application/octet-stream',
          size: part.body.size ?? 0,
        });
      return;
    }
    if (part.mimeType === 'text/plain' && message.text === null && !part.filename)
      message.text = decodeText(part);
    else if (part.mimeType === 'text/html' && message.html === null && !part.filename)
      message.html = decodeText(part);
    for (const child of part.parts ?? []) walk(child);
  };
  if (body.payload) walk(body.payload);
  return message;
}

/** One attachment's bytes. */
export async function gmailAttachment(
  transport: typeof fetch,
  token: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const body = await get<{ data?: string }>(
    transport,
    token,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    [['fields', 'data']],
    GOOGLE_FILE_TIMEOUT_MS,
  );
  return Buffer.from(body.data ?? '', 'base64url');
}
