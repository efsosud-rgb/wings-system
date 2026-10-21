import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE,
  type DriveUploadTicket,
  type LeadFile,
  type RoleKey,
  type WaMessage,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  clients,
  driveFiles,
  driveFileVersions,
  leadFiles,
  leads,
  waContacts,
  waConversations,
  waMediaUploads,
  waMessageFiles,
  waMessages,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { storageOf } from '../../lib/storage/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  createEmployee,
  fakeJpeg,
  setOfficialLive,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import { processWhatsAppEvents } from './intake.js';
import { storeWhatsAppMedia } from './media-store.js';

/**
 * A deal's file sent in its WhatsApp conversation, end to end against a
 * simulated Meta and the local storage: the file goes up to the deal's files
 * first, then by its id; only inside the 24-hour window, only a file of that
 * deal, the brand's voice on the caption and the name, a photo over 5 MB as a
 * document, Meta's id kept and uploaded again when Meta loses it, the audit by
 * id, the bubble opening the Drive file, and the received-files queue leaving
 * it alone. No test reaches the network and no real message leaves.
 */

const APP_SECRET = 'whatsapp-app-secret-for-tests';
const TOKEN = 'fake-whatsapp-token';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';
const START = new Date('2026-10-21T15:00:00Z');
const DAY = 24 * 3_600_000;
const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let dir: string;
let clock = START;

const sends: Record<string, unknown>[] = [];
const uploads: { type: string | null; size: number; name: string | null }[] = [];
const downloads: string[] = [];
let nextSend: () => Response = () => accepted();
let nextUpload: () => Response | null = () => null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let wamid = 0;
const accepted = () =>
  json({
    messaging_product: 'whatsapp',
    contacts: [{ input: 'x', wa_id: '552199990001' }],
    messages: [{ id: `wamid.FILE${++wamid}` }],
  });

const whatsappFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  if (url.hostname === 'lookaside.fbsbx.com') return new Response('FROMMETA', { status: 200 });
  if (url.pathname.endsWith(`/${PHONE_ID}/messages`)) {
    sends.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return nextSend();
  }
  if (url.pathname.endsWith(`/${PHONE_ID}/media`)) {
    const form = init?.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    const file = form.get('file') as File;
    uploads.push({ type: form.get('type') as string | null, size: file.size, name: file.name });
    return nextUpload() ?? json({ id: `MEDIA${uploads.length}` });
  }
  if (url.pathname.includes('/MEDIA')) {
    downloads.push(url.pathname);
    return json({
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=9',
      mime_type: 'application/pdf',
      file_size: 8,
    });
  }
  return json({ error: { code: 100, message: 'unknown path' } }, 400);
}) as typeof fetch;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-wa-file-'));
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      MEDIA_DIR: dir,
      WHATSAPP_APP_SECRET: APP_SECRET,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'whatsapp-verify-token-long-enough',
      WHATSAPP_ACCESS_TOKEN: TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
      WHATSAPP_WABA_ID: WABA,
    }),
    db,
    now: () => clock,
    whatsappFetch,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  clock = START;
  sends.length = 0;
  uploads.length = 0;
  downloads.length = 0;
  nextSend = () => accepted();
  nextUpload = () => null;
  await setOfficialLive(db, true);
});

async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}
type Session = Awaited<ReturnType<typeof sessionFor>>;

let phoneNumber = 0;
const nextPhone = () => `55219888${String(++phoneNumber).padStart(5, '0')}`;

async function deal(
  phone: string,
  ownerId: string,
  extra: Partial<typeof leads.$inferInsert> = {},
) {
  const [row] = await db
    .insert(leads)
    .values({ source: 'manual', name: 'Ricardo Alves', phone, ownerEmployeeId: ownerId, ...extra })
    .returning({ id: leads.id });
  return row!.id;
}

/** The person writes: the 24-hour window opens. */
async function personWrites(phone: string) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15556696643', phone_number_id: PHONE_ID },
              contacts: [{ profile: { name: 'Ricardo' }, wa_id: phone }],
              messages: [
                {
                  from: phone,
                  id: `wamid.IN${phone}${clock.getTime()}`,
                  timestamp: unix(new Date(clock.getTime() - 60_000)),
                  type: 'text',
                  text: { body: 'Oi, me manda a proposta' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  await signed(body);
}

async function signed(body: string) {
  const { createHmac } = await import('node:crypto');
  const res = await app.inject({
    method: 'POST',
    url: '/integrations/whatsapp/webhook',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`,
    },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  await processWhatsAppEvents({ db, phoneNumberId: PHONE_ID, log: () => {}, now: () => clock });
}

/** The deal's file, as the browser sends it: ask, put the bytes, confirm. */
async function dealFile(
  session: Session,
  leadId: string,
  name: string,
  mimeType: string,
  bytes: Buffer,
) {
  const asked = await app.inject({
    method: 'POST',
    url: `/leads/${leadId}/files/uploads`,
    cookies: session.cookies,
    payload: { name, mimeType, byteSize: bytes.length },
  });
  expect(asked.statusCode).toBe(201);
  const ticket = asked.json<{ ticket: DriveUploadTicket }>().ticket;
  const put = await app.inject({
    method: 'PUT',
    url: ticket.url.replace('http://localhost:5173/api', ''),
    headers: { 'content-type': mimeType, 'content-length': String(bytes.length) },
    payload: bytes,
  });
  expect(put.statusCode).toBeLessThan(300);
  const done = await app.inject({
    method: 'POST',
    url: `/leads/${leadId}/files/uploads/${ticket.uploadId}/complete`,
    cookies: session.cookies,
  });
  expect(done.statusCode).toBe(201);
  return done.json<{ file: LeadFile }>().file.fileId;
}

const sendFile = (session: Session, path: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: path, cookies: session.cookies, payload });

const PDF = Buffer.from('%PDF-1.4 proposta de teste');
const PHOTO = fakeJpeg(800, 600, 40_000);

let seller: Session;
let otherSeller: Session;
let admin: Session;

beforeAll(async () => {
  seller = await sessionFor('vendedor_expansao');
  otherSeller = await sessionFor('vendedor_expansao');
  admin = await sessionFor('admin_master');
});

/** A deal of the seller with the window open and one file in its Arquivos. */
async function openDealWith(name: string, mimeType: string, bytes: Buffer) {
  const phone = nextPhone();
  const leadId = await deal(phone, seller.id);
  await personWrites(phone);
  const fileId = await dealFile(seller, leadId, name, mimeType, bytes);
  return { phone, leadId, fileId };
}

describe('sending a file of the deal', () => {
  it('a photo goes by its Meta id with the caption, kept in the deal and audited by id', async () => {
    const { leadId, fileId } = await openDealWith('fachada.jpg', 'image/jpeg', PHOTO);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId,
      caption: 'Olha a fachada',
    });
    expect(res.statusCode).toBe(201);
    const message = res.json<{ message: WaMessage }>().message;
    expect(message).toMatchObject({
      direction: 'out',
      kind: 'image',
      text: 'Olha a fachada',
      status: 'sent',
      media: { mimeType: 'image/jpeg', filename: 'fachada.jpg' },
    });
    expect(uploads).toEqual([{ type: 'image/jpeg', size: PHOTO.length, name: 'fachada.jpg' }]);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      type: 'image',
      image: { id: 'MEDIA1', caption: 'Olha a fachada' },
    });
    const [row] = await db.select().from(waMessages).where(eq(waMessages.id, message.id));
    expect(row!.content).toEqual({
      media: { id: 'MEDIA1', mimeType: 'image/jpeg', filename: 'fachada.jpg' },
      file: { fileId, version: 1 },
    });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'whatsapp.message_sent'), eq(auditLog.entityId, leadId)));
    expect(audit!.metadata).toMatchObject({
      messageId: message.id,
      kind: 'media',
      fileId,
      sentAs: 'image',
      outcome: 'sent',
    });
    expect(JSON.stringify(audit!.metadata)).not.toContain('fachada');
  });

  it('the second send of the same file reuses the Meta id; a new version goes up again', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    for (const caption of ['Segue a proposta', 'De novo']) {
      const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId, caption });
      expect(res.statusCode).toBe(201);
    }
    expect(uploads).toHaveLength(1);
    expect(sends.map((s) => s.document)).toEqual([
      { id: 'MEDIA1', caption: 'Segue a proposta', filename: 'proposta.pdf' },
      { id: 'MEDIA1', caption: 'De novo', filename: 'proposta.pdf' },
    ]);
    // 25 days later Meta's copy is about to go: it goes up again.
    clock = new Date(START.getTime() + 25 * DAY);
    await personWrites((await db.query.leads.findFirst({ where: eq(leads.id, leadId) }))!.phone!);
    const later = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(later.statusCode).toBe(201);
    expect(uploads).toHaveLength(2);
    expect(sends.at(-1)).toMatchObject({
      type: 'document',
      document: { id: 'MEDIA2', filename: 'proposta.pdf' },
    });
    expect((sends.at(-1)!.document as Record<string, unknown>).caption).toBeUndefined();
  });

  it('a send Meta fails because the file is gone drops the id; the next one uploads again', async () => {
    const { leadId, fileId } = await openDealWith('lista.pdf', 'application/pdf', PDF);
    nextSend = () => json({ error: { code: 131053, message: 'media upload error' } }, 400);
    const failed = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(failed.statusCode).toBe(201);
    expect(failed.json<{ message: WaMessage }>().message.status).toBe('failed');
    const [kept] = await db
      .select()
      .from(waMediaUploads)
      .where(eq(waMediaUploads.driveFileId, fileId));
    expect(kept!.invalidAt).not.toBeNull();
    nextSend = () => accepted();
    const again = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(again.json<{ message: WaMessage }>().message.status).toBe('sent');
    expect(uploads).toHaveLength(2);
  });

  it('a failure that comes later by the webhook drops the id too', async () => {
    const { leadId, fileId } = await openDealWith('mapa.pdf', 'application/pdf', PDF);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    const id = res.json<{ message: WaMessage }>().message.id;
    const [row] = await db.select().from(waMessages).where(eq(waMessages.id, id));
    await signed(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15556696643', phone_number_id: PHONE_ID },
                  statuses: [
                    {
                      id: row!.wamid,
                      status: 'failed',
                      timestamp: unix(clock),
                      recipient_id: '552199990001',
                      errors: [{ code: 131052, title: 'Media download error' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const [kept] = await db
      .select()
      .from(waMediaUploads)
      .where(eq(waMediaUploads.driveFileId, fileId));
    expect(kept!.invalidAt).not.toBeNull();
  });

  it('a photo over 5 MB goes as a document with its name', async () => {
    const big = fakeJpeg(4000, 3000, 6_000_000);
    const { leadId, fileId } = await openDealWith('obra.jpg', 'image/jpeg', big);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId,
      caption: 'Em alta',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ message: WaMessage }>().message.kind).toBe('document');
    expect(uploads[0]).toMatchObject({ type: 'image/jpeg', size: big.length });
    expect(sends[0]).toMatchObject({
      type: 'document',
      document: { id: 'MEDIA1', caption: 'Em alta', filename: 'obra.jpg' },
    });
  });

  it("an M4A goes as audio under Meta's name for it, and an audio takes no caption", async () => {
    const { leadId, fileId } = await openDealWith(
      'recado.m4a',
      'audio/x-m4a',
      Buffer.from('fake m4a audio bytes'),
    );
    const captioned = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId,
      caption: 'Ouça',
    });
    expect(captioned.statusCode).toBe(422);
    expect(captioned.json().error).toBe('caption_not_allowed');
    expect(uploads).toHaveLength(0);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(201);
    expect(uploads[0]!.type).toBe('audio/mp4');
    expect(sends[0]).toEqual(expect.objectContaining({ type: 'audio', audio: { id: 'MEDIA1' } }));
    expect(res.json<{ message: WaMessage }>().message).toMatchObject({ kind: 'audio', text: null });
  });

  it('outside the 24-hour window nothing goes up nor out', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    clock = new Date(START.getTime() + DAY + 60_000);
    const before = await db.$count(waMessages);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('window_closed');
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
    expect(await db.$count(waMessages)).toBe(before);
  });

  it('a file of another deal, or one taken out of the deal, is not found', async () => {
    const mine = await openDealWith('minha.pdf', 'application/pdf', PDF);
    const theirs = await openDealWith('outra.pdf', 'application/pdf', PDF);
    const res = await sendFile(seller, `/leads/${mine.leadId}/whatsapp/media`, {
      fileId: theirs.fileId,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('file_not_found');
    await app.inject({
      method: 'DELETE',
      url: `/leads/${mine.leadId}/files/${mine.fileId}`,
      cookies: seller.cookies,
    });
    const removed = await sendFile(seller, `/leads/${mine.leadId}/whatsapp/media`, {
      fileId: mine.fileId,
    });
    expect(removed.statusCode).toBe(404);
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it("another seller's deal answers 404, by deal and by conversation", async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const [conversation] = await db
      .select({ id: waConversations.id })
      .from(waConversations)
      .where(eq(waConversations.leadId, leadId));
    for (const path of [
      `/leads/${leadId}/whatsapp/media`,
      `/whatsapp/conversations/${conversation!.id}/media`,
    ]) {
      const res = await sendFile(otherSeller, path, { fileId });
      expect(res.statusCode, path).toBe(404);
    }
    expect(sends).toHaveLength(0);
  });

  it('by the conversation, the file of its deal goes to that conversation', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const [conversation] = await db
      .select({ id: waConversations.id })
      .from(waConversations)
      .where(eq(waConversations.leadId, leadId));
    const res = await sendFile(seller, `/whatsapp/conversations/${conversation!.id}/media`, {
      fileId,
    });
    expect(res.statusCode).toBe(201);
    expect(sends).toHaveLength(1);
  });

  it('a conversation no deal took yet has no files to send', async () => {
    const phone = nextPhone();
    await personWrites(phone);
    const contact = await db.query.waContacts.findFirst({ where: eq(waContacts.phone, phone) });
    const [conversation] = await db
      .select({ id: waConversations.id, leadId: waConversations.leadId })
      .from(waConversations)
      .where(eq(waConversations.contactId, contact!.id));
    expect(conversation!.leadId).toBeNull();
    const { fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const res = await sendFile(admin, `/whatsapp/conversations/${conversation!.id}/media`, {
      fileId,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('no_deal');
    expect(uploads).toHaveLength(0);
  });

  it("a brand's lead: a caption or a file name citing Wings is refused before anything goes", async () => {
    const [brand] = await db
      .insert(clients)
      .values({
        name: 'Casal do Churros',
        slug: 'casal-do-churros-arquivo',
        number: 91,
        relationship: 'expansao',
        franchiseOnSale: true,
        article: 'o',
      })
      .returning({ id: clients.id });
    const phone = nextPhone();
    const leadId = await deal(phone, seller.id, { pipeline: 'expansao', clientId: brand!.id });
    await personWrites(phone);
    const plain = await dealFile(seller, leadId, 'cardapio.pdf', 'application/pdf', PDF);
    const named = await dealFile(seller, leadId, 'Wings - cardapio.pdf', 'application/pdf', PDF);
    const caption = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId: plain,
      caption: 'Da Wings para você',
    });
    expect(caption.statusCode).toBe(422);
    expect(caption.json()).toMatchObject({ error: 'brand_voice' });
    const name = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId: named });
    expect(name.statusCode).toBe(422);
    expect(name.json().message).toContain('o nome do arquivo cita a Wings');
    expect(uploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
    const fine = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, {
      fileId: plain,
      caption: 'Segue o cardápio',
    });
    expect(fine.statusCode).toBe(201);
  });

  it('a file Meta refuses to take is not sent, and the reason says so', async () => {
    const { leadId, fileId } = await openDealWith(
      'pacote.zip',
      'application/zip',
      Buffer.from('PK fake zip'),
    );
    nextUpload = () => json({ error: { code: 100, message: 'Param file must be...' } }, 400);
    const before = await db.$count(waMessages);
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      error: 'media_upload_failed',
      message: expect.stringContaining('a Meta não aceita este tipo de arquivo'),
    });
    expect(res.json().message).toContain('Nada foi enviado');
    expect(sends).toHaveLength(0);
    expect(await db.$count(waMessages)).toBe(before);
  });

  it('a file over 100 MB is refused before it goes up', async () => {
    const { leadId, fileId } = await openDealWith('video.mov', 'video/quicktime', PDF);
    // Recorded as the Drive keeps it; the bytes themselves are never read.
    await db.update(driveFiles).set({ byteSize: 150_000_000 }).where(eq(driveFiles.id, fileId));
    const res = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    expect(res.statusCode).toBe(413);
    expect(uploads).toHaveLength(0);
  });
});

describe('the bubble of a sent file', () => {
  const open = (session: Session, messageId: string) =>
    app.inject({ url: `/whatsapp/messages/${messageId}/media`, cookies: session.cookies });
  const follow = (location: string) =>
    app.inject({ url: location.replace('http://localhost:5173/api', '') });

  it('opens the Drive file, the version that went, and writes the read down by id', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const sent = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    const messageId = sent.json<{ message: WaMessage }>().message.id;

    const first = await open(seller, messageId);
    expect(first.statusCode).toBe(302);
    expect((await follow(first.headers.location as string)).rawPayload.equals(PDF)).toBe(true);
    expect(downloads).toHaveLength(0);
    const [read] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'drive.file_previewed'), eq(auditLog.entityId, fileId)));
    expect(read!.metadata).toMatchObject({
      purpose: 'whatsapp_message',
      messageId,
      leadId,
      version: 1,
    });

    // The file gets a new version in the Drive: the bubble keeps showing what was sent.
    const file = await db.query.driveFiles.findFirst({ where: eq(driveFiles.id, fileId) });
    const newer = Buffer.from('%PDF-1.4 proposta revista');
    const newKey = `${file!.storageKey}-v2`;
    await storageOf(app.wings)!.put(newKey, newer, 'application/pdf');
    await db.insert(driveFileVersions).values({
      fileId,
      version: 1,
      mimeType: file!.mimeType,
      byteSize: file!.byteSize,
      storageKey: file!.storageKey,
    });
    await db
      .update(driveFiles)
      .set({ version: 2, storageKey: newKey, byteSize: newer.length })
      .where(eq(driveFiles.id, fileId));
    const again = await open(seller, messageId);
    expect((await follow(again.headers.location as string)).rawPayload.equals(PDF)).toBe(true);
  });

  it('a file put in the trash is taken from Meta, as a received one', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const sent = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    const messageId = sent.json<{ message: WaMessage }>().message.id;
    await db.update(driveFiles).set({ trashedAt: clock }).where(eq(driveFiles.id, fileId));
    const res = await open(seller, messageId);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('FROMMETA');
    expect(downloads).toEqual(['/v23.0/MEDIA1']);
  });

  it('another seller gets 404', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const sent = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    const res = await open(otherSeller, sent.json<{ message: WaMessage }>().message.id);
    expect(res.statusCode).toBe(404);
  });

  it('the received-files queue never copies back from Meta what we sent', async () => {
    const { leadId, fileId } = await openDealWith('proposta.pdf', 'application/pdf', PDF);
    const sent = await sendFile(seller, `/leads/${leadId}/whatsapp/media`, { fileId });
    const messageId = sent.json<{ message: WaMessage }>().message.id;
    await storeWhatsAppMedia({
      db,
      storage: storageOf(app.wings)!,
      config: { token: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA },
      fetchImpl: whatsappFetch,
      log: () => {},
      now: () => clock,
    });
    const queued = await db
      .select()
      .from(waMessageFiles)
      .where(eq(waMessageFiles.messageId, messageId));
    expect(queued).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    // The link between the deal and the file is the deal's Arquivos, untouched.
    expect(
      await db.$count(
        leadFiles,
        and(eq(leadFiles.leadId, leadId), eq(leadFiles.driveFileId, fileId)),
      ),
    ).toBe(1);
  });
});
