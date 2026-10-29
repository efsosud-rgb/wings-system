import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE, type DriveUploadTicket, type LeadFile, type RoleKey } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  createEmployee,
  fakeJpeg,
  setOfficialLive,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import { processWhatsAppEvents } from './intake.js';

/**
 * What the file-send tests share (media-send.test.ts, media-bubble.test.ts): a simulated Meta that
 * records sends, uploads and downloads (and can be told to fail the next one), the app on a
 * throwaway database with local storage, the 24-hour window opened by a signed webhook, and a
 * deal's file put in the way the browser does. Each test file wires `startMediaSend`,
 * `stopMediaSend` and `resetMediaSend` to its own hooks; nothing here reaches the network.
 */

export const APP_SECRET = 'whatsapp-app-secret-for-tests';
export const TOKEN = 'fake-whatsapp-token';
export const PHONE_ID = '1253469287856067';
export const WABA = '2116475762622670';
export const START = new Date('2026-10-21T15:00:00Z');
export const DAY = 24 * 3_600_000;
export const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));

export let harness: TestDatabase;
export let db: Database;
export let app: FastifyInstance;
export let dir: string;
export let clock = START;

export const sends: Record<string, unknown>[] = [];
export const uploads: { type: string | null; size: number; name: string | null }[] = [];
export const downloads: string[] = [];
export let nextSend: () => Response = () => accepted();
export let nextUpload: () => Response | null = () => null;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export let wamid = 0;
export const accepted = (): Response =>
  json({
    messaging_product: 'whatsapp',
    contacts: [{ input: 'x', wa_id: '552199990001' }],
    messages: [{ id: `wamid.FILE${++wamid}` }],
  });

export const whatsappFetch = (async (input: string | URL | Request, init?: RequestInit) => {
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

export async function sessionFor(role: RoleKey) {
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
export type Session = Awaited<ReturnType<typeof sessionFor>>;

export let phoneNumber = 0;
export const nextPhone = () => `55219888${String(++phoneNumber).padStart(5, '0')}`;

export async function deal(
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
export async function personWrites(phone: string) {
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

export async function signed(body: string) {
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
export async function dealFile(
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

export const sendFile = (session: Session, path: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: path, cookies: session.cookies, payload });

export const PDF = Buffer.from('%PDF-1.4 proposta de teste');
export const PHOTO = fakeJpeg(800, 600, 40_000);

export let seller: Session;
export let otherSeller: Session;
export let admin: Session;

/** A deal of the seller with the window open and one file in its Arquivos. */
export async function openDealWith(name: string, mimeType: string, bytes: Buffer) {
  const phone = nextPhone();
  const leadId = await deal(phone, seller.id);
  await personWrites(phone);
  const fileId = await dealFile(seller, leadId, name, mimeType, bytes);
  return { phone, leadId, fileId };
}

export const setClock = (at: Date) => {
  clock = at;
};
export const setNextSend = (answer: () => Response) => {
  nextSend = answer;
};
export const setNextUpload = (answer: () => Response | null) => {
  nextUpload = answer;
};

/** The app on a throwaway database and local storage, and the three people the tests act as. */
export async function startMediaSend() {
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
  seller = await sessionFor('vendedor_expansao');
  otherSeller = await sessionFor('vendedor_expansao');
  admin = await sessionFor('admin_master');
}

export async function stopMediaSend() {
  await app?.close();
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
}

export async function resetMediaSend() {
  clock = START;
  sends.length = 0;
  uploads.length = 0;
  downloads.length = 0;
  nextSend = () => accepted();
  nextUpload = () => null;
  await setOfficialLive(db, true);
}
