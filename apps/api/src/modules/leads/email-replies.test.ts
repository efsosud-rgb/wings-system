import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GMAIL_READ_SCOPE,
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type LeadEmailReceived,
  type LeadEmailSent,
  type NewLeadPopups,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  contactOptOuts,
  crmEmailInbound,
  employees,
  crmEmailOutbox,
  crmNotifications,
  googleWorkspaceConnections,
  leadEvents,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { storageOf } from '../../lib/storage/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { fakeGoogle } from '../google-workspace/fake-google.js';
import { googleWorkspaceDepsOf } from '../google-workspace/service.js';
import {
  MAX_CALLS_PER_MAILBOX,
  mailboxesToRead,
  readAllMailboxesLocked,
  readMailbox,
  SEARCH_SETTLE_MS,
  type RepliesDeps,
} from './email-replies.js';
import { listLeadFiles } from './files.js';
import { upsertLead } from './service.js';

let harness: TestDatabase;
let db: Database;
let dir: string;
let app: FastifyInstance;
let deps: RepliesDeps;
const SELLER = 'daniele@wingscompany.com.br';
// Read on each call, so a test can change the history's page size.
const googleOptions: Parameters<typeof fakeGoogle>[0] = {
  email: SELLER,
  grantedScopes: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/gmail.send',
    GMAIL_READ_SCOPE,
  ],
};
const google = fakeGoogle(googleOptions);

/**
 * The leads' replies read from the seller's Gmail (t083), against a simulated Google: what comes in
 * (thread, In-Reply-To, a contact's address), what never does (anything else, Expansão with a brand,
 * a consent without the reading), no copy twice, the attachments' limits, the owner's notice and the
 * answer in the same conversation.
 */
beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-replies-'));
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'https://staging.wingssystem.online',
      MEDIA_DIR: dir,
      INTEGRATIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      GOOGLE_WORKSPACE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_WORKSPACE_CLIENT_SECRET: 'client-secret',
      CRM_EMAIL_MODE: 'gmail',
      CRM_EMAIL_REPLIES_ENABLED: 'true',
    }),
    db,
    googleFetch: google.transport,
    mailer: { enabled: false, send: async () => undefined },
  });
  deps = {
    db,
    google: googleWorkspaceDepsOf(app.wings)!,
    storage: storageOf(app.wings),
    maxFileBytes: 100 * 1024 * 1024,
    log: () => undefined,
  };
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => google.reset());
afterEach(() => {
  googleOptions.historyPageSize = undefined;
  vi.restoreAllMocks();
});

type Session = { id: string; cookies: Record<string, string> };

/** A seller connected to Google, whose mailbox the reading has already marked a starting point in. */
async function connectedSeller(): Promise<Session> {
  const employee = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  const cookies = { [SESSION_COOKIE]: token };
  const start = await app.inject({ method: 'POST', url: '/me/google/connect', cookies });
  const state = new URL(start.json<{ url: string }>().url).searchParams.get('state');
  await app.inject({ method: 'GET', url: `/me/google/callback?code=c&state=${state}`, cookies });
  const session = { id: employee.id, cookies };
  // The first pass only marks where this mailbox's reading starts.
  expect(await readFor(session)).toMatchObject({ kept: 0, calls: 1 });
  return session;
}

const connectionOf = async (seller: { id: string }) =>
  (
    await db
      .select()
      .from(googleWorkspaceConnections)
      .where(eq(googleWorkspaceConnections.employeeId, seller.id))
  )[0]!;

/** One pass over this seller's mailbox (every seller here shares the simulated one). */
async function readFor(seller: { id: string }, with_: Partial<RepliesDeps['google']> = {}) {
  return readMailbox({ ...deps, google: { ...deps.google, ...with_ } }, await connectionOf(seller));
}

let seq = 0;
const arrive = async (owner: string, pipeline: 'formatacao' | 'expansao' = 'formatacao') =>
  (
    await upsertLead(db, {
      source: 'site_form',
      name: 'Paula Candidata',
      phone: null,
      email: `paula${++seq}@exemplo.com.br`,
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      pipeline,
      ownerEmployeeId: owner,
      distribute: false,
      skipResearch: true,
      company: null,
      event: { kind: 'lead.received.site_form' },
    })
  ).lead;

async function sendTo(seller: Session, lead: { id: string; email: string | null }) {
  const sent = await app.inject({
    method: 'POST',
    url: `/leads/${lead.id}/emails`,
    cookies: seller.cookies,
    payload: { to: lead.email, subject: 'Proposta', text: 'Segue a proposta.' },
  });
  expect(sent.statusCode).toBe(201);
  const [row] = await db
    .select()
    .from(crmEmailOutbox)
    .where(eq(crmEmailOutbox.id, sent.json<{ outboxId: string }>().outboxId));
  return row!;
}

const emailsOf = async (seller: Session, leadId: string) =>
  (
    await app.inject({ method: 'GET', url: `/leads/${leadId}/emails`, cookies: seller.cookies })
  ).json<{ sent: LeadEmailSent[]; received: LeadEmailReceived[]; mailRead: string }>();

const keptFor = (leadId: string) =>
  db.select().from(crmEmailInbound).where(eq(crmEmailInbound.leadId, leadId));

const fullReads = () =>
  google.calls.filter((c) => /\/messages\/[^/]+\?/.test(c.url) && c.url.includes('format=full'));

describe('reading the leads’ replies', () => {
  it('keeps a reply in the thread of the e-mail sent, without the quoted text, and tells the owner', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    const outbox = await sendTo(seller, lead);
    google.deliver({
      threadId: outbox.gmailThreadId!,
      headers: {
        From: 'Sócia da Paula <socia@exemplo.com.br>',
        Subject: 'Re: Proposta',
        'Message-ID': '<resposta-1@exemplo.com.br>',
      },
      text: 'Gostei, podemos falar amanhã?\n\nEm qui., 30 de out. de 2026 às 10:00, Daniele <daniele@wingscompany.com.br>\nescreveu:\n> Segue a proposta.',
    });

    expect(await readFor(seller)).toMatchObject({ kept: 1 });

    const [kept] = await keptFor(lead.id);
    expect(kept).toMatchObject({
      matchedBy: 'thread',
      outboxId: outbox.id,
      fromEmail: 'socia@exemplo.com.br',
      fromName: 'Sócia da Paula',
      subject: 'Re: Proposta',
      body: 'Gostei, podemos falar amanhã?',
      messageId: '<resposta-1@exemplo.com.br>',
    });
    const emails = await emailsOf(seller, lead.id);
    expect(emails.received).toHaveLength(1);
    expect(emails.received[0]!.conversation).toBe(emails.sent[0]!.conversation);

    const [event] = await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.kind, 'lead.email_received')));
    expect(event!.detail).toMatchObject({ subject: 'Re: Proposta', from: 'Sócia da Paula' });
    // The text is not in the event: the history reads it from the reply's own row.
    expect(JSON.stringify(event!.detail)).not.toContain('Gostei');
    const page = await app.inject({
      method: 'GET',
      url: `/leads/${lead.id}`,
      cookies: seller.cookies,
    });
    const history = page.json<{ events: { kind: string; detail: { text?: string } }[] }>().events;
    expect(history.find((e) => e.kind === 'lead.email_received')?.detail.text).toBe(
      'Gostei, podemos falar amanhã?',
    );

    const notices = await db
      .select()
      .from(crmNotifications)
      .where(and(eq(crmNotifications.leadId, lead.id), eq(crmNotifications.kind, 'lead_email')));
    expect(notices).toEqual([
      expect.objectContaining({
        recipientEmployeeId: seller.id,
        message: 'O lead respondeu por e-mail.',
        emailState: 'none',
      }),
    ]);
    const popups = await app.inject({
      method: 'GET',
      url: '/crm/notifications/new-leads',
      cookies: seller.cookies,
    });
    expect(popups.json<NewLeadPopups>().emailReplies).toEqual([
      expect.objectContaining({ leadId: lead.id, firstName: 'Paula', blocked: null }),
    ]);
  });

  it('keeps a reply that cites our Message-ID in In-Reply-To, in another thread', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    const outbox = await sendTo(seller, lead);
    google.deliver({
      threadId: 'outra-conversa',
      headers: {
        From: 'contador@escritorio.com.br',
        Subject: 'Sobre a proposta',
        'In-Reply-To': outbox.messageId!,
      },
      text: 'Respondendo pelo escritório.',
    });
    await readFor(seller);
    const [kept] = await keptFor(lead.id);
    expect(kept).toMatchObject({ matchedBy: 'in_reply_to', outboxId: outbox.id });
    const emails = await emailsOf(seller, lead.id);
    expect(emails.received[0]!.conversation).toBe(emails.sent[0]!.conversation);
  });

  it('keeps an e-mail from a contact of the deal with no thread, found by Gmail’s search', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    google.deliver({
      headers: { From: `Paula <${lead.email}>`, Subject: 'Dúvida' },
      html: '<p>Oi, tenho uma <b>dúvida</b>.</p><div class="gmail_quote">antiga</div>',
    });
    await readFor(seller);
    const [kept] = await keptFor(lead.id);
    expect(kept).toMatchObject({
      matchedBy: 'contact',
      outboxId: null,
      body: 'Oi, tenho uma dúvida.',
    });
    const search = google.calls.find((c) => c.url.includes('/gmail/v1/users/me/messages?'));
    expect(new URL(search!.url).searchParams.get('q')).toContain(`from:(${lead.email}`);
  });

  it('reads nothing of a message from outside the deals but its two reference headers', async () => {
    const seller = await connectedSeller();
    await arrive(seller.id);
    const outside = google.deliver({
      headers: { From: 'ofertas@loja.com.br', Subject: 'Promoção', References: '<x@loja.com.br>' },
      text: 'Compre já.',
    });
    expect(await readFor(seller)).toMatchObject({ kept: 0 });
    expect(
      await db.select().from(crmEmailInbound).where(eq(crmEmailInbound.gmailMessageId, outside.id)),
    ).toHaveLength(0);
    expect(fullReads()).toHaveLength(0);
    const peek = google.calls.find((c) => c.url.includes(`/messages/${outside.id}?`))!;
    const params = new URL(peek.url).searchParams;
    expect(params.get('format')).toBe('metadata');
    expect(params.getAll('metadataHeaders')).toEqual(['In-Reply-To', 'References']);
    expect(params.get('fields')).toBe('internalDate,payload/headers');
  });

  it('keeps a message read twice only once', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    const [before] = await db
      .select({ point: googleWorkspaceConnections.gmailHistoryId })
      .from(googleWorkspaceConnections)
      .where(eq(googleWorkspaceConnections.employeeId, seller.id));
    google.deliver({ headers: { From: lead.email!, Subject: 'Oi' }, text: 'Oi' });
    await readFor(seller);
    // The same history again, as after a crash before the point was saved.
    await db
      .update(googleWorkspaceConnections)
      .set({ gmailHistoryId: before!.point })
      .where(eq(googleWorkspaceConnections.employeeId, seller.id));
    expect(await readFor(seller)).toMatchObject({ kept: 0 });
    expect(await keptFor(lead.id)).toHaveLength(1);
  });

  it('keeps a file in the deal’s files, refuses programs and what passes 20 MB, and answers in the thread', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    const outbox = await sendTo(seller, lead);
    google.deliver({
      threadId: outbox.gmailThreadId!,
      headers: { From: lead.email!, Subject: 'Re: Proposta', 'Message-ID': '<com-anexo@ex.com>' },
      text: 'Seguem os documentos.',
      attachments: [
        { filename: 'contrato.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4') },
        { filename: 'setup.exe', mimeType: 'application/octet-stream', data: Buffer.from('MZ') },
        {
          filename: 'video.mp4',
          mimeType: 'video/mp4',
          data: Buffer.alloc(20 * 1024 * 1024 + 1),
        },
        { filename: 'logo.png', mimeType: 'image/png', data: Buffer.from('png'), inline: true },
      ],
    });
    await readFor(seller);
    const [kept] = await keptFor(lead.id);
    expect(kept!.attachments).toEqual([
      expect.objectContaining({ name: 'contrato.pdf', byteSize: 8, refused: null }),
      expect.objectContaining({ name: 'setup.exe', fileId: null, refused: 'file_type' }),
      expect.objectContaining({ name: 'video.mp4', fileId: null, refused: 'too_large' }),
    ]);
    const files = await listLeadFiles(db, lead.id);
    expect(files.map((f) => f.name)).toEqual(['contrato.pdf']);
    // Only the kept file's bytes were asked of Gmail.
    expect(google.calls.filter((c) => c.url.includes('/attachments/'))).toHaveLength(1);

    // Answering it: with the file, through the upload, in the same Gmail thread.
    const answer = await app.inject({
      method: 'POST',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
      payload: {
        to: lead.email,
        subject: 'Re: Proposta',
        text: 'Recebido, obrigada.',
        fileIds: [files[0]!.fileId],
        replyToId: kept!.id,
      },
    });
    expect(answer.statusCode).toBe(201);
    const last = google.sentMail.at(-1)!;
    expect(last.threadId).toBe(outbox.gmailThreadId);
    expect(Buffer.from(last.raw, 'base64url').toString('utf8')).toContain(
      'In-Reply-To: <com-anexo@ex.com>',
    );
  });

  it('reads nothing from a consent without the reading scope, and asks for a reconnection', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    await db
      .update(googleWorkspaceConnections)
      .set({ scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'] })
      .where(eq(googleWorkspaceConnections.employeeId, seller.id));
    google.deliver({ headers: { From: lead.email!, Subject: 'Oi' }, text: 'Oi' });
    expect((await mailboxesToRead(db)).map((c) => c.employeeId)).not.toContain(seller.id);
    expect(await keptFor(lead.id)).toHaveLength(0);
    expect((await emailsOf(seller, lead.id)).mailRead).toBe('reconnect');
    const status = await app.inject({ method: 'GET', url: '/me/google', cookies: seller.cookies });
    expect(status.json()).toMatchObject({ status: { mailRead: 'reconnect' } });
  });

  it('reads nothing for an Expansão deal with a brand', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id, 'expansao');
    await db.update(leads).set({ brand: 'Marca Exemplo' }).where(eq(leads.id, lead.id));
    // A thread from before the brand was set: still nothing comes in.
    await db.insert(crmEmailOutbox).values({
      leadId: lead.id,
      subject: 'Antes da marca',
      body: '—',
      mode: 'gmail',
      status: 'sent',
      fromEmail: SELLER,
      gmailThreadId: 'thread-da-marca',
    });
    google.deliver({ threadId: 'thread-da-marca', headers: { From: lead.email! }, text: 'Oi' });
    google.deliver({ headers: { From: lead.email!, Subject: 'Oi' }, text: 'Oi' });
    await readFor(seller);
    expect(await keptFor(lead.id)).toHaveLength(0);
    const searches = google.calls.filter((c) => c.url.includes('/gmail/v1/users/me/messages?'));
    for (const search of searches)
      expect(new URL(search.url).searchParams.get('q')).not.toContain(lead.email!);
  });

  it('reads a reply despite a “não me contate”, and the notice shows the lock', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    await db.insert(contactOptOuts).values({
      channel: 'email',
      keyKind: 'lead',
      keyValue: lead.id,
      origin: 'crm',
      reason: null,
    });
    google.deliver({ headers: { From: lead.email!, Subject: 'Oi' }, text: 'Oi' });
    await readFor(seller);
    expect(await keptFor(lead.id)).toHaveLength(1);
    const [notice] = await db
      .select()
      .from(crmNotifications)
      .where(and(eq(crmNotifications.leadId, lead.id), eq(crmNotifications.kind, 'lead_email')));
    expect(notice!.message).toMatch(/^O lead respondeu por e-mail\. Atenção, não me contate/);
    const popups = await app.inject({
      method: 'GET',
      url: '/crm/notifications/new-leads',
      cookies: seller.cookies,
    });
    expect(popups.json<NewLeadPopups>().emailReplies[0]!.blocked).toMatch(/não ser contatado/);
  });

  it('stops at the call ceiling and the next pass goes on from there, losing nothing', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    for (let n = 0; n < 70; n++)
      google.deliver({ headers: { From: lead.email!, Subject: `E-mail ${n}` }, text: 'Oi' });
    const first = await readFor(seller);
    expect(first.kept).toBeGreaterThan(0);
    expect(first.kept).toBeLessThan(70);
    expect(first.calls).toBeLessThanOrEqual(MAX_CALLS_PER_MAILBOX + 2);
    const second = await readFor(seller);
    expect(first.kept + second.kept).toBe(70);
    expect(await keptFor(lead.id)).toHaveLength(70);
  });

  it('starts again from now when Gmail forgot the history point', async () => {
    const seller = await connectedSeller();
    google.expireHistory();
    expect(await readFor(seller)).toMatchObject({ error: 'history_expired' });
    const [row] = await db
      .select()
      .from(googleWorkspaceConnections)
      .where(eq(googleWorkspaceConnections.employeeId, seller.id));
    expect(row).toMatchObject({ gmailReadError: 'history_expired' });
    expect(row!.gmailHistoryId).not.toBeNull();
    expect((await readFor(seller)).error).toBeUndefined();
  });
});

/** Advisory locks held in this test's own database (other test files share the server). */
const ADVISORY_LOCKS = `select count(*)::int as n from pg_locks where locktype = 'advisory' and granted
  and database = (select oid from pg_database where datname = current_database())`;
const gmailCalls = () => google.calls.filter((c) => c.url.includes('/gmail/v1/'));
const searchCalls = () =>
  google.calls.filter((c) => c.url.includes('/gmail/v1/users/me/messages?'));

/** The review of PR #68 and the second opinion (aj02): what a pass must stand up to. */
describe('a pass that never stalls, never jumps a message and never pays twice', () => {
  it('gives up on a stalled Gmail call, and the point stays where it was', async () => {
    const seller = await connectedSeller();
    const before = await connectionOf(seller);
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(50));
    // Gmail's history never answers: only the time limit ends the call.
    const stalled: typeof fetch = (input, init) =>
      String(input).includes('/gmail/v1/users/me/history')
        ? new Promise((_, reject) =>
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
          )
        : google.transport(input, init);
    const started = Date.now();
    expect(await readFor(seller, { transport: stalled })).toMatchObject({ error: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await connectionOf(seller)).toMatchObject({
      gmailHistoryId: before.gmailHistoryId,
      gmailReadError: 'gmail_unreachable',
    });
  });

  it('holds no transaction open while Gmail is called, keeps others out, and lets the lock go', async () => {
    await connectedSeller();
    const seen: { idle: number; locks: number; other: unknown }[] = [];
    let once = false;
    const watched: typeof fetch = async (input, init) => {
      if (!once && String(input).includes('/gmail/v1/users/me/history')) {
        once = true;
        const idle = await db.$client.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and state like 'idle in transaction%'`,
        );
        const locks = await db.$client.query<{ n: number }>(ADVISORY_LOCKS);
        seen.push({
          idle: idle.rows[0]!.n,
          locks: locks.rows[0]!.n,
          other: await readAllMailboxesLocked(deps),
        });
      }
      return google.transport(input, init);
    };
    const totals = await readAllMailboxesLocked({
      ...deps,
      google: { ...deps.google, transport: watched },
    });
    expect(totals?.mailboxes).toBeGreaterThan(0);
    expect(seen).toEqual([{ idle: 0, locks: 1, other: null }]);
    const after = await db.$client.query<{ n: number }>(ADVISORY_LOCKS);
    expect(after.rows[0]!.n).toBe(0);
  });

  it('stops inside a record with more messages than the ceiling, and the next passes finish it without jumping or repeating one', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    const old = new Date(Date.now() - 2 * SEARCH_SETTLE_MS);
    const mails = google.deliverTogether([
      ...Array.from({ length: 70 }, (_, n) => ({
        headers: { From: lead.email!, Subject: `E-mail ${n}` },
        text: 'Oi',
      })),
      ...Array.from({ length: 10 }, (_, n) => ({
        headers: { From: `loja${n}@ofertas.com.br`, Subject: 'Promoção' },
        text: 'Compre já.',
        at: old,
      })),
    ]);
    const start = (await connectionOf(seller)).gmailHistoryId;

    const first = await readFor(seller);
    expect(first.calls).toBeLessThanOrEqual(MAX_CALLS_PER_MAILBOX + 1);
    expect(first.kept).toBeLessThan(70);
    // The record is not done: the point stays before it, its settled messages are kept aside.
    const midway = await connectionOf(seller);
    expect(midway.gmailHistoryId).toBe(start);
    expect(midway.gmailHistorySeen.length).toBeGreaterThan(0);

    let kept = first.kept;
    for (let pass = 0; pass < 5 && (await connectionOf(seller)).gmailHistoryId === start; pass++) {
      const next = await readFor(seller);
      expect(next.calls).toBeLessThanOrEqual(MAX_CALLS_PER_MAILBOX + 1);
      kept += next.kept;
    }
    expect(kept).toBe(70);
    expect(await keptFor(lead.id)).toHaveLength(70);
    // Every message was looked at exactly once in all the passes.
    for (const mail of mails)
      expect(
        google.calls.filter((c) => c.url.includes(`/messages/${mail.id}?`)),
        mail.id,
      ).toHaveLength(1);
    const done = await connectionOf(seller);
    expect(done.gmailHistoryId).not.toBe(start);
    expect(done.gmailHistorySeen).toEqual([]);
  });

  it('searches by sender once a pass, however many history pages, and counts it in the ceiling', async () => {
    const seller = await connectedSeller();
    const deals = [];
    for (let n = 0; n < 25; n++) deals.push(await arrive(seller.id));
    googleOptions.historyPageSize = 2;
    for (const lead of deals.slice(0, 6))
      google.deliver({ headers: { From: lead.email!, Subject: 'Oi' }, text: 'Oi' });
    google.calls.length = 0;
    const pass = await readFor(seller);
    expect(pass.kept).toBe(6);
    // 25 addresses are two searches of 20, made once although the history came in 3 pages.
    expect(searchCalls()).toHaveLength(2);
    expect(pass.calls).toBe(gmailCalls().length);
  });

  it('looks again at a contact’s e-mail that Gmail’s search had not indexed yet', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    const late = google.deliver({
      headers: { From: lead.email!, Subject: 'Ainda fora da busca' },
      text: 'Oi',
      unindexed: true,
    });
    const stranger = google.deliver({
      headers: { From: 'ofertas@loja.com.br', Subject: 'Promoção' },
      text: 'Compre já.',
    });
    const start = (await connectionOf(seller)).gmailHistoryId;
    expect(await readFor(seller)).toMatchObject({ kept: 0 });
    // Neither is settled yet: the point waits for them.
    expect((await connectionOf(seller)).gmailHistoryId).toBe(start);

    google.index(late.id);
    expect(await readFor(seller)).toMatchObject({ kept: 1 });
    expect(await keptFor(lead.id)).toEqual([expect.objectContaining({ gmailMessageId: late.id })]);
    // Past the contact's record now, and still before the stranger's, which waits.
    expect(Number((await connectionOf(seller)).gmailHistoryId)).toBe(Number(start) + 1);

    // Past the search's delay, the stranger's e-mail is settled as not the deals', and never kept.
    const later = new Date(Date.now() + SEARCH_SETTLE_MS + 60_000);
    expect(await readFor(seller, { now: () => later })).toMatchObject({ kept: 0 });
    const done = await connectionOf(seller);
    expect(done.gmailHistoryId).not.toBe(start);
    expect(done.gmailHistorySeen).toEqual([]);
    expect(
      await db
        .select()
        .from(crmEmailInbound)
        .where(eq(crmEmailInbound.gmailMessageId, stranger.id)),
    ).toHaveLength(0);
  });

  it('keeps the same reply read in two sellers’ mailboxes only once, and both readings go on', async () => {
    const first = await connectedSeller();
    const second = await connectedSeller();
    const lead = await arrive(first.id);
    const outbox = await sendTo(first, lead);
    google.deliver({
      threadId: outbox.gmailThreadId!,
      headers: { From: lead.email!, Subject: 'Re: Proposta', 'Message-ID': '<duas-caixas@ex.com>' },
      text: 'Respondi.',
    });
    expect(await readFor(first)).toMatchObject({ kept: 1 });
    const start = (await connectionOf(second)).gmailHistoryId;
    // The other mailbox finds it too (the same thread), and the second copy stops at the index.
    const other = await readFor(second);
    expect(other).toMatchObject({ kept: 0 });
    expect(other.error).toBeUndefined();
    expect(await keptFor(lead.id)).toHaveLength(1);
    expect((await connectionOf(second)).gmailHistoryId).not.toBe(start);
  });

  it('refuses to answer, with nothing sent, a reply that belongs to another deal', async () => {
    const seller = await connectedSeller();
    const mine = await arrive(seller.id);
    const other = await arrive(seller.id);
    google.deliver({ headers: { From: other.email!, Subject: 'Oi' }, text: 'Oi' });
    await readFor(seller);
    const [foreign] = await keptFor(other.id);
    const sentBefore = google.sentMail.length;
    const answer = await app.inject({
      method: 'POST',
      url: `/leads/${mine.id}/emails`,
      cookies: seller.cookies,
      payload: { to: mine.email, subject: 'Re: Oi', text: 'Olá', replyToId: foreign!.id },
    });
    expect(answer.statusCode).toBe(404);
    expect(answer.json()).toMatchObject({ error: 'reply_not_found' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(google.sentMail).toHaveLength(sentBefore);
    expect(
      await db.select().from(crmEmailOutbox).where(eq(crmEmailOutbox.leadId, mine.id)),
    ).toEqual([]);
  });

  it('keeps a colleague’s “reply all” in the conversation, but it is not the lead’s reply: no history, no notice', async () => {
    const seller = await connectedSeller();
    const lead = await arrive(seller.id);
    const outbox = await sendTo(seller, lead);
    // A registered colleague (with a login on another domain), and an address on the Workspace's.
    const colleague = await createEmployee(db, {
      role: 'vendedor_formatacao',
      sector: 'comercial',
    });
    await db
      .update(employees)
      .set({ email: 'colega@outro-dominio.com.br' })
      .where(eq(employees.id, colleague.id));
    for (const from of ['Colega <colega@outro-dominio.com.br>', 'gerencia@wingscompany.com.br'])
      google.deliver({
        threadId: outbox.gmailThreadId!,
        headers: { From: from, Subject: 'Re: Proposta', Cc: lead.email! },
        text: 'Pessoal, segue o complemento.',
      });
    await readFor(seller);
    const emails = await emailsOf(seller, lead.id);
    expect(emails.received.map((r) => r.fromEmail).sort()).toEqual([
      'colega@outro-dominio.com.br',
      'gerencia@wingscompany.com.br',
    ]);
    expect(
      await db
        .select()
        .from(leadEvents)
        .where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.kind, 'lead.email_received'))),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(crmNotifications)
        .where(and(eq(crmNotifications.leadId, lead.id), eq(crmNotifications.kind, 'lead_email'))),
    ).toEqual([]);
    const popups = await app.inject({
      method: 'GET',
      url: '/crm/notifications/new-leads',
      cookies: seller.cookies,
    });
    expect(popups.json<NewLeadPopups>().emailReplies).toEqual([]);

    // The lead's own answer in the same conversation still is.
    google.deliver({
      threadId: outbox.gmailThreadId!,
      headers: { From: lead.email!, Subject: 'Re: Proposta' },
      text: 'Obrigada!',
    });
    await readFor(seller);
    expect(
      await db
        .select()
        .from(crmNotifications)
        .where(and(eq(crmNotifications.leadId, lead.id), eq(crmNotifications.kind, 'lead_email'))),
    ).toHaveLength(1);
  });
});
