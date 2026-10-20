import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE, type RoleKey } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  leads,
  waContacts,
  waConversations,
  waMessageFiles,
  waMessages,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { storageOf, type ObjectStorage } from '../../lib/storage/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { storeWhatsAppMedia } from './media-store.js';

/**
 * Received files copied to our storage, against a simulated Meta and the local
 * storage: one copy per file, the screen opening it from storage by a short
 * address, the tries again and the files left alone, and the file deleted with
 * its message. No test reaches the network.
 */

const TOKEN = 'fake-whatsapp-token';
const PHONE_ID = '1253469287856067';
const CONFIG = { token: TOKEN, phoneNumberId: PHONE_ID, wabaId: null };
const LOOKASIDE = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let dir: string;
let storage: ObjectStorage;
const calls: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Meta's media answers: GET /{media-id} gives the address, the address gives the bytes. */
const MEDIA: Record<string, () => Response> = {
  'media-ok': () => json({ url: `${LOOKASIDE}?mid=ok`, mime_type: 'image/jpeg', file_size: 8 }),
  'media-html': () => json({ url: `${LOOKASIDE}?mid=html`, mime_type: 'text/html', file_size: 8 }),
  'media-big': () =>
    json({ url: `${LOOKASIDE}?mid=big`, mime_type: 'video/mp4', file_size: 200 * 1024 * 1024 }),
  'media-evil': () => json({ url: 'https://evil.example/steal', mime_type: 'image/jpeg' }),
  // Meta's free text can carry anything; only its code may be kept.
  'media-down': () =>
    json({ error: { code: 131052, type: 'Contato 5521900000000 indisponível' } }, 500),
};

const whatsappFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  calls.push(url.href);
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  if (url.hostname === 'lookaside.fbsbx.com')
    return new Response(url.searchParams.get('mid') === 'html' ? '<p>oi</p>' : 'JPEGDATA');
  const answer = MEDIA[url.pathname.split('/').pop() ?? ''];
  return answer ? answer() : json({ error: { code: 100 } }, 400);
}) as typeof fetch;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-wa-media-'));
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      MEDIA_DIR: dir,
      WHATSAPP_ACCESS_TOKEN: TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
    }),
    db,
    whatsappFetch,
  });
  storage = storageOf(app.wings)!;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
});

const store = (now: Date, over: Partial<ObjectStorage> = {}) =>
  storeWhatsAppMedia({
    db,
    storage: { ...storage, ...over },
    config: CONFIG,
    fetchImpl: whatsappFetch,
    log: () => {},
    now: () => now,
  });

async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

let phoneSeq = 0;
/** A deal with one conversation; `file` adds a message to it. */
async function conversation(ownerId: string | null = null) {
  const phone = `55219${String(++phoneSeq).padStart(8, '0')}`;
  const [lead] = await db
    .insert(leads)
    .values({
      source: 'manual',
      name: 'Elena Prado',
      phone,
      ownerEmployeeId: ownerId,
      pipeline: 'formatacao',
    })
    .returning({ id: leads.id });
  const [contact] = await db.insert(waContacts).values({ phone }).returning();
  const [row] = await db
    .insert(waConversations)
    .values({ contactId: contact!.id, leadId: lead!.id })
    .returning();
  const file = async (content: Record<string, unknown>, createdAt: Date, kind = 'image') =>
    (
      await db
        .insert(waMessages)
        .values({
          conversationId: row!.id,
          contactId: contact!.id,
          leadId: lead!.id,
          direction: 'in',
          author: 'contact',
          kind,
          content,
          createdAt,
        })
        .returning()
    )[0]!.id;
  return { leadId: lead!.id, file };
}

const fileOf = async (messageId: string) =>
  db.query.waMessageFiles.findFirst({ where: eq(waMessageFiles.messageId, messageId) });
const media = (id: string, filename: string | null = null) => ({
  media: { id, mimeType: 'x', filename },
});
const minutes = (at: Date, n: number) => new Date(at.getTime() + n * 60_000);

describe('received files go to our storage', () => {
  it('copies a file once, and the screen then opens it from storage by a short address', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const now = new Date();
    const { file } = await conversation(owner.id);
    const messageId = await file(media('media-ok', 'foto.jpg'), now);

    const first = await store(now);
    expect(first).toMatchObject({ queued: 1, stored: 1, failed: 0 });
    const kept = await fileOf(messageId);
    expect(kept).toMatchObject({ status: 'stored', mimeType: 'image/jpeg', byteSize: 8 });
    expect(kept!.storageKey).toMatch(/^whatsapp\/\d{4}-\d{2}\/[0-9a-f-]{36}$/);
    expect((await storage.get(kept!.storageKey))?.toString()).toBe('JPEGDATA');

    const fetched = calls.length;
    expect(await store(minutes(now, 5))).toMatchObject({ queued: 0, stored: 0 });
    expect(calls.length).toBe(fetched);

    const opened = await app.inject({
      method: 'GET',
      url: `/whatsapp/messages/${messageId}/media`,
      cookies: owner.cookies,
    });
    expect(opened.statusCode).toBe(302);
    expect(opened.headers['cache-control']).toBe('private, max-age=240');
    expect(calls.length).toBe(fetched); // nothing asked of Meta
    const served = await app.inject({
      method: 'GET',
      url: String(opened.headers.location).replace('http://localhost:5173/api', ''),
    });
    expect(served.statusCode).toBe(200);
    expect(served.body).toBe('JPEGDATA');
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(served.headers['content-disposition']).toMatch(/^inline; filename="foto.jpg"/);

    const refused = await app.inject({
      method: 'GET',
      url: `/whatsapp/messages/${messageId}/media`,
      cookies: other.cookies,
    });
    expect(refused.statusCode).toBe(404);
  });

  it('a type a browser could run comes from storage only as a download', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const now = new Date();
    const { file } = await conversation(owner.id);
    const messageId = await file(media('media-html', '<script>.html'), now, 'document');
    await store(now);
    const opened = await app.inject({
      method: 'GET',
      url: `/whatsapp/messages/${messageId}/media`,
      cookies: owner.cookies,
    });
    const served = await app.inject({
      method: 'GET',
      url: String(opened.headers.location).replace('http://localhost:5173/api', ''),
    });
    expect(served.headers['content-type']).toBe('application/octet-stream');
    expect(served.headers['content-disposition']).toMatch(/^attachment; filename="_script_.html"/);
  });

  it('tries a failed copy again later, and leaves a file that cannot change alone', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const now = new Date();
    const { file } = await conversation(owner.id);
    const down = await file(media('media-down'), now);
    const big = await file(media('media-big'), now, 'video');
    const evil = await file(media('media-evil'), now);

    expect(await store(now)).toMatchObject({ queued: 3, stored: 0, retried: 1, failed: 2 });
    expect(await fileOf(big)).toMatchObject({ status: 'failed', lastError: 'too_large' });
    expect(await fileOf(evil)).toMatchObject({ status: 'failed', lastError: 'bad_media_url' });
    expect(calls.some((url) => url.includes('evil.example'))).toBe(false);
    const retried = await fileOf(down);
    expect(retried).toMatchObject({ status: 'pending', attempts: 1, lastError: 'meta_131052' });
    expect(retried!.nextAttemptAt).toEqual(minutes(now, 1));
    expect(JSON.stringify(retried)).not.toContain('5521');

    // Not again before its time; then once more, with a longer wait.
    expect(await store(minutes(now, 0.5))).toMatchObject({ retried: 0 });
    expect(await store(minutes(now, 1))).toMatchObject({ retried: 1 });
    expect(await fileOf(down)).toMatchObject({ attempts: 2 });
    expect((await fileOf(down))!.nextAttemptAt).toEqual(minutes(now, 6));

    // The last try leaves it failed; the screen still asks Meta for it.
    await db
      .update(waMessageFiles)
      .set({ attempts: 7, nextAttemptAt: now })
      .where(eq(waMessageFiles.messageId, down));
    expect(await store(minutes(now, 7))).toMatchObject({ failed: 1 });
    expect(await fileOf(down)).toMatchObject({ status: 'failed', attempts: 8 });
    expect(await store(minutes(now, 60 * 48))).toMatchObject({ retried: 0, failed: 0 });
    const asked = await app.inject({
      method: 'GET',
      url: `/whatsapp/messages/${down}/media`,
      cookies: owner.cookies,
    });
    expect(asked.statusCode).toBe(502);
  });

  it('a copy that storage refused, or that stopped half-way, is taken again later', async () => {
    const now = new Date();
    const { file } = await conversation();
    const messageId = await file(media('media-ok'), now);
    const refused = await store(now, {
      put: () => Promise.reject(new Error('bucket down')),
    });
    expect(refused).toMatchObject({ retried: 1 });
    expect(await fileOf(messageId)).toMatchObject({ status: 'pending', lastError: 'storage_put' });

    // A restart between the claim and the answer: the claim holds for ten minutes.
    await db
      .update(waMessageFiles)
      .set({ nextAttemptAt: minutes(now, 11) })
      .where(eq(waMessageFiles.messageId, messageId));
    expect(await store(minutes(now, 10))).toMatchObject({ stored: 0 });
    expect(await store(minutes(now, 11))).toMatchObject({ stored: 1 });
    expect(await fileOf(messageId)).toMatchObject({ status: 'stored', lastError: null });
  });

  it('queues only recent messages that have a file of Meta', async () => {
    const now = new Date();
    const { file } = await conversation();
    const old = await file(media('media-ok'), minutes(now, -31 * 24 * 60));
    const text = await file({}, now, 'text');
    const imported = await file({ imported: { file: 'IMG-1.jpg' } }, now);
    await store(now);
    for (const id of [old, text, imported]) expect(await fileOf(id)).toBeUndefined();
  });

  it('deletes the file when its message goes, which only goes with its deal', async () => {
    const now = new Date();
    const { leadId, file } = await conversation();
    const messageId = await file(media('media-ok'), now);
    await store(now);
    const kept = await fileOf(messageId);
    expect(await storage.head(kept!.storageKey)).not.toBeNull();

    // A deal cannot be deleted with its conversation still there: whoever deletes it deletes these first.
    await expect(
      db
        .delete(leads)
        .where(eq(leads.id, leadId))
        .then(() => 'deleted'),
    ).rejects.toThrow();
    await db.delete(waMessages).where(eq(waMessages.leadId, leadId));
    const orphan = await db.query.waMessageFiles.findFirst({
      where: eq(waMessageFiles.id, kept!.id),
    });
    expect(orphan?.messageId).toBeNull();

    expect(await store(minutes(now, 1))).toMatchObject({ deleted: 1 });
    expect(await storage.head(kept!.storageKey)).toBeNull();
    expect(
      await db.query.waMessageFiles.findFirst({ where: eq(waMessageFiles.id, kept!.id) }),
    ).toBeUndefined();
  });
});
