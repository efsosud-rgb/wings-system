import {
  EMAIL_ATTACHMENTS_MAX_BYTES,
  EMAIL_ATTACHMENTS_MAX_COUNT,
  emailAttachmentRefusal,
  GMAIL_READ_SCOPE,
  isFreeMailDomain,
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
  employees,
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
 * (found by Gmail's own search). Anything else is never fetched beyond its ids, those two
 * reference headers and its arrival time, and nothing of it is kept. Expansão with a brand reads
 * nothing. A message from the Wings' own addresses (a colleague's "reply all") stays in the
 * conversation but is not the lead's reply: no history entry and no notice (Eric, 30/10). Logs
 * carry counts and codes only.
 */

/** About this many Gmail calls per mailbox per pass, searches included; a message under way is finished. */
export const MAX_CALLS_PER_MAILBOX = 60;
/**
 * A message that matched nothing but arrived this recently is looked at again in the next passes:
 * Gmail's search may not have indexed it yet, and the search is what finds a contact's e-mail.
 */
export const SEARCH_SETTLE_MS = 30 * 60_000;
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

/**
 * The Wings' own address: an employee's (login or connected Google account), or one on a connected
 * mailbox's Workspace domain. A webmail domain is never taken as the company's.
 */
async function isWingsAddress(db: Database, email: string): Promise<boolean> {
  const domain = email.slice(email.indexOf('@') + 1);
  const [employee] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(sql`lower(${employees.email}) = ${email}`)
    .limit(1);
  if (employee) return true;
  const [mailbox] = await db
    .select({ id: googleWorkspaceConnections.id })
    .from(googleWorkspaceConnections)
    .where(
      isFreeMailDomain(domain)
        ? sql`lower(${googleWorkspaceConnections.googleEmail}) = ${email}`
        : sql`split_part(lower(${googleWorkspaceConnections.googleEmail}), '@', 2) = ${domain}`,
    )
    .limit(1);
  return Boolean(mailbox);
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

/** One message that matched: read whole, kept in its deal with its files, and announced if the lead's. */
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
  // A colleague in the conversation: kept in it, with its files, but it is not the lead's reply.
  const colleague = await isWingsAddress(db, from.email);
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
  if (colleague) return true;
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

type Outcome = 'kept' | 'settled' | 'pending';

/**
 * One pass over one mailbox, from where the last one stopped. The point (`gmail_history_id`) only
 * moves past a history record once every message in it is settled, and the messages settled after
 * the point are kept aside (`gmail_history_seen`): a pass that stops at the ceiling, even inside a
 * record, or holds back a message the search may not have indexed yet, never jumps one.
 */
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
      .set(values)
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

  const start = connection.gmailHistoryId;
  if (!start) {
    // The first pass only marks where the reading starts: older mail is not read.
    try {
      spend();
      await save({
        gmailHistoryId: await gmailHistoryPoint(google.transport, token),
        gmailHistorySeen: [],
        gmailReadAt: google.now(),
        gmailReadError: null,
      });
    } catch (error) {
      if (!(error instanceof GmailReadError)) throw error;
      await save({ gmailReadError: `gmail_${error.code}` });
      return { ...result, error: error.code };
    }
    return result;
  }

  let cursor = start;
  /** Settled messages after the cursor: by an earlier pass, or by this one. */
  const seen = new Set(connection.gmailHistorySeen);
  /** Messages of the records the cursor moved past in this pass: no longer needed in `seen`. */
  const passed = new Set<string>();
  let held = false;
  let toTheEnd = false;
  let looked = 0;
  // The ceiling counts every call; one message is always looked at, so a pass never stalls.
  const full = () => result.calls >= MAX_CALLS_PER_MAILBOX && looked > 0;

  let contactsCache: Map<string, string> | null = null;
  const contacts = async () => (contactsCache ??= await contactsOf(db, employeeId));
  // The search looks back from the last pass that read the history to its end, with a margin.
  const since = new Date((connection.gmailReadAt ?? google.now()).getTime() - 2 * 86_400_000);
  let searched: Set<string> | null = null;
  /** Messages from the deals' addresses: Gmail's search decides, only ids come back. Once a pass. */
  const fromContacts = async () => {
    if (searched) return searched;
    searched = new Set<string>();
    const addresses = [...(await contacts()).keys()];
    for (let i = 0; i < addresses.length; i += SEARCH_CHUNK) {
      spend();
      const chunk = addresses.slice(i, i + SEARCH_CHUNK);
      for (const id of await gmailSearchFrom(google.transport, token, chunk, since))
        searched.add(id);
    }
    return searched;
  };

  const settle = async (
    id: string,
    thread: { leadId: string; outboxId: string | null } | undefined,
  ): Promise<Outcome> => {
    let match: Match | null = thread
      ? { by: 'thread', ...thread }
      : (await fromContacts()).has(id)
        ? { by: 'contact' }
        : null;
    if (!match) {
      spend();
      const peek = await gmailReferences(google.transport, token, id);
      const cited = await outboxCited(db, peek.ids);
      if (cited) match = { by: 'in_reply_to', leadId: cited.leadId, outboxId: cited.id };
      else if (
        (await contacts()).size > 0 &&
        google.now().getTime() - peek.at.getTime() < SEARCH_SETTLE_MS
      )
        return 'pending';
      else return 'settled';
    }
    const kept = await keepMessage(
      deps,
      { token, employeeId, mailbox, id, match },
      contacts,
      spend,
    );
    return kept ? 'kept' : 'settled';
  };

  const finish = (values: Partial<Connection>) =>
    save({
      gmailHistoryId: cursor,
      // Past the end of the history, nothing after the point has been seen yet.
      gmailHistorySeen: held || !toTheEnd ? [...seen].filter((id) => !passed.has(id)) : [],
      ...values,
    });

  try {
    let pageToken: string | null = null;
    pages: do {
      if (full()) break;
      spend();
      const page = await gmailInboxHistory(google.transport, token, start, pageToken);
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
      for (const { id } of stored) seen.add(id);
      const threads = await knownThreads(
        db,
        employeeId,
        mailbox,
        page.records.flatMap((r) => r.messages.map((m) => m.threadId)),
      );
      for (const record of page.records) {
        let settled = true;
        for (const { id, threadId } of record.messages) {
          if (seen.has(id)) continue;
          if (full()) break pages;
          looked += 1;
          const outcome = await settle(id, threads.get(threadId));
          if (outcome === 'pending') {
            settled = false;
            continue;
          }
          seen.add(id);
          if (outcome === 'kept') result.kept += 1;
        }
        // A record with a message held back stops the point: the later ones wait in `seen`.
        if (!settled) held = true;
        if (!held) {
          cursor = record.id;
          for (const m of record.messages) passed.add(m.id);
        }
      }
      pageToken = page.nextPageToken;
      if (!pageToken) {
        toTheEnd = true;
        if (!held) cursor = page.historyId;
      }
    } while (pageToken);
    await finish({ gmailReadError: null, ...(toTheEnd ? { gmailReadAt: google.now() } : {}) });
  } catch (error) {
    if (!(error instanceof GmailReadError)) throw error;
    if (error.code === 'history_expired') {
      // Gmail forgot the point (about a week without a read): start again from now.
      const point = await gmailHistoryPoint(google.transport, token).catch(() => null);
      await save({
        gmailHistoryId: point,
        gmailHistorySeen: [],
        gmailReadAt: google.now(),
        gmailReadError: 'history_expired',
      });
    } else {
      toTheEnd = false;
      await finish({ gmailReadError: `gmail_${error.code}` });
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

/**
 * One pass over every mailbox, one at a time across replicas: a session advisory lock on a
 * connection of its own, which holds no transaction while Gmail is called. Null when another pass
 * holds the lock.
 */
export async function readAllMailboxesLocked(deps: RepliesDeps) {
  const client = await deps.db.$client.connect();
  let locked = false;
  try {
    const lock = await client.query<{ got: boolean }>(
      'select pg_try_advisory_lock(hashtext($1)) as got',
      [LOCK_KEY],
    );
    locked = lock.rows[0]?.got === true;
    if (!locked) return null;
    return await readAllMailboxes(deps);
  } finally {
    const unlocked =
      !locked ||
      (await client.query('select pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).then(
        () => true,
        () => false,
      ));
    // A lock that could not be let go goes with its connection.
    client.release(!unlocked);
  }
}

/** Every `minutes`, one pass at a time in this process and across replicas. */
export function startEmailRepliesScheduler(deps: RepliesDeps & { minutes: number }) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const totals = await readAllMailboxesLocked(deps);
      if (totals && totals.mailboxes > 0) deps.log({ job: 'crm-email-replies', ...totals });
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
