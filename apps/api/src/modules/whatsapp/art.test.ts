import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type Client,
  type ClientWhatsAppArt,
  type DealWhatsApp,
  type DriveUploadTicket,
  type RoleKey,
  type SectorSlug,
  type WaTemplate,
  type WaTemplatePreview,
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
  driveFolders,
  driveUploads,
  leads,
  waMediaUploads,
  waMessages,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { storageOf } from '../../lib/storage/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  createEmployee,
  fakeJpeg,
  fakePng,
  setOfficialLive,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import { processWhatsAppEvents } from './intake.js';
import { ART_MISSING_BRAND } from './template-send.js';

/**
 * The art at the head of the WhatsApp templates, end to end against a
 * simulated Meta and the local storage: the register (only a PNG or JPEG of
 * 1125 × 600 up to 2 MB, read from its bytes), the message that goes (a
 * common one inside the window, the `_arte` template outside it), the Meta
 * media id kept and uploaded again, the brand's voice and who may see the
 * preview. No test reaches the network and no real message leaves.
 */

const APP_SECRET = 'whatsapp-app-secret-for-tests';
const TOKEN = 'fake-whatsapp-token';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';
const START = new Date('2026-10-09T15:00:00Z');
const DAY = 24 * 3_600_000;
const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let dir: string;
let clock = START;

const sends: Record<string, unknown>[] = [];
const uploads: { type: string | null; size: number }[] = [];
let nextSend: () => Response = () => accepted();
let nextUpload: () => Response | null = () => null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let wamid = 0;
const accepted = () =>
  json({
    messaging_product: 'whatsapp',
    contacts: [{ input: 'x', wa_id: '552199990001' }],
    messages: [{ id: `wamid.ART${++wamid}` }],
  });

const quick = (...titles: string[]) => ({
  type: 'BUTTONS',
  buttons: titles.map((text) => ({ type: 'QUICK_REPLY', text })),
});
const imageHeader = { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::aW'] } };
const tpl = (name: string, category: string, body: string, ...more: object[]) => ({
  id: name,
  name,
  language: 'pt_BR',
  status: 'APPROVED',
  category,
  components: [{ type: 'BODY', text: body }, ...more],
});

/** The templates on the test account (modelos-whatsapp-2026-10-07 and modelos-arte-12). */
const TEMPLATES = [
  tpl(
    'expansao_boas_vindas',
    'MARKETING',
    'Olá, {{1}}! Aqui é {{2}}, do time de expansão da {{3}}. Recebemos o seu interesse em abrir uma unidade da rede. Posso te enviar as informações por aqui?',
    quick('Sim, pode enviar', 'Prefiro uma ligação'),
  ),
  tpl(
    'expansao_boas_vindas_arte',
    'UTILITY',
    'Olá, {{1}}! Aqui é {{2}}, do time de expansão {{3}}. Recebemos o seu interesse em abrir uma unidade da rede. Posso te enviar as informações por aqui?',
    imageHeader,
    quick('Sim, pode enviar', 'Prefiro uma ligação'),
  ),
  tpl(
    'wings_formatacao_boas_vindas',
    'UTILITY',
    'Olá, {{1}}! Aqui é {{2}}, da Wings Company. Recebemos o seu interesse em transformar a {{3}} em franquia. Posso te fazer algumas perguntas rápidas por aqui?',
    quick('Sim, pode perguntar', 'Prefiro uma ligação'),
  ),
  tpl(
    'wings_formatacao_boas_vindas_arte',
    'UTILITY',
    'Olá, {{1}}! Aqui é {{2}}, da Wings Company. Recebemos o seu interesse em transformar {{3}} em franquia. Posso te fazer algumas perguntas rápidas por aqui?',
    imageHeader,
    quick('Sim, pode perguntar', 'Prefiro uma ligação'),
  ),
];

const whatsappFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  if (url.pathname.endsWith(`/${PHONE_ID}/messages`)) {
    sends.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return nextSend();
  }
  if (url.pathname.endsWith(`/${PHONE_ID}/media`)) {
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('messaging_product')).toBe('whatsapp');
    const file = form.get('file') as Blob;
    uploads.push({ type: form.get('type') as string | null, size: file.size });
    return nextUpload() ?? json({ id: `MEDIA${uploads.length}` });
  }
  if (url.pathname.endsWith(`/${WABA}/message_templates`)) return json({ data: TEMPLATES });
  return json({ error: { code: 100, message: 'unknown path' } }, 400);
}) as typeof fetch;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-art-'));
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
  sends.length = 0;
  nextSend = () => accepted();
  nextUpload = () => null;
  // Sellers send here; the lock before the number is live has its own tests (whatsapp.test.ts).
  await setOfficialLive(db, true);
});

const SECTOR_OF: Partial<Record<RoleKey, SectorSlug>> = {
  admin_master: 'diretoria',
  diretoria: 'diretoria',
  marketing: 'marketing',
  formatacao_juridico: 'formatacao',
};

async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, { role, sector: SECTOR_OF[role] ?? 'comercial' });
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

let brandNumber = 60;
async function brand(name: string, article: 'o' | 'a' | null) {
  const [row] = await db
    .insert(clients)
    .values({
      name,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      number: ++brandNumber,
      relationship: 'expansao',
      franchiseOnSale: true,
      article,
    })
    .returning({ id: clients.id });
  return row!.id;
}

async function deal(phone: string, ownerId: string, extra: Partial<typeof leads.$inferInsert>) {
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
                  text: { body: 'Oi, quero saber da franquia' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  await deliverSigned(body);
}

async function deliverSigned(body: string) {
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

/** The whole upload, as the browser does it: ask, send the bytes, confirm. */
async function sendArt(session: Session, clientId: string, bytes: Buffer, mimeType = 'image/png') {
  const asked = await app.inject({
    method: 'POST',
    url: `/clients/${clientId}/whatsapp/art/uploads`,
    cookies: session.cookies,
    payload: { mimeType, byteSize: bytes.length },
  });
  if (asked.statusCode !== 201) return { asked, done: null, uploadId: null };
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
    url: `/clients/${clientId}/whatsapp/art/uploads/${ticket.uploadId}/complete`,
    cookies: session.cookies,
  });
  return { asked, done, uploadId: ticket.uploadId };
}

const ART = fakePng(1125, 600, 40_000);

const preview = (session: Session, leadId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/leads/${leadId}/whatsapp/template-preview`,
    cookies: session.cookies,
    payload: { language: 'pt_BR', ...payload },
  });
const sendTemplate = (session: Session, leadId: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/leads/${leadId}/whatsapp/template`,
    cookies: session.cookies,
    payload: { language: 'pt_BR', ...payload },
  });

let marketing: Session;
let seller: Session;
let malkuth: string;

beforeAll(async () => {
  marketing = await sessionFor('marketing');
  seller = await sessionFor('vendedor_expansao');
  malkuth = await brand('Malkuth', 'a');
  // The templates as Meta lists them.
  const synced = await app.inject({
    url: '/whatsapp/templates?refresh=1',
    cookies: seller.cookies,
  });
  expect(synced.statusCode).toBe(200);
}, 60_000);

describe('registering the art', () => {
  it('keeps only a PNG or JPEG of 1125 × 600 up to 2 MB, judged by its bytes', async () => {
    const storage = storageOf({
      env: {
        MEDIA_DIR: dir,
        APP_BASE_URL: 'http://localhost:5173',
        SESSION_SECRET: 'x'.repeat(48),
      } as never,
    })!;

    const big = await app.inject({
      method: 'POST',
      url: `/clients/${malkuth}/whatsapp/art/uploads`,
      cookies: marketing.cookies,
      payload: { mimeType: 'image/png', byteSize: 3 * 1024 * 1024 },
    });
    expect(big.statusCode).toBe(422);
    expect(big.json()).toMatchObject({
      error: 'art_refused',
      message: 'A arte pode ter até 2 MB.',
    });
    const gif = await app.inject({
      method: 'POST',
      url: `/clients/${malkuth}/whatsapp/art/uploads`,
      cookies: marketing.cookies,
      payload: { mimeType: 'image/gif', byteSize: 1000 },
    });
    expect(gif.statusCode).toBe(422);

    // The wrong size: refused with the reason, and what arrived is deleted.
    const wrong = await sendArt(marketing, malkuth, fakePng(1080, 1080));
    expect(wrong.done?.statusCode).toBe(422);
    expect(wrong.done?.json()).toMatchObject({
      error: 'art_refused',
      reason: 'dimensions',
      message: 'A arte precisa ter 1125 × 600 pixels.',
    });
    const [refusedUpload] = await db
      .select()
      .from(driveUploads)
      .where(eq(driveUploads.id, wrong.uploadId!));
    expect(await storage.head(refusedUpload!.storageKey)).toBeNull();
    expect(refusedUpload!.completedAt).not.toBeNull();
    // A JPEG sent as a PNG, and something that is no image at all.
    expect((await sendArt(marketing, malkuth, fakeJpeg(1125, 600))).done?.json()).toMatchObject({
      reason: 'mismatch',
    });
    expect(
      (await sendArt(marketing, malkuth, Buffer.from('<svg>'.padEnd(500, ' ')))).done?.json(),
    ).toMatchObject({ reason: 'unreadable' });
    expect(
      (await db.select().from(clients).where(eq(clients.id, malkuth)))[0]!.whatsappArtFileId,
    ).toBeNull();

    const good = await sendArt(marketing, malkuth, ART);
    expect(good.done?.statusCode).toBe(201);
    const state = good.done!.json<ClientWhatsAppArt>();
    expect(state).toMatchObject({ clientId: malkuth, article: 'a' });
    expect(state.art?.url).toContain('/api/drive/blob?t=');
    // A Drive file of the brand's Mídia folder, named by id in the audit.
    const [file] = await db.select().from(driveFiles).where(eq(driveFiles.id, state.art!.fileId));
    expect(file).toMatchObject({ clientId: malkuth, mimeType: 'image/png', byteSize: ART.length });
    expect(file!.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    const [folder] = await db
      .select()
      .from(driveFolders)
      .where(eq(driveFolders.id, file!.folderId));
    expect(folder).toMatchObject({ clientId: malkuth, slot: 'midia' });
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, malkuth), eq(auditLog.action, 'client.whatsapp_art_set')));
    expect(audits[0]?.metadata).toEqual({ fileId: file!.id, previousFileId: null });
    expect(JSON.stringify(state)).not.toContain(file!.storageKey);

    // The register says which brands have their art.
    const list = await app.inject({ url: '/clients', cookies: marketing.cookies });
    expect(list.json<{ clients: Client[] }>().clients.find((c) => c.id === malkuth)).toMatchObject({
      whatsappArt: true,
      article: 'a',
    });
  });

  it('confirms only an upload asked as the art: a Drive upload of the same folder is not read nor deleted', async () => {
    const storage = storageOf({
      env: {
        MEDIA_DIR: dir,
        APP_BASE_URL: 'http://localhost:5173',
        SESSION_SECRET: 'x'.repeat(48),
      } as never,
    })!;
    const tree = await app.inject({ url: '/drive/tree', cookies: marketing.cookies });
    const media = tree
      .json<{ folders: { id: string; clientId: string | null; slot: string | null }[] }>()
      .folders.find((f) => f.clientId === malkuth && f.slot === 'midia');
    expect(media).toBeDefined();
    const video = Buffer.alloc(4000, 1);
    const asked = await app.inject({
      method: 'POST',
      url: '/drive/uploads',
      cookies: marketing.cookies,
      payload: {
        folderId: media!.id,
        name: 'video.mp4',
        mimeType: 'video/mp4',
        byteSize: video.length,
      },
    });
    expect(asked.statusCode).toBe(201);
    const ticket = asked.json<{ ticket: DriveUploadTicket }>().ticket;
    await app.inject({
      method: 'PUT',
      url: ticket.url.replace('http://localhost:5173/api', ''),
      headers: { 'content-type': 'video/mp4', 'content-length': String(video.length) },
      payload: video,
    });
    const hijack = await app.inject({
      method: 'POST',
      url: `/clients/${malkuth}/whatsapp/art/uploads/${ticket.uploadId}/complete`,
      cookies: marketing.cookies,
    });
    expect(hijack.statusCode).toBe(404);
    const [upload] = await db
      .select()
      .from(driveUploads)
      .where(eq(driveUploads.id, ticket.uploadId));
    expect(upload!.completedAt).toBeNull();
    expect(await storage.head(upload!.storageKey)).toEqual(
      expect.objectContaining({ size: video.length }),
    );
    // The Drive still completes it as the file it is.
    const done = await app.inject({
      method: 'POST',
      url: `/drive/uploads/${ticket.uploadId}/complete`,
      cookies: marketing.cookies,
    });
    expect(done.statusCode).toBe(201);
  });

  it("a brand's by who fills its record, the Wings art by who manages the register", async () => {
    const juridico = await sessionFor('formatacao_juridico');
    // A seller does neither.
    expect((await sendArt(seller, malkuth, ART)).asked.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/clients/${malkuth}/whatsapp/article`,
          cookies: seller.cookies,
          payload: { article: 'o' },
        })
      ).statusCode,
    ).toBe(403);
    // Jurídico fills the record (the article) but does not keep the Wings art.
    const article = await app.inject({
      method: 'PUT',
      url: `/clients/${malkuth}/whatsapp/article`,
      cookies: juridico.cookies,
      payload: { article: 'a' },
    });
    expect(article.statusCode).toBe(200);
    expect((await sendArt(juridico, WINGS_CLIENT_ID, ART)).asked.statusCode).toBe(403);
    const wings = await sendArt(marketing, WINGS_CLIENT_ID, fakeJpeg(1125, 600), 'image/jpeg');
    expect(wings.done?.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/clients/${WINGS_CLIENT_ID}/whatsapp/article`,
          cookies: marketing.cookies,
          payload: { article: 'a' },
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('what goes to the lead', () => {
  it('hides the _arte version from the list and says the template has one', async () => {
    const listed = await app.inject({ url: '/whatsapp/templates', cookies: seller.cookies });
    const names = listed.json<{ templates: WaTemplate[] }>().templates.map((t) => t.name);
    expect(names).toEqual(['expansao_boas_vindas', 'wings_formatacao_boas_vindas']);
    expect(listed.json<{ templates: WaTemplate[] }>().templates[0]).toMatchObject({
      artVersion: true,
    });
  });

  it('inside the window: a common message with the brand art, uploaded to Meta once', async () => {
    clock = START;
    const leadId = await deal('5521977770001', seller.id, {
      pipeline: 'expansao',
      clientId: malkuth,
    });
    await personWrites('5521977770001');

    const first = await preview(seller, leadId, { name: 'expansao_boas_vindas' });
    expect(first.statusCode).toBe(200);
    const shown = first.json<{ preview: WaTemplatePreview }>().preview;
    expect(shown).toMatchObject({
      version: 'expansao_boas_vindas_arte',
      sendAs: 'free',
      charged: false,
      withArt: true,
      notices: [],
      ready: true,
    });
    expect(shown.text).toContain('do time de expansão da Malkuth');
    expect(shown.fields.map((f) => [f.role, f.locked])).toEqual([
      ['lead', false],
      ['seller', false],
      ['brand', true],
    ]);
    expect(shown.fields[0]!.value).toBe('Ricardo');
    expect(uploads).toHaveLength(0);

    // The art for the preview: an address of 5 minutes, audited by id.
    const art = await app.inject({ url: `/leads/${leadId}/whatsapp/art`, cookies: seller.cookies });
    expect(art.statusCode).toBe(200);
    expect(art.json()).toMatchObject({ url: expect.stringContaining('/api/drive/blob?t=') });

    const params = shown.fields.map((f) => f.value);
    const sent = await sendTemplate(seller, leadId, { name: 'expansao_boas_vindas', params });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().message).toMatchObject({
      kind: 'interactive',
      fromTemplate: 'expansao_boas_vindas_arte',
      withArt: true,
      template: null,
      status: 'sent',
    });
    expect(uploads).toEqual([{ type: 'image/png', size: ART.length }]);
    expect(sends.at(-1)).toMatchObject({
      to: '5521977770001',
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'image', image: { id: 'MEDIA1' } },
        body: { text: shown.text },
        action: {
          buttons: [
            { type: 'reply', reply: { title: 'Sim, pode enviar' } },
            { type: 'reply', reply: { title: 'Prefiro uma ligação' } },
          ],
        },
      },
    });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, leadId), eq(auditLog.action, 'whatsapp.message_sent')));
    expect(audit?.metadata).toMatchObject({
      kind: 'template',
      sentAs: 'free',
      template: 'expansao_boas_vindas_arte',
    });

    // The id is reused: nothing goes up again.
    await sendTemplate(seller, leadId, { name: 'expansao_boas_vindas', params });
    expect(uploads).toHaveLength(1);
    expect(sends.at(-1)).toMatchObject({ interactive: { header: { image: { id: 'MEDIA1' } } } });

    // Window closed, 26 days later: the _arte template, and the art goes up again.
    clock = new Date(START.getTime() + 26 * DAY);
    const closed = await preview(seller, leadId, { name: 'expansao_boas_vindas', params });
    expect(closed.json<{ preview: WaTemplatePreview }>().preview).toMatchObject({
      sendAs: 'template',
      charged: true,
      version: 'expansao_boas_vindas_arte',
    });
    const late = await sendTemplate(seller, leadId, { name: 'expansao_boas_vindas', params });
    expect(late.json().message).toMatchObject({
      kind: 'template',
      template: { name: 'expansao_boas_vindas_arte' },
      withArt: true,
    });
    expect(uploads).toHaveLength(2);
    expect(sends.at(-1)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '552199990001',
      type: 'template',
      template: {
        name: 'expansao_boas_vindas_arte',
        language: { code: 'pt_BR' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { id: 'MEDIA2' } }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ricardo' },
              { type: 'text', text: params[1] },
              { type: 'text', text: 'da Malkuth' },
            ],
          },
        ],
      },
    });

    // Meta says the file is gone: that send stays failed (never retried), the next uploads again.
    nextSend = () => json({ error: { code: 131053, type: 'OAuthException' } }, 400);
    const failed = await sendTemplate(seller, leadId, { name: 'expansao_boas_vindas', params });
    expect(failed.json().message.status).toBe('failed');
    // Four sends so far, each made once: the failed one was not repeated.
    expect(sends).toHaveLength(4);
    const [kept] = await db
      .select()
      .from(waMediaUploads)
      .where(eq(waMediaUploads.mediaId, 'MEDIA2'));
    expect(kept?.invalidAt).not.toBeNull();
    nextSend = () => accepted();
    await sendTemplate(seller, leadId, { name: 'expansao_boas_vindas', params });
    expect(uploads).toHaveLength(3);
    expect(sends.at(-1)).toMatchObject({
      template: {
        components: [{ parameters: [{ image: { id: 'MEDIA3' } }] }, { type: 'body' }],
      },
    });

    // A failure that comes later, by the webhook, does the same.
    const last = await db
      .select({ wamid: waMessages.wamid })
      .from(waMessages)
      .where(eq(waMessages.leadId, leadId));
    const lastWamid = last
      .map((m) => m.wamid)
      .filter(Boolean)
      .at(-1)!;
    await deliverSigned(
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
                  metadata: { phone_number_id: PHONE_ID },
                  statuses: [
                    {
                      id: lastWamid,
                      status: 'failed',
                      timestamp: unix(clock),
                      recipient_id: '552199990001',
                      errors: [{ code: 131053, title: 'Media upload error' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const [again] = await db
      .select()
      .from(waMediaUploads)
      .where(eq(waMediaUploads.mediaId, 'MEDIA3'));
    expect(again?.invalidAt).not.toBeNull();
  });

  it('refuses a wrong number of fields, and a mode that changed since the preview, sending nothing', async () => {
    clock = START;
    const leadId = await deal('5521977770007', seller.id, {
      pipeline: 'expansao',
      clientId: malkuth,
    });
    await personWrites('5521977770007');
    const before = sends.length;
    const short = await sendTemplate(seller, leadId, {
      name: 'expansao_boas_vindas',
      params: ['Ricardo', 'Fernando'],
    });
    expect(short.statusCode).toBe(422);
    expect(short.json()).toMatchObject({
      error: 'template_params',
      message: 'Este modelo pede 3 campo(s).',
    });
    // The screen showed a free message; the window closed before the click.
    const shown = (await preview(seller, leadId, { name: 'expansao_boas_vindas' })).json<{
      preview: WaTemplatePreview;
    }>().preview;
    expect(shown.sendAs).toBe('free');
    clock = new Date(START.getTime() + 2 * DAY);
    const changed = await sendTemplate(seller, leadId, {
      name: 'expansao_boas_vindas',
      params: shown.fields.map((f) => f.value),
      expect: { sendAs: shown.sendAs, charged: shown.charged },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({
      error: 'send_mode_changed',
      preview: { sendAs: 'template', charged: true },
    });
    expect(sends.length).toBe(before);
    const outgoing = await db
      .select()
      .from(waMessages)
      .where(and(eq(waMessages.leadId, leadId), eq(waMessages.direction, 'out')));
    expect(outgoing).toHaveLength(0);
    // Sent again with what the screen now shows, it goes.
    const ok = await sendTemplate(seller, leadId, {
      name: 'expansao_boas_vindas',
      params: shown.fields.map((f) => f.value),
      expect: { sendAs: 'template', charged: true },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('refuses before sending when the art does not go up to Meta, writing nothing', async () => {
    clock = new Date(START.getTime() + 60 * DAY);
    const leadId = await deal('5521977770002', seller.id, {
      pipeline: 'expansao',
      clientId: malkuth,
    });
    nextUpload = () => json({ error: { code: 131052, type: 'OAuthException' } }, 400);
    const before = uploads.length;
    const refused = await sendTemplate(seller, leadId, {
      name: 'expansao_boas_vindas',
      params: ['Ricardo', 'Fernando', 'Malkuth'],
    });
    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toBe('art_upload_failed');
    expect(uploads).toHaveLength(before + 1);
    expect(sends).toHaveLength(0);
    expect(await db.select().from(waMessages).where(eq(waMessages.leadId, leadId))).toHaveLength(0);
  });

  it('a brand with no art: the first template, a notice, and never the Wings art', async () => {
    clock = START;
    const casal = await brand('Casal do Churros', 'o');
    const leadId = await deal('5521977770003', seller.id, {
      pipeline: 'expansao',
      clientId: casal,
    });
    const before = uploads.length;
    const shown = (await preview(seller, leadId, { name: 'expansao_boas_vindas' })).json<{
      preview: WaTemplatePreview;
    }>().preview;
    expect(shown).toMatchObject({
      version: 'expansao_boas_vindas',
      sendAs: 'template',
      withArt: false,
      notices: [ART_MISSING_BRAND],
    });
    expect(shown.text).toContain('do time de expansão da Casal do Churros');
    expect(
      (await app.inject({ url: `/leads/${leadId}/whatsapp/art`, cookies: seller.cookies }))
        .statusCode,
    ).toBe(404);
    const sent = await sendTemplate(seller, leadId, {
      name: 'expansao_boas_vindas',
      params: shown.fields.map((f) => f.value),
    });
    expect(sent.statusCode).toBe(201);
    expect(uploads).toHaveLength(before);
    expect(sends.at(-1)).toMatchObject({
      template: { name: 'expansao_boas_vindas', components: [{ type: 'body' }] },
    });
    expect(JSON.stringify(sends.at(-1))).not.toContain('header');
  });

  it('keeps the brand voice in the common message made from a template', async () => {
    clock = START;
    const leadId = await deal('5521977770004', seller.id, {
      pipeline: 'expansao',
      clientId: malkuth,
    });
    await personWrites('5521977770004');
    const refused = await sendTemplate(seller, leadId, {
      name: 'wings_formatacao_boas_vindas',
      params: ['Ricardo', 'Fernando', 'Padaria'],
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('brand_voice');
    expect(sends).toHaveLength(0);
  });

  it('puts the company article the seller chose, with the Wings art in Formatação', async () => {
    clock = START;
    const formatacao = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521977770005', formatacao.id, {
      pipeline: 'formatacao',
      companyName: 'Bar do Zé',
    });
    const feminine = (
      await preview(formatacao, leadId, { name: 'wings_formatacao_boas_vindas' })
    ).json<{
      preview: WaTemplatePreview;
    }>().preview;
    expect(feminine).toMatchObject({
      version: 'wings_formatacao_boas_vindas_arte',
      usesCompanyArticle: true,
      withArt: true,
    });
    expect(feminine.text).toContain('transformar a Bar do Zé em franquia');
    const params = feminine.fields.map((f) => f.value);
    const masculine = (
      await preview(formatacao, leadId, {
        name: 'wings_formatacao_boas_vindas',
        params,
        companyArticle: 'o',
      })
    ).json<{ preview: WaTemplatePreview }>().preview;
    expect(masculine.text).toContain('transformar o Bar do Zé em franquia');
    await sendTemplate(formatacao, leadId, {
      name: 'wings_formatacao_boas_vindas',
      params,
      companyArticle: 'o',
    });
    expect(sends.at(-1)).toMatchObject({
      template: {
        name: 'wings_formatacao_boas_vindas_arte',
        components: [
          { type: 'header' },
          { parameters: [{ text: 'Ricardo' }, { type: 'text' }, { text: 'o Bar do Zé' }] },
        ],
      },
    });
  });

  it('shows neither the preview nor the art to a seller of another deal', async () => {
    const leadId = await deal('5521977770006', seller.id, {
      pipeline: 'expansao',
      clientId: malkuth,
    });
    const other = await sessionFor('vendedor_expansao');
    expect((await preview(other, leadId, { name: 'expansao_boas_vindas' })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: `/leads/${leadId}/whatsapp/art`, cookies: other.cookies }))
        .statusCode,
    ).toBe(404);
    // Diretoria sees every deal.
    const diretoria = await sessionFor('diretoria');
    expect((await preview(diretoria, leadId, { name: 'expansao_boas_vindas' })).statusCode).toBe(
      200,
    );
    const thread = await app.inject({ url: `/leads/${leadId}/whatsapp`, cookies: seller.cookies });
    expect(thread.json<DealWhatsApp>().speaksFor).toBe('Malkuth');
  });
});
