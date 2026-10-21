import { createHmac } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  SESSION_COOKIE,
  type RoleKey,
  type WaInboxSummary,
  type WaRingingSnapshot,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leads, sessions, waCalls, waConversations } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { hashToken } from '../../lib/tokens.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { logout, revokeAllSessions } from '../auth/service.js';
import { forgetCallingSettings } from './calling.js';
import { processWhatsAppEvents } from './intake.js';
import { setRingingStreamBeat } from './ringing-stream.js';

/**
 * The ringing-call stream (`GET /whatsapp/calls/stream`) against a simulated Meta:
 * the answer on connect and on every change, who sees which call, the session
 * rules (a stream is never activity; it ends with the session), and its limits.
 * The reply is read as it is written, through the injected request's stream.
 */

const APP_SECRET = 'whatsapp-app-secret-for-tests';
const TOKEN = 'fake-whatsapp-token';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let callingStatus = 'ENABLED';
const closers: Array<() => void> = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const whatsappFetch = (async (input: string | URL | Request) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.pathname.endsWith(`/${PHONE_ID}/settings`))
    return json({ calling: { status: callingStatus } });
  return json({ error: { code: 100 } }, 400);
}) as typeof fetch;

const makeApp = () =>
  buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      WHATSAPP_APP_SECRET: APP_SECRET,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'whatsapp-verify-token-long-enough',
      WHATSAPP_ACCESS_TOKEN: TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
      WHATSAPP_WABA_ID: WABA,
    }),
    db,
    whatsappFetch,
  });

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await makeApp();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(async () => {
  callingStatus = 'ENABLED';
  forgetCallingSettings();
  // An admin sees every ringing call: a test starts with none, whatever the one before left.
  await db.delete(waCalls);
});

afterEach(() => {
  setRingingStreamBeat(null);
  for (const close of closers.splice(0)) close();
});

async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'diretoria' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed');
  return { id: employee.id, token, cookies: { [SESSION_COOKIE]: token } };
}

async function deal(phone: string, ownerId: string | null) {
  const [row] = await db
    .insert(leads)
    .values({
      source: 'manual',
      name: 'Elena Prado',
      phone,
      ownerEmployeeId: ownerId,
      pipeline: 'formatacao',
    })
    .returning({ id: leads.id });
  return row!.id;
}

const sign = (body: string) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;

/** A person's call arrives by Meta's webhook and the queue applies it. */
async function ringFrom(phone: string, callId: string) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'calls',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_ID },
              contacts: [{ profile: { name: 'Elena' }, wa_id: phone }],
              calls: [
                {
                  id: callId,
                  event: 'connect',
                  direction: 'USER_INITIATED',
                  from: phone,
                  to: '15556696643',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  session: { sdp_type: 'offer', sdp: OFFER },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const response = await app.inject({
    method: 'POST',
    url: '/integrations/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  await processWhatsAppEvents({ db, phoneNumberId: PHONE_ID, log: () => {} });
}

let messages = 0;
/** The person writes: Meta's published shape of a text, delivered signed and applied by the queue. */
async function messageFrom(phone: string, text: string) {
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
              metadata: { phone_number_id: PHONE_ID },
              contacts: [{ profile: { name: 'Elena' }, wa_id: phone }],
              messages: [
                {
                  from: phone,
                  id: `wamid.STREAM${++messages}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const response = await app.inject({
    method: 'POST',
    url: '/integrations/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  await processWhatsAppEvents({ db, phoneNumberId: PHONE_ID, log: () => {} });
}

type Sse = { comment: string } | { event: string; data: unknown };

function parseSse(text: string): Sse[] {
  const whole = text.slice(0, text.lastIndexOf('\n\n') + 2);
  return whole
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((line) => line.startsWith(':'))) return { comment: lines.join('\n') };
      const event =
        lines
          .find((l) => l.startsWith('event:'))
          ?.slice(6)
          .trim() ?? 'message';
      const data = lines
        .find((l) => l.startsWith('data:'))
        ?.slice(5)
        .trim();
      return { event, data: data ? (JSON.parse(data) as unknown) : null };
    });
}

/** Opens the stream and reads it as it is written. */
async function openStream(
  cookies: Record<string, string>,
  headers: Record<string, string> = {},
  server: FastifyInstance = app,
) {
  const controller = new AbortController();
  const response = await server.inject({
    method: 'GET',
    url: '/whatsapp/calls/stream',
    cookies,
    headers,
    payloadAsStream: true,
    signal: controller.signal,
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('text/event-stream');
  const stream = response.stream() as Readable;
  let text = '';
  let ended = false;
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  stream.on('end', () => {
    ended = true;
  });
  stream.on('error', () => {
    ended = true;
  });
  closers.push(() => controller.abort());

  const events = () => parseSse(text);
  const ringing = () =>
    events().flatMap((e) =>
      'event' in e && e.event === 'ringing' ? [e.data as WaRingingSnapshot] : [],
    );
  const inbox = () =>
    events().flatMap((e) =>
      'event' in e && e.event === 'inbox' ? [e.data as WaInboxSummary] : [],
    );
  const until = async (check: () => boolean, ms = 4_000) => {
    const limit = Date.now() + ms;
    while (!check()) {
      if (Date.now() > limit) throw new Error(`stream did not reach the expected state: ${text}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return {
    events,
    ringing,
    inbox,
    until,
    text: () => text,
    ended: () => ended,
    abort: () => controller.abort(),
  };
}

const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the answer', () => {
  it('comes on connect, and again as soon as a call rings, without waiting for a beat', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    await deal('5521977002001', owner.id);
    const stream = await openStream(owner.cookies);
    await stream.until(() => stream.ringing().length === 1);
    expect(stream.ringing()[0]).toEqual({ calling: true, calls: [] });
    expect(stream.text().startsWith(': stream\n\n')).toBe(true);

    await ringFrom('5521977002001', 'wacid.S1');
    await stream.until(() => stream.ringing().length === 2);
    const calls = stream.ringing()[1]!.calls;
    expect(calls.map((c) => [c.name, c.direction, c.status])).toEqual([
      ['Elena Prado', 'in', 'ringing'],
    ]);

    // The poll route answers the very same thing (one rule, two ways to ask).
    const polled = await app.inject({
      method: 'GET',
      url: '/whatsapp/calls/ringing',
      cookies: owner.cookies,
    });
    expect(polled.json()).toEqual(stream.ringing()[1]);
  });

  it('is the answer for that person only: another seller hears nothing, an admin sees all', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const admin = await sessionFor('admin_master');
    await deal('5521977002002', owner.id);
    const ownerStream = await openStream(owner.cookies);
    const otherStream = await openStream(other.cookies);
    const adminStream = await openStream(admin.cookies);
    await ownerStream.until(() => ownerStream.ringing().length === 1);

    await ringFrom('5521977002002', 'wacid.S2');
    await ownerStream.until(() => ownerStream.ringing().length === 2);
    await adminStream.until(() => adminStream.ringing().length === 2);
    await quiet(150);
    expect(otherStream.ringing()).toEqual([{ calling: true, calls: [] }]);
    expect(adminStream.ringing()[1]!.calls).toHaveLength(1);
  });

  it('takes the card away from everyone else the moment one person picks up', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const admin = await sessionFor('admin_master');
    await deal('5521977002003', owner.id);
    const adminStream = await openStream(admin.cookies);
    await ringFrom('5521977002003', 'wacid.S3');
    await adminStream.until(() => adminStream.ringing().at(-1)!.calls.length === 1);
    const id = adminStream.ringing().at(-1)!.calls[0]!.id;

    const picked = await app.inject({
      method: 'POST',
      url: `/whatsapp/calls/${id}/pickup`,
      cookies: owner.cookies,
    });
    expect(picked.statusCode).toBe(200);
    await adminStream.until(() => adminStream.ringing().at(-1)!.calls.length === 0);
  });

  it('drops a call when its ring runs out, though nobody writes anything then', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    await deal('5521977002004', owner.id);
    await ringFrom('5521977002004', 'wacid.S4');
    // 59 s into a 60 s ring.
    await db.update(waCalls).set({ startedAt: new Date(Date.now() - 59_000) });
    const stream = await openStream(owner.cookies);
    await stream.until(() => stream.ringing().length === 1);
    expect(stream.ringing()[0]!.calls).toHaveLength(1);
    await stream.until(() => stream.ringing().length === 2, 5_000);
    expect(stream.ringing()[1]!.calls).toEqual([]);
  });

  it('says calling is off when the number does not take calls, and shows it when it does', async () => {
    callingStatus = 'DISABLED';
    const owner = await sessionFor('vendedor_formatacao');
    const stream = await openStream(owner.cookies);
    await stream.until(() => stream.ringing().length === 1);
    expect(stream.ringing()[0]).toEqual({ calling: false, calls: [] });
  });
});

describe('the inbox (Caixa como o WhatsApp Desktop)', () => {
  const summaryOf = async (cookies: Record<string, string>) =>
    (await app.inject({ url: '/whatsapp/inbox/summary', cookies })).json<WaInboxSummary>();
  const conversationOf = async (leadId: string) =>
    (await db.select().from(waConversations).where(eq(waConversations.leadId, leadId)))[0]!;

  it('comes on connect, and again the moment a message arrives, for its readers only', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    await deal('5521977002101', owner.id);
    const ownerStream = await openStream(owner.cookies);
    const otherStream = await openStream(other.cookies);
    await ownerStream.until(() => ownerStream.inbox().length === 1);
    await otherStream.until(() => otherStream.inbox().length === 1);
    expect(ownerStream.inbox()[0]).toEqual(await summaryOf(owner.cookies));
    expect(ownerStream.inbox()[0]!.unread).toBe(0);

    await messageFrom('5521977002101', 'oi, tudo bem?');
    await ownerStream.until(() => ownerStream.inbox().length === 2);
    expect(ownerStream.inbox()[1]!.unread).toBe(1);
    // The poll route answers the very same thing.
    expect(ownerStream.inbox()[1]).toEqual(await summaryOf(owner.cookies));
    await quiet(150);
    expect(otherStream.inbox()).toHaveLength(1);
  });

  it('counts the conversation read in every tab once one of them opens it', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const lead = await deal('5521977002102', owner.id);
    await messageFrom('5521977002102', 'bom dia');
    const stream = await openStream(owner.cookies);
    await stream.until(() => stream.inbox().length === 1);
    expect(stream.inbox()[0]!.unread).toBe(1);

    const opened = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${(await conversationOf(lead)).id}/read`,
      cookies: owner.cookies,
    });
    expect(opened.statusCode).toBe(204);
    await stream.until(() => stream.inbox().length === 2);
    expect(stream.inbox()[1]!.unread).toBe(0);
  });

  it('moves the stamp when the team writes, without waiting for a beat', async () => {
    const admin = await sessionFor('admin_master');
    const lead = await deal('5521977002103', null);
    await messageFrom('5521977002103', 'quero um orçamento');
    const stream = await openStream(admin.cookies);
    await stream.until(() => stream.inbox().length === 1);

    // Meta (simulated) refuses the send: the message is still written, so the inbox moved.
    const sent = await app.inject({
      method: 'POST',
      url: `/leads/${lead}/whatsapp/text`,
      cookies: admin.cookies,
      payload: { text: 'Olá! Já te mando.' },
    });
    expect(sent.statusCode).toBeLessThan(500);
    await stream.until(() => stream.inbox().length === 2);
    expect(stream.inbox()[1]!.stamp).not.toBe(stream.inbox()[0]!.stamp);
  });
});

describe('the beat', () => {
  it('keeps the reply alive with a comment line', async () => {
    setRingingStreamBeat(40);
    const owner = await sessionFor('vendedor_formatacao');
    const stream = await openStream(owner.cookies);
    await stream.until(() => stream.text().split(': ping').length > 3);
    // A beat that finds nothing new sends no second answer.
    expect(stream.ringing()).toHaveLength(1);
  });
});

describe('the session', () => {
  const lastSeen = async (token: string) =>
    (await db.query.sessions.findFirst({ where: eq(sessions.id, hashToken(token)) }))!;

  it('is not activity: an open stream never moves the idle clock, whatever the client sends', async () => {
    setRingingStreamBeat(40);
    const owner = await sessionFor('vendedor_formatacao');
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await db
      .update(sessions)
      .set({ lastSeenAt: tenMinutesAgo })
      .where(eq(sessions.id, hashToken(owner.token)));

    // No passive header on purpose: the route makes it passive by itself.
    const stream = await openStream(owner.cookies);
    await stream.until(() => stream.text().split(': ping').length > 3);
    expect((await lastSeen(owner.token)).lastSeenAt).toEqual(tenMinutesAgo);
  });

  it('ends at the next beat when the session went idle, closing it as a passive poll would', async () => {
    setRingingStreamBeat(40);
    const owner = await sessionFor('vendedor_formatacao');
    const stream = await openStream(owner.cookies);
    await stream.until(() => stream.ringing().length === 1);
    const idle = new Date(Date.now() - 31 * 60_000);
    await db
      .update(sessions)
      .set({ lastSeenAt: idle })
      .where(eq(sessions.id, hashToken(owner.token)));

    await stream.until(() =>
      stream.events().some((e) => 'event' in e && e.event === 'session_ended'),
    );
    await stream.until(() => stream.ended());
    const row = await lastSeen(owner.token);
    expect(row.revokedAt).not.toBeNull();
    expect(row.lastSeenAt).toEqual(idle);
  });

  it('ends at once on logout, with no beat to wait for', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const stream = await openStream(owner.cookies);
    await stream.until(() => stream.ringing().length === 1);
    await logout(db, owner.token);
    await stream.until(() =>
      stream.events().some((e) => 'event' in e && e.event === 'session_ended'),
    );
    await stream.until(() => stream.ended());
  });

  it('ends at once for every session of a person who is deactivated, and for nobody else', async () => {
    const leaving = await sessionFor('vendedor_formatacao');
    const staying = await sessionFor('vendedor_formatacao');
    const a = await openStream(leaving.cookies);
    const b = await openStream(leaving.cookies);
    const c = await openStream(staying.cookies);
    await Promise.all([a, b, c].map((s) => s.until(() => s.ringing().length === 1)));

    await revokeAllSessions(db, leaving.id, 'deactivated');
    for (const s of [a, b]) {
      await s.until(() => s.events().some((e) => 'event' in e && e.event === 'session_ended'));
      await s.until(() => s.ended());
    }
    await quiet(100);
    expect(c.ended()).toBe(false);
  });

  it('refuses a request with no session (401) and one without the call permission (403)', async () => {
    const none = await app.inject({ method: 'GET', url: '/whatsapp/calls/stream' });
    expect(none.statusCode).toBe(401);
    const rh = await sessionFor('rh_dp');
    const refused = await app.inject({
      method: 'GET',
      url: '/whatsapp/calls/stream',
      cookies: rh.cookies,
    });
    expect(refused.statusCode).toBe(403);
  });

  it('refuses the ninth stream of one person, and takes one again when they close', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const streams = [];
    for (let i = 0; i < 8; i++) streams.push(await openStream(owner.cookies));
    const ninth = await app.inject({
      method: 'GET',
      url: '/whatsapp/calls/stream',
      cookies: owner.cookies,
    });
    expect(ninth.statusCode).toBe(429);
    expect(ninth.json()).toMatchObject({ error: 'too_many_streams' });

    streams[0]!.abort();
    await quiet(50);
    const again = await openStream(owner.cookies);
    await again.until(() => again.ringing().length === 1);
  });
});

describe('the connection', () => {
  it('keeps no place for a client that hung up while its session was being checked', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    for (let i = 0; i < 10; i++) {
      const hangUp = new AbortController();
      const pending = app
        .inject({
          method: 'GET',
          url: '/whatsapp/calls/stream',
          cookies: owner.cookies,
          payloadAsStream: true,
          signal: hangUp.signal,
        })
        .catch(() => undefined);
      hangUp.abort();
      await pending;
    }
    await quiet(100);
    // Ten hang-ups left nothing behind: eight streams still fit.
    for (let i = 0; i < 8; i++) {
      const stream = await openStream(owner.cookies);
      await stream.until(() => stream.ringing().length === 1);
    }
  });

  it('is ended when the server closes, instead of holding the shutdown', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const other = await makeApp();
    const stream = await openStream(owner.cookies, {}, other);
    await stream.until(() => stream.ringing().length === 1);
    await other.close();
    await stream.until(() => stream.ended());
    // A shutdown is not a session ending: the screen is told nothing, and comes back.
    expect(stream.events().some((e) => 'event' in e && e.event === 'session_ended')).toBe(false);
  });
});
