import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type DriveUploadTicket,
  type LeadEmailSent,
  type LeadFile,
} from '@wings/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  contactOptOuts,
  crmContacts,
  crmEmailOutbox,
  driveFiles,
  leadContacts,
  leadEvents,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { fakeGoogle } from '../google-workspace/fake-google.js';
import { upsertLead } from './service.js';

let harness: TestDatabase;
let db: Database;
let dir: string;
/** CRM_EMAIL_MODE=gmail, against a simulated Google. */
let gmailApp: FastifyInstance;
/** The default test mode: nothing leaves. Same database and storage. */
let testApp: FastifyInstance;
const google = fakeGoogle({ email: 'daniele@wingscompany.com.br' });

/**
 * "Escrever e-mail" on the deal (t081): the person's own subject and text, to
 * one of the deal's addresses, with the deal's files attached as MIME through
 * their Gmail. Refused for an Expansão deal with a brand, a "não me contate",
 * attachments over 20 MB together, and programs or scripts. Nothing reaches
 * the network: Google is simulated and the storage is a temporary folder.
 */
beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-email-'));
  const settings = {
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    MEDIA_DIR: dir,
    INTEGRATIONS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    GOOGLE_WORKSPACE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_WORKSPACE_CLIENT_SECRET: 'client-secret',
  };
  gmailApp = await buildApp({
    env: loadEnv({ ...settings, CRM_EMAIL_MODE: 'gmail' }),
    db,
    googleFetch: google.transport,
    mailer: { enabled: false, send: async () => undefined },
  });
  testApp = await buildApp({ env: loadEnv(settings), db, googleFetch: google.transport });
}, 60_000);

afterAll(async () => {
  await gmailApp?.close();
  await testApp?.close();
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => google.reset());

type Session = { id: string; cookies: Record<string, string> };

async function sessionFor(): Promise<Session> {
  const employee = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
  const login = await gmailApp.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

async function connect(session: Session) {
  const start = await gmailApp.inject({
    method: 'POST',
    url: '/me/google/connect',
    cookies: session.cookies,
  });
  const state = new URL(start.json<{ url: string }>().url).searchParams.get('state');
  const callback = await gmailApp.inject({
    method: 'GET',
    url: `/me/google/callback?code=auth-code&state=${state}`,
    cookies: session.cookies,
  });
  expect(callback.headers.location).toBe('/minha-conta?google=ok');
}

let seq = 0;
const arrive = async (owner: string) =>
  (
    await upsertLead(db, {
      source: 'site_form',
      name: 'Paula Candidata',
      phone: null,
      email: `paula${++seq}@exemplo.com.br`,
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      pipeline: 'expansao',
      ownerEmployeeId: owner,
      distribute: false,
      skipResearch: true,
      company: null,
      event: { kind: 'lead.received.site_form' },
    })
  ).lead;

/** A file of the deal, put the way the browser does (ticket, bytes to the storage, confirm). */
async function dealFile(session: Session, leadId: string, name: string, bytes: Buffer) {
  const mimeType = 'application/pdf';
  const asked = await gmailApp.inject({
    method: 'POST',
    url: `/leads/${leadId}/files/uploads`,
    cookies: session.cookies,
    payload: { name, mimeType, byteSize: bytes.length },
  });
  expect(asked.statusCode).toBe(201);
  const ticket = asked.json<{ ticket: DriveUploadTicket }>().ticket;
  const put = await gmailApp.inject({
    method: 'PUT',
    url: ticket.url.replace('http://localhost:5173/api', ''),
    headers: { 'content-type': mimeType, 'content-length': String(bytes.length) },
    payload: bytes,
  });
  expect(put.statusCode).toBeLessThan(300);
  const done = await gmailApp.inject({
    method: 'POST',
    url: `/leads/${leadId}/files/uploads/${ticket.uploadId}/complete`,
    cookies: session.cookies,
  });
  expect(done.statusCode).toBe(201);
  return done.json<{ file: LeadFile }>().file.fileId;
}

const compose = (
  app: FastifyInstance,
  session: Session,
  leadId: string,
  payload: Record<string, unknown>,
) =>
  app.inject({
    method: 'POST',
    url: `/leads/${leadId}/emails`,
    cookies: session.cookies,
    payload: { subject: 'Proposta da Wings', text: 'Oi, segue a proposta.', ...payload },
  });

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
const PDF = Buffer.from('%PDF-1.4 proposta de teste');

describe('free-text e-mail from the deal', () => {
  let seller: Session;
  beforeAll(async () => {
    seller = await sessionFor();
    await connect(seller);
  });

  it('sends without attachments from the seller’s Gmail, to the deal’s address', async () => {
    const lead = await arrive(seller.id);
    const listed = await gmailApp.inject({
      method: 'GET',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
    });
    expect(
      listed.json<{ addresses: { email: string; primary: boolean }[] }>().addresses[0],
    ).toEqual(expect.objectContaining({ email: lead.email, primary: true }));
    const sent = await compose(gmailApp, seller, lead.id, { to: lead.email });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ mode: 'gmail' });
    expect(google.sentMail).toHaveLength(1);
    const raw = decode(google.sentMail[0]!.raw);
    expect(raw).toContain(`To: ${lead.email}`);
    expect(raw).toContain('<daniele@wingscompany.com.br>');
    expect(raw).not.toContain('multipart/mixed');
    const [row] = await db.select().from(crmEmailOutbox).where(eq(crmEmailOutbox.leadId, lead.id));
    expect(row).toMatchObject({
      subject: 'Proposta da Wings',
      body: 'Oi, segue a proposta.',
      status: 'sent',
      toEmail: lead.email,
      attachments: [],
      templateId: null,
    });
  });

  it('sends the deal’s files as MIME attachments and keeps their names and sizes in the history', async () => {
    const lead = await arrive(seller.id);
    const fileId = await dealFile(seller, lead.id, 'proposta.pdf', PDF);
    const sent = await compose(gmailApp, seller, lead.id, { to: lead.email, fileIds: [fileId] });
    expect(sent.statusCode).toBe(201);
    const raw = decode(google.sentMail[0]!.raw);
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('filename="proposta.pdf"');
    expect(raw).toContain(PDF.toString('base64'));
    expect(google.calls.some((c) => c.url.includes('/upload/gmail/'))).toBe(true);

    const list = await gmailApp.inject({
      method: 'GET',
      url: `/leads/${lead.id}/emails`,
      cookies: seller.cookies,
    });
    expect(list.json<{ sent: LeadEmailSent[] }>().sent[0]).toMatchObject({
      subject: 'Proposta da Wings',
      toEmail: lead.email,
      attachments: [{ fileId, name: 'proposta.pdf', byteSize: PDF.length }],
    });
    const [event] = await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.kind, 'lead.email_sent')));
    expect(event!.detail).toMatchObject({
      subject: 'Proposta da Wings',
      status: 'sent',
      attachments: [{ name: 'proposta.pdf', byteSize: PDF.length }],
    });
    expect(typeof (event!.detail as { by: unknown }).by).toBe('string');
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, lead.id), eq(auditLog.action, 'lead.email_sent')));
    expect(audit!.metadata).toMatchObject({ composed: true, fileIds: [fileId] });
    const metadata = JSON.stringify(audit!.metadata);
    expect(metadata).not.toContain('proposta.pdf');
    expect(metadata).not.toContain(lead.email!);
  });

  it('goes to another contact of the deal, and to no address outside it', async () => {
    const lead = await arrive(seller.id);
    const [contact] = await db
      .insert(crmContacts)
      .values({ name: 'Sócio Teste', email: `socio${seq}@exemplo.com.br` })
      .returning();
    await db.insert(leadContacts).values({ leadId: lead.id, contactId: contact!.id });
    const ok = await compose(gmailApp, seller, lead.id, { to: contact!.email });
    expect(ok.statusCode).toBe(201);
    expect(decode(google.sentMail[0]!.raw)).toContain(`To: ${contact!.email}`);
    const stranger = await compose(gmailApp, seller, lead.id, { to: 'outro@exemplo.com.br' });
    expect(stranger.statusCode).toBe(422);
    expect(stranger.json()).toMatchObject({ error: 'not_a_contact' });
    expect(google.sentMail).toHaveLength(1);
  });

  it('refuses attachments over 20 MB together, before anything leaves', async () => {
    const lead = await arrive(seller.id);
    const fileId = await dealFile(seller, lead.id, 'grande.pdf', PDF);
    // The size the server checks is the Drive's record of it.
    await db
      .update(driveFiles)
      .set({ byteSize: 20 * 1024 * 1024 + 1 })
      .where(eq(driveFiles.id, fileId));
    const refused = await compose(gmailApp, seller, lead.id, { to: lead.email, fileIds: [fileId] });
    expect(refused.statusCode).toBe(413);
    expect(refused.json()).toMatchObject({ error: 'too_large' });
    expect(google.sentMail).toHaveLength(0);
    expect(await db.$count(crmEmailOutbox, eq(crmEmailOutbox.leadId, lead.id))).toBe(0);
  });

  it('refuses a program or a script as an attachment', async () => {
    const lead = await arrive(seller.id);
    const fileId = await dealFile(seller, lead.id, 'arquivo.pdf', PDF);
    await db.update(driveFiles).set({ name: 'instalar.exe' }).where(eq(driveFiles.id, fileId));
    const refused = await compose(gmailApp, seller, lead.id, { to: lead.email, fileIds: [fileId] });
    expect(refused.statusCode).toBe(415);
    expect(refused.json()).toMatchObject({ error: 'file_type' });
    expect(google.sentMail).toHaveLength(0);
  });

  it('refuses a file that is not one of this deal’s', async () => {
    const lead = await arrive(seller.id);
    const other = await arrive(seller.id);
    const fileId = await dealFile(seller, other.id, 'outra.pdf', PDF);
    const refused = await compose(gmailApp, seller, lead.id, { to: lead.email, fileIds: [fileId] });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ error: 'file_not_found' });
  });

  it('sends nothing on an Expansão deal with a brand', async () => {
    const lead = await arrive(seller.id);
    await db.update(leads).set({ brand: 'Marca Exemplo' }).where(eq(leads.id, lead.id));
    const refused = await compose(gmailApp, seller, lead.id, { to: lead.email });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'brand_hidden' });
    expect(google.sentMail).toHaveLength(0);
    expect(await db.$count(crmEmailOutbox, eq(crmEmailOutbox.leadId, lead.id))).toBe(0);
  });

  it('refuses a "não me contate", on the deal or on the address chosen', async () => {
    const lead = await arrive(seller.id);
    const recorded = await gmailApp.inject({
      method: 'POST',
      url: `/leads/${lead.id}/contact-opt-outs`,
      cookies: seller.cookies,
      payload: { channels: ['email'], reason: 'Pediu para não receber e-mail' },
    });
    expect(recorded.statusCode).toBe(201);
    const refused = await compose(gmailApp, seller, lead.id, { to: lead.email });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: 'contact_blocked',
      message: expect.stringContaining('Pediu para não ser contatado (e-mail'),
    });

    const open = await arrive(seller.id);
    const [contact] = await db
      .insert(crmContacts)
      .values({ name: 'Contato Bloqueado', email: `bloqueado${seq}@exemplo.com.br` })
      .returning();
    await db.insert(leadContacts).values({ leadId: open.id, contactId: contact!.id });
    await db.insert(contactOptOuts).values({
      channel: 'email',
      keyKind: 'email',
      keyValue: contact!.email!,
      origin: 'crm',
      reason: null,
    });
    const blockedAddress = await compose(gmailApp, seller, open.id, { to: contact!.email });
    expect(blockedAddress.statusCode).toBe(409);
    expect(blockedAddress.json()).toMatchObject({ error: 'contact_blocked' });
    expect(google.sentMail).toHaveLength(0);
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, open.id));
    expect(events.find((e) => e.kind === 'lead.contact_blocked')?.detail).toMatchObject({
      channel: 'email',
      path: 'email_manual',
    });
  });

  it('in test mode sends nothing and records the message with the attachments’ names', async () => {
    const lead = await arrive(seller.id);
    const fileId = await dealFile(seller, lead.id, 'catalogo.pdf', PDF);
    const sent = await compose(testApp, seller, lead.id, { to: lead.email, fileIds: [fileId] });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ mode: 'test' });
    expect(google.sentMail).toHaveLength(0);
    const [row] = await db
      .select()
      .from(crmEmailOutbox)
      .where(eq(crmEmailOutbox.leadId, lead.id))
      .orderBy(desc(crmEmailOutbox.createdAt));
    expect(row).toMatchObject({
      mode: 'test',
      status: 'recorded',
      fromEmail: null,
      attachments: [{ fileId, name: 'catalogo.pdf', byteSize: PDF.length }],
    });
  });

  it('refuses an empty subject or text', async () => {
    const lead = await arrive(seller.id);
    const empty = await compose(gmailApp, seller, lead.id, { to: lead.email, subject: ' ' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ message: 'Escreva o assunto' });
  });
});
