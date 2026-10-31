import {
  EMAIL_ATTACHMENTS_MAX_BYTES,
  EMAIL_ATTACHMENTS_MAX_COUNT,
  emailAttachmentRefusal,
  GMAIL_READ_SCOPE,
  leadHidesWings,
  normalizeEmail,
  type LeadEmailReceivedAttachment,
} from '@wings/shared';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  crmContacts,
  crmEmailInbound,
  crmEmailOutbox,
  crmNotifications,
  googleWorkspaceConnections,
  leadContacts,
  leadEvents,
  leads,
} from '../../db/schema/index.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import type { DriveAccess } from '../drive/access.js';
import {
  gmailAttachment,
  gmailHistoryPoint,
  gmailInboxHistory,
  gmailMessage,
  gmailReferences,
  gmailSearchFrom,
  GmailReadError,
  messageIdsIn,
  type GmailMessage,
} from '../google-workspace/gmail-read.js';
import { GoogleOAuthError } from '../google-workspace/oauth.js';
import { accessTokenFor, type GoogleWorkspaceDeps } from '../google-workspace/service.js';
import { contactBlock } from './contact-block.js';
import { managersAndBoard } from './crm-alerts.js';
import { parseFrom, textOfHtml, withoutQuotes } from './email-text.js';
import { storeLeadFile } from './files.js';

/**
 * The leads' e-mail replies, read from each seller's own Gmail (t083, docs/crm/automacoes.md
 * "E-mail recebido"). A periodic, incremental read: Gmail's history of the inbox from the point
 * the last read stopped, per mailbox, with a ceiling of calls per pass. Only three kinds of message
 * come in: one in the thread of an e-mail the system sent (or of a reply already kept), one citing
 * our Message-ID in In-Reply-To/References, and one from an address of a deal of this seller
 * (found by Gmail's own search). Anything else is never fetched beyond its ids and those two
 * reference headers, and nothing of it is kept. Expansão with a brand reads nothing. Logs carry
 * counts and codes only.
 */

/** About this many Gmail calls per mailbox per pass; a message under way is finished. */
export const MAX_CALLS_PER_MAILBOX = 60;
/** Addresses per Gmail search (the query stays short). */
const SEARCH_CHUNK = 20;

export interface RepliesDeps {
  db: Database;
  google: GoogleWorkspaceDeps;
  storage: ObjectStorage | null;
  maxFileBytes: number;
  log: (facts: Record<string, unknown>) => void;
}

export interface MailboxResult {
  kept: number;
  calls: number;
  /** A code when the pass stopped early: needs_reconnect, history_expired, gmail_forbidden… */
  error?: string;
}

type Match =
  | { by: 'thread'; leadId: string; outboxId: string | null }
  | { by: 'in_reply_to'; leadId: string; outboxId: string }
  | { by: 'contact' };

type Connection = typeof googleWorkspaceConnections.$inferSelect;

/** Everyone connected whose consent includes reading the mailbox. */
export const mailboxesToRead = (db: Database) =>
  db
    .select()
    .from(googleWorkspaceConnections)
    .where(
      and(
        eq(googleWorkspaceConnections.state, 'connected'),
        sql`${GMAIL_READ_SCOPE} = any(${googleWorkspaceConnections.scopes})`,
      ),
    );

/** The addresses of this seller's open deals (never Expansão with a brand) → the deal, newest first. */
async function contactsOf(db: Database, employeeId: string): Promise<Map<string, string>> {
  const open = and(eq(leads.ownerEmployeeId, employeeId), isNull(leads.won));
  const own = await db
    .select({ id: leads.id, email: leads.email, pipeline: leads.pipeline, brand: leads.brand })
    .from(leads)
    .where(open)
    .orderBy(desc(leads.updatedAt));
  const linked = await db
    .select({
      id: leads.id,
      email: crmContacts.email,
      pipeline: leads.pipeline,
      brand: leads.brand,
    })
    .from(leadContacts)
    .innerJoin(leads, eq(leads.id, leadContacts.leadId))
    .innerJoin(crmContacts, eq(crmContacts.id, leadContacts.contactId))
    .where(and(open, isNull(crmContacts.mergedIntoId)))
    .orderBy(desc(leads.updatedAt));
  const map = new Map<string, string>();
  for (const row of [...own, ...linked]) {
    const email = normalizeEmail(row.email);
    if (email && !leadHidesWings(row) && !map.has(email)) map.set(email, row.id);
  }
  return map;
}

/** Threads of this mailbox the deals already know: an e-mail we sent, or a reply already kept. */
async function knownThreads(
  db: Database,
  employeeId: string,
  mailbox: string,
  threadIds: string[],
): Promise<Map<string, { leadId: string; outboxId: string | null }>> {
  const map = new Map<string, { leadId: string; outboxId: string | null }>();
  if (threadIds.length === 0) return map;
  const sent = await db
    .select({
      thread: crmEmailOutbox.gmailThreadId,
      leadId: crmEmailOutbox.leadId,
      id: crmEmailOutbox.id,
    })
    .from(crmEmailOutbox)
    .where(
      and(
        sql`lower(${crmEmailOutbox.fromEmail}) = ${mailbox}`,
        inArray(crmEmailOutbox.gmailThreadId, threadIds),
      ),
    )
    .orderBy(desc(crmEmailOutbox.createdAt));
  const kept = await db
    .select({ thread: crmEmailInbound.gmailThreadId, leadId: crmEmailInbound.leadId })
    .from(crmEmailInbound)
    .where(
      and(
        eq(crmEmailInbound.mailboxEmployeeId, employeeId),
        inArray(crmEmailInbound.gmailThreadId, threadIds),
      ),
    );
  for (const row of sent)
    if (row.thread && !map.has(row.thread))
      map.set(row.thread, { leadId: row.leadId, outboxId: row.id });
  for (const row of kept)
    if (!map.has(row.thread)) map.set(row.thread, { leadId: row.leadId, outboxId: null });
  return map;
}

/** The system's e-mail one of these Message-IDs names, if any. */
async function outboxCited(db: Database, ids: string[]) {
  if (ids.length === 0) return null;
  const [row] = await db
    .select({ id: crmEmailOutbox.id, leadId: crmEmailOutbox.leadId })
    .from(crmEmailOutbox)
    .where(inArray(crmEmailOutbox.messageId, ids))
    .orderBy(desc(crmEmailOutbox.createdAt))
    .limit(1);
  return row ?? null;
}

/** The deal's files, written as the mailbox's owner, within the outgoing e-mail's limits. */
async function keepAttachments(
  deps: RepliesDeps,
  token: string,
  message: GmailMessage,
  lead: { id: string; name: string | null },
  employeeId: string,
  spend: () => void,
): Promise<LeadEmailReceivedAttachment[]> {
  const access: DriveAccess = {
    employeeId,
    all: false,
    departments: new Set(['comercial']),
    writeDepartments: new Set(['comercial']),
    clientView: false,
    dealFolders: true,
    write: true,
    manage: false,
  };
  const driveDeps = {
    db: deps.db,
    storage: deps.storage,
    maxFileBytes: deps.maxFileBytes,
    now: deps.google.now,
  };
  let total = 0;
  const out: LeadEmailReceivedAttachment[] = [];
  for (const [index, file] of message.attachments.entries()) {
    const entry = { fileId: null, name: file.filename, byteSize: file.size };
    if (emailAttachmentRefusal(file.filename, file.mimeType)) {
      out.push({ ...entry, refused: 'file_type' });
      continue;
    }
    if (index >= EMAIL_ATTACHMENTS_MAX_COUNT || total + file.size > EMAIL_ATTACHMENTS_MAX_BYTES) {
      out.push({ ...entry, refused: 'too_large' });
      continue;
    }
    total += file.size;
    try {
      spend();
      const bytes = await gmailAttachment(
        deps.google.transport,
        token,
        message.id,
        file.attachmentId,
      );
      const stored = await storeLeadFile(driveDeps, access, lead, {
        name: file.filename,
        mimeType: file.mimeType,
        bytes,
      });
      out.push({ ...entry, fileId: stored.fileId, byteSize: bytes.length, refused: null });
    } catch {
      // No storage, or Gmail refused this one: the reply is kept, the file is named as not kept.
      out.push({ ...entry, refused: 'unavailable' });
    }
  }
  return out;
}

/** Tells the deal's owner (or, with none, the managers) as a new message is told; never by e-mail. */
async function announce(
  db: Database,
  lead: { id: string; ownerEmployeeId: string | null },
  inboundId: string,
) {
  const block = await contactBlock(db, 'email', { leadId: lead.id });
  const people = lead.ownerEmployeeId ? [lead.ownerEmployeeId] : await managersAndBoard(db);
  if (people.length === 0) return;
  await db
    .insert(crmNotifications)
    .values(
      people.map((person) => ({
        recipientEmployeeId: person,
        leadId: lead.id,
        kind: 'lead_email',
        message: block.blocked
          ? `O lead respondeu por e-mail. Atenção, não me contate por e-mail: ${block.reason ?? 'trava ativa.'}`
          : 'O lead respondeu por e-mail.',
        dedupeKey: `lead_email:${inboundId}:${person}`,
      })),
    )
    .onConflictDoNothing();
}

/** One message that matched: read whole, kept in its deal with its files, and announced. */
async function keepMessage(
  deps: RepliesDeps,
  input: { token: string; employeeId: string; mailbox: string; id: string; match: Match },
  contacts: () => Promise<Map<string, string>>,
  spend: () => void,
): Promise<boolean> {
  const { db } = deps;
  spend();
  const message = await gmailMessage(deps.google.transport, input.token, input.id);
  if (message.labelIds.includes('SENT') || message.labelIds.includes('DRAFT')) return false;
  const from = parseFrom(message.headers.get('from'));
  if (!from || from.email === input.mailbox) return false;
  const refs = messageIdsIn(
    `${message.headers.get('in-reply-to') ?? ''} ${message.headers.get('references') ?? ''}`,
  );
  const cited = input.match.by === 'in_reply_to' ? null : await outboxCited(db, refs);
  const leadId =
    input.match.by === 'contact' ? (await contacts()).get(from.email) : input.match.leadId;
  if (!leadId) return false;
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, leadId) });
  // Expansão with a brand: nothing of the lead's mail is kept (the brand rule).
  if (!lead || leadHidesWings(lead)) return false;
  const outboxId =
    input.match.by === 'contact'
      ? (cited?.id ?? null)
      : (input.match.outboxId ?? cited?.id ?? null);
  const text = message.text ?? (message.html ? textOfHtml(message.html) : '');
  const [row] = await db
    .insert(crmEmailInbound)
    .values({
      leadId: lead.id,
      mailboxEmployeeId: input.employeeId,
      gmailMessageId: message.id,
      gmailThreadId: message.threadId,
      messageId: messageIdsIn(message.headers.get('message-id') ?? '')[0] ?? null,
      outboxId,
      matchedBy: input.match.by,
      fromEmail: from.email,
      fromName: from.name,
      subject: (message.headers.get('subject') ?? '').slice(0, 500),
      body: withoutQuotes(text),
      receivedAt: message.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: crmEmailInbound.id, subject: crmEmailInbound.subject });
  // Already kept (a repeated pass, or the same reply in another seller's mailbox).
  if (!row) return false;
  const attachments = await keepAttachments(
    deps,
    input.token,
    message,
    lead,
    input.employeeId,
    spend,
  );
  if (attachments.length > 0)
    await db.update(crmEmailInbound).set({ attachments }).where(eq(crmEmailInbound.id, row.id));
  await db.insert(leadEvents).values({
    leadId: lead.id,
    kind: 'lead.email_received',
    actorEmployeeId: null,
    detail: {
      inboundId: row.id,
      matchedBy: input.match.by,
      subject: row.subject,
      from: from.name ?? from.email,
      attachments: attachments.map(({ name, byteSize, refused }) => ({ name, byteSize, refused })),
    },
  });
  await announce(db, lead, row.id);
  return true;
}

/** One pass over one mailbox, from where the last one stopped. */
export async function readMailbox(
  deps: RepliesDeps,
  connection: Connection,
): Promise<MailboxResult> {
  const { db, google } = deps;
  const employeeId = connection.employeeId;
  const result: MailboxResult = { kept: 0, calls: 0 };
  const spend = () => void (result.calls += 1);
  const save = (values: Partial<Connection>) =>
    db
      .update(googleWorkspaceConnections)
      .set({ ...values, gmailReadAt: google.now() })
      .where(eq(googleWorkspaceConnections.id, connection.id));

  let token: string;
  let mailbox: string;
  try {
    const access = await accessTokenFor(google, employeeId);
    token = access.accessToken;
    mailbox = (access.email ?? '').toLowerCase();
  } catch (error) {
    if (error instanceof GoogleOAuthError) return { ...result, error: error.code };
    throw error;
  }

  let cursor = connection.gmailHistoryId;
  try {
    if (!cursor) {
      // The first pass only marks where the reading starts: older mail is not read.
      spend();
      await save({
        gmailHistoryId: await gmailHistoryPoint(google.transport, token),
        gmailReadError: null,
      });
      return result;
    }
    let contactsCache: Map<string, string> | null = null;
    const contacts = async () => (contactsCache ??= await contactsOf(db, employeeId));
    // A margin over the last pass: the search only narrows, the history's ids decide.
    const since = new Date((connection.gmailReadAt ?? google.now()).getTime() - 2 * 86_400_000);
    let pageToken: string | null = null;
    let searches = 0;
    pages: do {
      spend();
      const page = await gmailInboxHistory(google.transport, token, cursor, pageToken);
      const ids = [...new Set(page.records.flatMap((r) => r.messages.map((m) => m.id)))];
      const stored = ids.length
        ? await db
            .select({ id: crmEmailInbound.gmailMessageId })
            .from(crmEmailInbound)
            .where(
              and(
                eq(crmEmailInbound.mailboxEmployeeId, employeeId),
                inArray(crmEmailInbound.gmailMessageId, ids),
              ),
            )
        : [];
      const done = new Set(stored.map((s) => s.id));
      const threads = await knownThreads(
        db,
        employeeId,
        mailbox,
        page.records.flatMap((r) => r.messages.map((m) => m.threadId)),
      );
      // Messages from the deals' addresses: Gmail's search decides, only ids come back.
      const fromContacts = new Set<string>();
      const open = page.records.flatMap((r) =>
        r.messages.filter((m) => !done.has(m.id) && !threads.has(m.threadId)),
      );
      if (open.length > 0) {
        const addresses = [...(await contacts()).keys()];
        for (let i = 0; i < addresses.length; i += SEARCH_CHUNK) {
          spend();
          searches += 1;
          for (const id of await gmailSearchFrom(
            google.transport,
            token,
            addresses.slice(i, i + SEARCH_CHUNK),
            since,
          ))
            fromContacts.add(id);
        }
      }
      for (const record of page.records) {
        // The searches do not count here: with many deals they alone must not stall the reading.
        if (result.calls - searches >= MAX_CALLS_PER_MAILBOX) break pages;
        for (const { id, threadId } of record.messages) {
          if (done.has(id)) continue;
          done.add(id);
          const thread = threads.get(threadId);
          let match: Match | null = thread
            ? { by: 'thread', ...thread }
            : fromContacts.has(id)
              ? { by: 'contact' }
              : null;
          if (!match) {
            spend();
            const cited = await outboxCited(db, await gmailReferences(google.transport, token, id));
            if (cited) match = { by: 'in_reply_to', leadId: cited.leadId, outboxId: cited.id };
          }
          if (
            match &&
            (await keepMessage(deps, { token, employeeId, mailbox, id, match }, contacts, spend))
          )
            result.kept += 1;
        }
        cursor = record.id;
      }
      pageToken = page.nextPageToken;
      if (!pageToken) cursor = page.historyId;
    } while (pageToken);
    await save({ gmailHistoryId: cursor, gmailReadError: null });
  } catch (error) {
    if (!(error instanceof GmailReadError)) throw error;
    if (error.code === 'history_expired') {
      // Gmail forgot the point (about a week without a read): start again from now.
      const point = await gmailHistoryPoint(google.transport, token).catch(() => null);
      await save({ gmailHistoryId: point, gmailReadError: 'history_expired' });
    } else {
      await save({ gmailHistoryId: cursor, gmailReadError: `gmail_${error.code}` });
    }
    return { ...result, error: error.code };
  }
  return result;
}

/** One pass over every mailbox that may be read; one mailbox's failure does not stop the others. */
export async function readAllMailboxes(deps: RepliesDeps) {
  const totals = { mailboxes: 0, kept: 0, calls: 0, failed: 0 };
  for (const connection of await mailboxesToRead(deps.db)) {
    totals.mailboxes += 1;
    try {
      const one = await readMailbox(deps, connection);
      totals.kept += one.kept;
      totals.calls += one.calls;
      if (one.error) totals.failed += 1;
    } catch (error) {
      totals.failed += 1;
      deps.log({
        job: 'crm-email-replies',
        connection: connection.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return totals;
}

const LOCK_KEY = 'crm:email-replies';

/** Every `minutes`, one pass at a time in this process and across replicas (an advisory lock). */
export function startEmailRepliesScheduler(deps: RepliesDeps & { minutes: number }) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await deps.db.transaction(async (tx) => {
        const lock = await tx.execute<{ got: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as got`,
        );
        if (!lock.rows[0]?.got) return;
        const totals = await readAllMailboxes(deps);
        if (totals.mailboxes > 0) deps.log({ job: 'crm-email-replies', ...totals });
      });
    } catch (error) {
      deps.log({
        job: 'crm-email-replies',
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.minutes * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
