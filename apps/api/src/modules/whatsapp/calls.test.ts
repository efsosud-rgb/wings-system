import { createHmac } from 'node:crypto';
import { SESSION_COOKIE, type DealWhatsApp, type RoleKey, type WaCall } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leadActivities, leads, leadTasks, waCalls, waContacts } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  createEmployee,
  setOfficialLive,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import { forgetCallingSettings } from './calling.js';
import { CALL_REQUEST_TASK, processWhatsAppEvents, sweepCalls } from './intake.js';

/**
 * WhatsApp voice calls against a simulated Meta: placing one (the browser's
 * offer out, Meta's answer back by webhook), picking one up (first in reach
 * wins), hanging up, permissions, and each finished call on the deal once,
 * with the real duration. No test reaches the network.
 */

const APP_SECRET = 'whatsapp-app-secret-for-tests';
const TOKEN = 'fake-whatsapp-token';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';
const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const ANSWER =
  'v=0\r\no=- 3 4 IN IP4 157.240.0.1\r\ns=-\r\na=ice-lite\r\nm=audio 3480 UDP/TLS/RTP/SAVPF 111\r\n';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let callingStatus = 'ENABLED';
let connectAnswer: () => Response = () =>
  json({ messaging_product: 'whatsapp', calls: [{ id: 'wacid.OUT1' }] });
let permissionAnswer: unknown = { permission: { status: 'no_permission' }, actions: [] };
const posts: Record<string, unknown>[] = [];
let wamids = 0;
/** Every request that reached the simulated Meta, whatever it was. */
const fetched: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const whatsappFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  fetched.push(url.pathname);
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  if (url.pathname.endsWith(`/${PHONE_ID}/settings`))
    return json({ calling: { status: callingStatus } });
  if (url.pathname.endsWith(`/${PHONE_ID}/call_permissions`)) return json(permissionAnswer);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  if (url.pathname.endsWith(`/${PHONE_ID}/calls`)) {
    posts.push(body);
    return body.action === 'connect'
      ? connectAnswer()
      : json({ messaging_product: 'whatsapp', success: true });
  }
  if (url.pathname.endsWith(`/${PHONE_ID}/messages`)) {
    posts.push(body);
    return json({
      messaging_product: 'whatsapp',
      contacts: [{ wa_id: String(body.to) }],
      // Unique across the file: wa_messages.wamid is unique.
      messages: [{ id: `wamid.M${++wamids}` }],
    });
  }
  return json({ error: { code: 100 } }, 400);
}) as typeof fetch;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
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
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(async () => {
  posts.length = 0;
  fetched.length = 0;
  callingStatus = 'ENABLED';
  // Sellers call here; the lock before the number is live is tested at the end of this file.
  await setOfficialLive(db, true);
  connectAnswer = () =>
    json({ messaging_product: 'whatsapp', calls: [{ id: `wacid.OUT${Math.random()}` }] });
  forgetCallingSettings();
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
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
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
async function deliver(value: Record<string, unknown>, field = 'calls') {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field,
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_ID },
              ...value,
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
const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));
const callEvent = (event: Record<string, unknown>) =>
  deliver({ calls: [{ timestamp: unix(new Date()), ...event }] });
const activitiesOf = (leadId: string) =>
  db.select().from(leadActivities).where(eq(leadActivities.leadId, leadId));

describe('placing a call', () => {
  it('sends the browser offer once, gives Meta’s answer back to the caller only, and logs it on the deal once', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const admin = await sessionFor('admin_master');
    const leadId = await deal('5521977001111', owner.id);
    connectAnswer = () => json({ messaging_product: 'whatsapp', calls: [{ id: 'wacid.A1' }] });
    const started = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/calls`,
      cookies: owner.cookies,
      payload: { sdp: OFFER },
    });
    expect(started.statusCode).toBe(201);
    const call = started.json<{ call: WaCall }>().call;
    expect(call).toMatchObject({ direction: 'out', status: 'dialing', leadId });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      to: '5521977001111',
      action: 'connect',
      session: { sdp_type: 'offer', sdp: OFFER },
      biz_opaque_callback_data: call.id,
    });

    await callEvent({
      id: 'wacid.A1',
      event: 'connect',
      direction: 'BUSINESS_INITIATED',
      to: '5521977001111',
      from: '15556696643',
      biz_opaque_callback_data: call.id,
      session: { sdp_type: 'answer', sdp: ANSWER },
    });
    const mine = await app.inject({
      method: 'GET',
      url: `/whatsapp/calls/${call.id}`,
      cookies: owner.cookies,
    });
    expect(mine.json<{ call: WaCall }>().call.answerSdp).toBe(ANSWER);
    const theirs = await app.inject({
      method: 'GET',
      url: `/whatsapp/calls/${call.id}`,
      cookies: admin.cookies,
    });
    expect(theirs.json<{ call: WaCall }>().call.answerSdp).toBeNull();

    await deliver({
      statuses: [
        {
          id: 'wacid.A1',
          type: 'call',
          status: 'ACCEPTED',
          timestamp: unix(new Date()),
          biz_opaque_callback_data: call.id,
        },
      ],
    });
    const end = {
      id: 'wacid.A1',
      event: 'terminate',
      direction: 'BUSINESS_INITIATED',
      to: '5521977001111',
      status: 'COMPLETED',
      start_time: unix(new Date()),
      end_time: unix(new Date()),
      duration: 95,
    };
    await callEvent(end);
    await callEvent(end); // Meta repeats itself
    const [row] = await db.select().from(waCalls).where(eq(waCalls.callId, 'wacid.A1'));
    expect(row).toMatchObject({ status: 'completed', durationSeconds: 95, remoteSdp: null });
    const logged = await activitiesOf(leadId);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      kind: 'call',
      outcome: 'answered',
      durationSeconds: 95,
      actorEmployeeId: owner.id,
      note: 'Pelo WhatsApp · ligação feita',
    });
  });

  it('finds the call by our own id when Meta’s webhook beats its answer', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521977002222', owner.id);
    connectAnswer = () => json({ messaging_product: 'whatsapp', calls: [{ id: 'wacid.RACE' }] });
    const started = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/calls`,
      cookies: owner.cookies,
      payload: { sdp: OFFER },
    });
    const opaque = started.json<{ call: WaCall }>().call.id;
    await db.update(waCalls).set({ callId: null }).where(eq(waCalls.id, opaque)); // as if Meta had not answered yet
    await callEvent({
      id: 'wacid.RACE',
      event: 'connect',
      direction: 'BUSINESS_INITIATED',
      to: '5521977002222',
      biz_opaque_callback_data: opaque,
      session: { sdp_type: 'answer', sdp: ANSWER },
    });
    const [row] = await db.select().from(waCalls).where(eq(waCalls.id, opaque));
    expect(row).toMatchObject({ callId: 'wacid.RACE', remoteSdp: ANSWER, status: 'ringing' });
  });

  it('refuses while calling is off, and keeps Meta’s refusal without putting it on the deal', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521977003333', owner.id);
    callingStatus = 'DISABLED';
    const off = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/calls`,
      cookies: owner.cookies,
      payload: { sdp: OFFER },
    });
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toBe('calling_off');
    expect(posts).toHaveLength(0);
    forgetCallingSettings();
    callingStatus = 'ENABLED';
    connectAnswer = () => json({ error: { code: 138006, message: 'no permission' } }, 400);
    const refused = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/calls`,
      cookies: owner.cookies,
      payload: { sdp: OFFER },
    });
    expect(refused.json<{ call: WaCall }>().call).toMatchObject({ status: 'failed' });
    expect(refused.json<{ call: WaCall }>().call.error).toContain('peça a permissão');
    await sweepCalls(db, new Date(Date.now() + 10 * 60_000));
    expect(await activitiesOf(leadId)).toHaveLength(0);
  });

  it('hangs up with terminate, then takes Meta’s real duration', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521977004444', owner.id);
    connectAnswer = () => json({ messaging_product: 'whatsapp', calls: [{ id: 'wacid.H1' }] });
    const started = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/calls`,
      cookies: owner.cookies,
      payload: { sdp: OFFER },
    });
    const id = started.json<{ call: WaCall }>().call.id;
    await app.inject({
      method: 'POST',
      url: `/whatsapp/calls/${id}/connected`,
      cookies: owner.cookies,
    });
    const hung = await app.inject({
      method: 'POST',
      url: `/whatsapp/calls/${id}/hangup`,
      cookies: owner.cookies,
    });
    expect(hung.json<{ call: WaCall }>().call.status).toBe('completed');
    expect(posts.at(-1)).toMatchObject({ call_id: 'wacid.H1', action: 'terminate' });
    await callEvent({
      id: 'wacid.H1',
      event: 'terminate',
      direction: 'BUSINESS_INITIATED',
      to: '5521977004444',
      status: 'COMPLETED',
      duration: 42,
    });
    const logged = await activitiesOf(leadId);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.durationSeconds).toBe(42);
  });
});

describe('a call coming in', () => {
  it('rings for who sees the deal, goes to the first who picks up, and is accepted with the browser answer', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const admin = await sessionFor('admin_master');
    const leadId = await deal('5521977005555', owner.id);
    await deliver({
      contacts: [{ profile: { name: 'Elena' }, wa_id: '5521977005555' }],
      calls: [
        {
          id: 'wacid.IN1',
          event: 'connect',
          direction: 'USER_INITIATED',
          from: '5521977005555',
          to: '15556696643',
          timestamp: unix(new Date()),
          session: { sdp_type: 'offer', sdp: OFFER },
        },
      ],
    });
    const ringing = async (cookies: Record<string, string>) =>
      (await app.inject({ method: 'GET', url: '/whatsapp/calls/ringing', cookies })).json<{
        calls: WaCall[];
      }>().calls;
    expect((await ringing(owner.cookies)).map((c) => c.name)).toEqual(['Elena Prado']);
    expect(await ringing(other.cookies)).toEqual([]);
    const id = (await ringing(admin.cookies))[0]!.id;

    const picked = await app.inject({
      method: 'POST',
      url: `/whatsapp/calls/${id}/pickup`,
      cookies: owner.cookies,
    });
    expect(picked.json().offerSdp).toBe(OFFER);
    const late = await app.inject({
      method: 'POST',
      url: `/whatsapp/calls/${id}/pickup`,
      cookies: admin.cookies,
    });
    expect(late.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/whatsapp/calls/${id}/pickup`,
          cookies: other.cookies,
        })
      ).statusCode,
    ).toBe(404);

    const accepted = await app.inject({
      method: 'POST',
      url: `/whatsapp/calls/${id}/accept`,
      cookies: owner.cookies,
      payload: { sdp: ANSWER },
    });
    expect(accepted.json<{ call: WaCall }>().call.status).toBe('accepted');
    expect(posts.map((p) => p.action)).toEqual(['accept']); // no pre_accept from a browser
    expect(posts[0]).toMatchObject({
      call_id: 'wacid.IN1',
      session: { sdp_type: 'answer', sdp: ANSWER },
    });

    await callEvent({
      id: 'wacid.IN1',
      event: 'terminate',
      direction: 'USER_INITIATED',
      from: '5521977005555',
      status: 'COMPLETED',
      duration: 30,
    });
    const logged = await activitiesOf(leadId);
    expect(logged[0]).toMatchObject({
      outcome: 'answered',
      durationSeconds: 30,
      actorEmployeeId: owner.id,
      note: 'Pelo WhatsApp · ligação recebida',
    });
    const [contact] = await db
      .select()
      .from(waContacts)
      .where(eq(waContacts.phone, '5521977005555'));
    expect(contact?.lastInboundAt).not.toBeNull(); // a call opens the 24-hour window
  });

  it('a call nobody picked up goes on the deal as not answered, even when the end comes first', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521977006666', owner.id);
    await callEvent({
      id: 'wacid.MISS',
      event: 'terminate',
      direction: 'USER_INITIATED',
      from: '5521977006666',
      status: 'FAILED',
    });
    await callEvent({
      id: 'wacid.MISS',
      event: 'connect',
      direction: 'USER_INITIATED',
      from: '5521977006666',
      session: { sdp_type: 'offer', sdp: OFFER },
    });
    const [row] = await db.select().from(waCalls).where(eq(waCalls.callId, 'wacid.MISS'));
    expect(row).toMatchObject({ status: 'missed', direction: 'in' });
    const logged = await activitiesOf(leadId);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      outcome: 'no_answer',
      actorEmployeeId: null,
      note: 'Pelo WhatsApp · ligação recebida, não atendida',
    });
  });

  it('closes a call that rang out without a webhook', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    await deal('5521977007777', owner.id);
    await callEvent({
      id: 'wacid.OLD',
      event: 'connect',
      direction: 'USER_INITIATED',
      from: '5521977007777',
      session: { sdp_type: 'offer', sdp: OFFER },
    });
    await sweepCalls(db, new Date(Date.now() + 5 * 60_000));
    const [row] = await db.select().from(waCalls).where(eq(waCalls.callId, 'wacid.OLD'));
    expect(row).toMatchObject({ status: 'missed', remoteSdp: null });
  });
});

describe('call permission', () => {
  it('reads Meta’s answer, asks inside the window, and keeps the person’s reply', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521977008888', owner.id);
    const ask = () =>
      app.inject({
        method: 'POST',
        url: `/leads/${leadId}/whatsapp/call-permission`,
        cookies: owner.cookies,
      });
    expect((await ask()).statusCode).toBe(409); // never wrote: no window
    await deliver(
      {
        contacts: [{ profile: { name: 'Elena' }, wa_id: '5521977008888' }],
        messages: [
          {
            from: '5521977008888',
            id: 'wamid.P1',
            timestamp: unix(new Date()),
            type: 'text',
            text: { body: 'Pode me ligar' },
          },
        ],
      },
      'messages',
    );
    const sent = await ask();
    expect(sent.statusCode).toBe(201);
    expect(posts.at(-1)).toMatchObject({
      type: 'interactive',
      interactive: { type: 'call_permission_request', action: { name: 'call_permission_request' } },
    });
    let thread = (
      await app.inject({ method: 'GET', url: `/leads/${leadId}/whatsapp`, cookies: owner.cookies })
    ).json<DealWhatsApp>();
    expect(thread.callPermission.status).toBe('requested');
    expect(thread.calling).toBe(true);

    await deliver(
      {
        messages: [
          {
            from: '5521977008888',
            id: 'wamid.P2',
            timestamp: unix(new Date()),
            type: 'interactive',
            interactive: {
              type: 'call_permission_reply',
              call_permission_reply: {
                response: 'accept',
                is_permanent: true,
                response_source: 'user_action',
              },
            },
          },
        ],
      },
      'messages',
    );
    thread = (
      await app.inject({ method: 'GET', url: `/leads/${leadId}/whatsapp`, cookies: owner.cookies })
    ).json<DealWhatsApp>();
    expect(thread.callPermission).toMatchObject({ status: 'permanent', expiresAt: null });
    expect(thread.messages.at(-1)?.text).toBe('Permitiu ligações');

    const expires = Math.floor(Date.now() / 1000) + 86_400;
    permissionAnswer = {
      permission: { status: 'temporary', expiration_time: expires },
      actions: [
        { action_name: 'start_call', can_perform_action: true },
        { action_name: 'send_call_permission_request', can_perform_action: false },
      ],
    };
    const live = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/whatsapp/call-permission`,
      cookies: owner.cookies,
    });
    expect(live.json()).toMatchObject({
      status: 'temporary',
      canCall: true,
      canRequest: false,
      expiresAt: new Date(expires * 1000).toISOString(),
    });
    const [contact] = await db
      .select()
      .from(waContacts)
      .where(and(eq(waContacts.phone, '5521977008888')));
    expect(contact?.callPermission).toBe('temporary');
  });
});

describe('the seller lock until the official number is live (Eric, 19/10)', () => {
  const place = (
    cookies: Record<string, string>,
    leadId: string,
    payload: unknown = { sdp: OFFER },
  ) =>
    app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/calls`,
      cookies,
      payload: payload as object,
    });
  const callCount = async () => (await db.select({ id: waCalls.id }).from(waCalls)).length;

  it('a seller gets 403 whatsapp_soon, before the body is read, and no call, contact or request to Meta exists', async () => {
    await setOfficialLive(db, false);
    const seller = await sessionFor('vendedor_expansao');
    const leadId = await deal('5521977100001', seller.id);
    const before = await callCount();
    const activities = (await activitiesOf(leadId)).length;
    for (const payload of [{ sdp: OFFER }, {}]) {
      const response = await place(seller.cookies, leadId, payload);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: 'whatsapp_soon',
        message: expect.stringContaining('Em breve'),
      });
    }
    expect(await callCount()).toBe(before);
    expect(
      await db.select().from(waContacts).where(eq(waContacts.phone, '5521977100001')),
    ).toHaveLength(0);
    expect(await activitiesOf(leadId)).toHaveLength(activities);
    expect(posts).toHaveLength(0);
    expect(fetched).toHaveLength(0);
  });

  it('a seller out of scope still gets 404, not 403, with the switch off', async () => {
    await setOfficialLive(db, false);
    const owner = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521977100002', owner.id);
    const unowned = await deal('5521977100003', null);
    const before = await callCount();
    for (const id of [leadId, unowned]) {
      const response = await place(other.cookies, id);
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('not_found');
    }
    expect(await callCount()).toBe(before);
    expect(fetched).toHaveLength(0);
  });

  it('turning the switch on lets the seller call, with the same request', async () => {
    await setOfficialLive(db, false);
    const seller = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521977100004', seller.id);
    expect((await place(seller.cookies, leadId)).statusCode).toBe(403);
    expect(posts).toHaveLength(0);
    await setOfficialLive(db, true);
    const started = await place(seller.cookies, leadId);
    expect(started.statusCode).toBe(201);
    expect(started.json<{ call: WaCall }>().call).toMatchObject({ direction: 'out', leadId });
    expect(posts).toHaveLength(1);
  });

  it('Admin Master, Diretoria and the commercial manager call with the switch off', async () => {
    await setOfficialLive(db, false);
    const owner = await sessionFor('vendedor_formatacao');
    for (const [index, role] of (
      ['admin_master', 'diretoria', 'gerente_comercial'] as const
    ).entries()) {
      const person = await sessionFor(role);
      const leadId = await deal(`552197710001${index + 5}`, owner.id);
      posts.length = 0;
      const started = await place(person.cookies, leadId);
      expect(started.statusCode, role).toBe(201);
      expect(posts, role).toHaveLength(1);
    }
  });
});

describe('"Prefiro uma ligação" on a template (Eric, 26/10)', () => {
  const send = {
    config: { token: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA },
    fetch: whatsappFetch,
  };
  async function tap(phone: string, id: string) {
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
                contacts: [{ wa_id: phone, profile: { name: 'Elena' } }],
                messages: [
                  {
                    from: phone,
                    id,
                    timestamp: unix(new Date()),
                    type: 'button',
                    button: { text: 'Prefiro uma ligação', payload: 'Prefiro uma ligação' },
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
    await processWhatsAppEvents({ db, phoneNumberId: PHONE_ID, log: () => {}, send });
  }
  const callTasks = (leadId: string) =>
    db
      .select()
      .from(leadTasks)
      .where(and(eq(leadTasks.leadId, leadId), eq(leadTasks.title, CALL_REQUEST_TASK)));

  it('gives the owner a task to call now and asks Meta for the permission once', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521977200001', owner.id);
    await tap('5521977200001', 'wamid.CALLME1');
    const [task] = await callTasks(leadId);
    expect(task).toMatchObject({ kind: 'call', assigneeEmployeeId: owner.id, auto: true });
    const requests = posts.filter((p) => p.type === 'interactive');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      to: '5521977200001',
      interactive: { type: 'call_permission_request' },
    });
    const [contact] = await db
      .select()
      .from(waContacts)
      .where(eq(waContacts.phone, '5521977200001'));
    expect(contact?.callPermission).toBe('requested');
    // A second tap the same day: no second task, no second request (Meta allows 1 a day).
    await tap('5521977200001', 'wamid.CALLME2');
    expect(await callTasks(leadId)).toHaveLength(1);
    expect(posts.filter((p) => p.type === 'interactive')).toHaveLength(1);
  });

  it('before the number is live or with calling off: the task only, nothing sent', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    await setOfficialLive(db, false);
    const first = await deal('5521977200002', owner.id);
    await tap('5521977200002', 'wamid.CALLME3');
    expect(await callTasks(first)).toHaveLength(1);
    await setOfficialLive(db, true);
    callingStatus = 'DISABLED';
    forgetCallingSettings();
    const second = await deal('5521977200003', owner.id);
    await tap('5521977200003', 'wamid.CALLME4');
    expect(await callTasks(second)).toHaveLength(1);
    expect(posts).toHaveLength(0);
  });
});
