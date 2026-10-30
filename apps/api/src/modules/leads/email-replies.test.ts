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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  contactOptOuts,
  crmEmailInbound,
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
  readMailbox,
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
const google = fakeGoogle({
  email: SELLER,
  grantedScopes: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/gmail.send',
    GMAIL_READ_SCOPE,
  ],
});

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

/** One pass over this seller's mailbox (every seller here shares the simulated one). */
async function readFor(seller: { id: string }) {
  const [connection] = await db
    .select()
    .from(googleWorkspaceConnections)
    .where(eq(googleWorkspaceConnections.employeeId, seller.id));
  return readMailbox(deps, connection!);
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
    expect(params.get('fields')).toBe('payload/headers');
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
