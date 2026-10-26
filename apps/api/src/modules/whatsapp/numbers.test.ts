import { createHmac, randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type RoleKey, type WaNumbersView } from '@wings/shared';
import { eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  waContacts,
  waConversations,
  waMessages,
  waNumbers,
  waTemplates,
} from '../../db/schema/index.js';
import { loadEnv, type Env } from '../../env.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { applyWhatsAppPayload, processWhatsAppEvents } from './intake.js';
import { workNumberOf } from './numbers.js';

/**
 * Connecting a seller's WhatsApp Business number by coexistence, against a simulated Meta: the
 * code exchange, the WABA's numbers read with the business token, the subscription and the two
 * one-time syncs in order, the token sealed and never answered, and the webhook marking a number
 * that left. No test reaches the network.
 */

const KEY = randomBytes(32).toString('base64');
const APP_ID = '1579023596665415';
const APP_SECRET = 'whatsapp-app-secret-for-tests';
const VERIFY = 'whatsapp-verify-token-long-enough';
const BUSINESS_TOKEN = 'EAAG-business-token-from-signup';
const WABA = '3100000000000001';
const NUMBER = '4200000000000001';
const PORTFOLIO = '5300000000000001';
/** Made-up numbers: the official one of this test environment, and its WABA. */
const OFFICIAL_ID = '1253469287856067';
const OFFICIAL_WABA = '3100000000000099';
const OFFICIAL_PHONE = '5521977770000';
const START = new Date('2026-10-20T15:00:00Z');

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let clock = START;

type Answer = () => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cut: Answer = () => {
  throw new TypeError('fetch failed');
};

/** What the fake Graph answers next, by step, and every call it got. */
let answers: Record<string, Answer>;
const calls: { step: string; auth: string | null; url: URL; body: unknown }[] = [];
const defaults = (): Record<string, Answer> => ({
  exchange: () => json({ access_token: BUSINESS_TOKEN, token_type: 'bearer' }),
  numbers: () =>
    json({
      data: [
        {
          id: NUMBER,
          display_phone_number: '+55 21 99999-0000',
          verified_name: 'Vendedor Teste',
          is_on_biz_app: true,
          platform_type: 'CLOUD_API',
        },
      ],
    }),
  owner: () => json({ owner_business_info: { id: PORTFOLIO, name: 'Wings' }, id: WABA }),
  subscribe: () => json({ success: true }),
  sync: () => json({ request_id: `req-${calls.filter((c) => c.step === 'sync').length}` }),
});

const metaFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const auth = new Headers(init?.headers).get('authorization');
  const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
  const step = url.pathname.endsWith('/oauth/access_token')
    ? 'exchange'
    : url.pathname.endsWith(`/${WABA}/phone_numbers`)
      ? 'numbers'
      : url.pathname.endsWith(`/${WABA}/subscribed_apps`)
        ? 'subscribe'
        : url.pathname.endsWith(`/${NUMBER}/smb_app_data`)
          ? 'sync'
          : url.pathname.endsWith(`/${WABA}`)
            ? 'owner'
            : 'unknown';
  calls.push({ step, auth, url, body });
  const answer = answers[step];
  return answer ? answer() : json({ error: { code: 100, message: 'unknown path' } }, 400);
}) as typeof fetch;

const baseEnv = (extra: Record<string, string> = {}): Env =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY,
    WHATSAPP_APP_ID: APP_ID,
    // The env number is the official one; the work numbers are other ids.
    WHATSAPP_PHONE_NUMBER_ID: OFFICIAL_ID,
    WHATSAPP_WABA_ID: OFFICIAL_WABA,
    WINGS_WHATSAPP_NUMBER: OFFICIAL_PHONE,
    ...extra,
  });

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: baseEnv({ INTEGRATIONS_ENCRYPTION_KEY: KEY, WHATSAPP_ES_CONFIG_ID: '987654321' }),
    db,
    now: () => clock,
    whatsappFetch: metaFetch,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(async () => {
  answers = defaults();
  calls.length = 0;
  clock = START;
  // A work number's chats go first: they point at the number.
  const chats = db
    .select({ id: waConversations.id })
    .from(waConversations)
    .where(isNotNull(waConversations.numberId));
  await db.delete(waMessages).where(inArray(waMessages.conversationId, chats));
  await db.delete(waConversations).where(isNotNull(waConversations.numberId));
  await db.delete(waNumbers);
});

async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'diretoria' || role === 'admin_master' ? 'diretoria' : 'comercial',
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

const connect = (
  cookies: Record<string, string>,
  payload: Record<string, unknown>,
  target: FastifyInstance = app,
) => target.inject({ method: 'POST', url: '/whatsapp/numbers/connect', cookies, payload });

describe('the work numbers', () => {
  let admin: Awaited<ReturnType<typeof sessionFor>>;
  let seller: Awaited<ReturnType<typeof sessionFor>>;
  let numberId = '';
  beforeAll(async () => {
    admin = await sessionFor('admin_master');
    seller = await sessionFor('vendedor_expansao');
  });
  const register = (extra: Record<string, unknown> = {}, cookies = admin.cookies) =>
    app.inject({
      method: 'POST',
      url: '/whatsapp/numbers',
      cookies,
      payload: {
        phone: '(21) 99999-0000',
        label: 'Comercial teste',
        ownerEmployeeId: seller.id,
        sector: 'comercial',
        ...extra,
      },
    });
  beforeEach(async () => {
    numberId = (await register()).json<{ number: { id: string } }>().number.id;
  });
  const payload = (extra: Record<string, unknown> = {}) => ({
    code: 'code-from-embedded-signup',
    wabaId: WABA,
    numberId,
    ...extra,
  });

  it('shows the signup config to an Admin Master and refuses everyone else', async () => {
    const view = await app.inject({
      method: 'GET',
      url: '/whatsapp/numbers',
      cookies: admin.cookies,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json<WaNumbersView>()).toMatchObject({
      signup: { appId: APP_ID, configId: '987654321', graphVersion: 'v23.0' },
      missing: [],
      numbers: [{ status: 'registered', phone: '5521999990000', phoneNumberId: null }],
    });
    expect(view.json<WaNumbersView>().people.map((p) => p.id)).toContain(seller.id);
    for (const role of ['vendedor_expansao', 'gerente_comercial', 'diretoria'] as const) {
      const other = await sessionFor(role);
      const read = await app.inject({
        method: 'GET',
        url: '/whatsapp/numbers',
        cookies: other.cookies,
      });
      expect(read.statusCode).toBe(403);
      expect((await connect(other.cookies, payload())).statusCode).toBe(403);
      expect((await register({ phone: '21988880000' }, other.cookies)).statusCode).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('connects: code → token, the number read with it, subscription, contacts then history', async () => {
    const res = await connect(admin.cookies, payload());
    expect(res.statusCode).toBe(200);
    expect(calls.map((c) => c.step)).toEqual([
      'exchange',
      'numbers',
      'owner',
      'subscribe',
      'sync',
      'sync',
    ]);
    const exchange = calls[0]!;
    expect(exchange.auth).toBeNull();
    expect(exchange.url.searchParams.get('client_id')).toBe(APP_ID);
    expect(exchange.url.searchParams.get('client_secret')).toBe(APP_SECRET);
    expect(exchange.url.searchParams.get('code')).toBe('code-from-embedded-signup');
    for (const call of calls.slice(1)) {
      expect(call.auth).toBe(`Bearer ${BUSINESS_TOKEN}`);
      expect(call.url.searchParams.has('access_token')).toBe(false);
    }
    expect(calls[4]!.body).toEqual({
      messaging_product: 'whatsapp',
      sync_type: 'smb_app_state_sync',
    });
    expect(calls[5]!.body).toEqual({ messaging_product: 'whatsapp', sync_type: 'history' });

    expect(res.body).not.toContain(BUSINESS_TOKEN);
    const answer = res.json<{ number: WaNumbersView['numbers'][number]; steps: unknown }>();
    expect(answer.steps).toEqual({ webhooks: 'ok', contacts: 'requested', history: 'requested' });
    expect(answer.number).toMatchObject({
      phoneNumberId: NUMBER,
      wabaId: WABA,
      businessId: PORTFOLIO,
      displayPhone: '+55 21 99999-0000',
      ownerEmployeeId: seller.id,
      status: 'connected',
      webhooksSubscribed: true,
      contactsSync: 'requested',
      historySync: 'requested',
      historyProgress: null,
      syncDeadline: '2026-10-21T15:00:00.000Z',
      // Meta gave no end for this token.
      tokenExpiresAt: null,
    });

    const [row] = await db.select().from(waNumbers);
    expect(row!.tokenEnc).not.toContain(BUSINESS_TOKEN);
    expect(createSecretBox(KEY).open(row!.tokenEnc!)).toBe(BUSINESS_TOKEN);
    expect(row!.contactsSyncRequest).toBe('req-1');
    expect(row!.historySyncRequest).toBe('req-2');

    const audit = await db.query.auditLog.findFirst({
      where: eq(auditLog.action, 'whatsapp.number_connected'),
    });
    expect(audit?.entityId).toBe(row!.id);
    expect(JSON.stringify(audit?.metadata)).not.toContain(BUSINESS_TOKEN);
    expect(JSON.stringify(audit?.metadata)).not.toContain('99999');

    const listed = await app.inject({
      method: 'GET',
      url: '/whatsapp/numbers',
      cookies: admin.cookies,
    });
    expect(listed.body).not.toContain(BUSINESS_TOKEN);
    expect(listed.json<WaNumbersView>().numbers).toHaveLength(1);
  });

  it('saves nothing when Meta refuses the code, or the number is not the WABA’s', async () => {
    answers.exchange = () => json({ error: { code: 100, message: 'expired code' } }, 400);
    const refused = await connect(admin.cookies, payload());
    expect(refused.statusCode).toBe(502);
    expect(refused.json()).toMatchObject({ error: 'code_refused', metaCode: 100 });

    answers = defaults();
    const other = await connect(admin.cookies, payload({ phoneNumberId: '4299999999999999' }));
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: 'number_not_found' });

    answers.numbers = () =>
      json({ data: [{ id: NUMBER, is_on_biz_app: false, platform_type: 'CLOUD_API' }] });
    const notApp = await connect(admin.cookies, payload());
    expect(notApp.json()).toMatchObject({ error: 'not_business_app' });

    answers.numbers = () => json({ data: [{ id: NUMBER }, { id: '4200000000000002' }] });
    const two = await connect(admin.cookies, payload());
    expect(two.json()).toMatchObject({ error: 'number_ambiguous' });

    const [row] = await db.select().from(waNumbers);
    expect(row).toMatchObject({ status: 'registered', phoneNumberId: null, tokenEnc: null });
    expect(calls.some((c) => c.step === 'subscribe' || c.step === 'sync')).toBe(false);
  });

  it('refuses an owner who is not active, at the registry and before calling Meta', async () => {
    const gone = await createEmployee(db, { role: 'vendedor_expansao', status: 'inactive' });
    const refused = await register({ phone: '21988880000', ownerEmployeeId: gone.id });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'owner_invalid' });
    // Any active person may own one (Diretoria, the Admin), not only a seller.
    expect((await register({ phone: '21988880001', ownerEmployeeId: admin.id })).statusCode).toBe(
      201,
    );
    await db.update(waNumbers).set({ ownerEmployeeId: gone.id }).where(eq(waNumbers.id, numberId));
    const res = await connect(admin.cookies, payload());
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'owner_invalid' });
    expect(calls).toHaveLength(0);
  });

  it('never takes the official number as a work number', async () => {
    const typed = await register({ phone: '(21) 97777-0000' });
    expect(typed.statusCode).toBe(409);
    expect(typed.json()).toMatchObject({ error: 'official_number' });
    const edited = await app.inject({
      method: 'PATCH',
      url: `/whatsapp/numbers/${numberId}`,
      cookies: admin.cookies,
      payload: { phone: '21977770000' },
    });
    expect(edited.json()).toMatchObject({ error: 'official_number' });
    // The official WABA is refused before the code is spent.
    const byWaba = await connect(admin.cookies, payload({ wabaId: OFFICIAL_WABA }));
    expect(byWaba.json()).toMatchObject({ error: 'official_number' });
    expect(calls).toHaveLength(0);
    // Meta shows the official number's id, or its phone, inside another WABA.
    answers.numbers = () =>
      json({ data: [{ id: OFFICIAL_ID, display_phone_number: '+55 21 99999-0000' }] });
    expect((await connect(admin.cookies, payload())).json()).toMatchObject({
      error: 'official_number',
    });
    answers.numbers = () =>
      json({ data: [{ id: NUMBER, display_phone_number: '+55 21 97777-0000' }] });
    expect((await connect(admin.cookies, payload())).json()).toMatchObject({
      error: 'official_number',
    });
    const [row] = await db.select().from(waNumbers);
    expect(row).toMatchObject({ status: 'registered', tokenEnc: null });
    // And a change that names it is never read as a work number's, whatever a row says.
    await db
      .update(waNumbers)
      .set({ phoneNumberId: OFFICIAL_ID, wabaId: WABA })
      .where(eq(waNumbers.id, numberId));
    expect(
      await workNumberOf(db, { phoneNumberId: OFFICIAL_ID, wabaId: WABA } as never, {
        phoneNumberId: OFFICIAL_ID,
        wabaId: OFFICIAL_WABA,
      }),
    ).toBeNull();
  });

  it('takes only the registered number from Meta’s window', async () => {
    answers.numbers = () =>
      json({ data: [{ id: NUMBER, display_phone_number: '+55 21 98888-1111' }] });
    const other = await connect(admin.cookies, payload());
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ error: 'number_mismatch' });
    expect(calls.some((c) => c.step === 'subscribe')).toBe(false);
  });

  it('keeps the token’s end and the registry’s fields; the number is locked once connected', async () => {
    answers.exchange = () => json({ access_token: BUSINESS_TOKEN, expires_in: 5_184_000 });
    const res = await connect(admin.cookies, payload());
    expect(res.json<{ number: { tokenExpiresAt: string } }>().number.tokenExpiresAt).toBe(
      '2026-12-19T15:00:00.000Z',
    );
    const patched = await app.inject({
      method: 'PATCH',
      url: `/whatsapp/numbers/${numberId}`,
      cookies: admin.cookies,
      payload: {
        eligibility: 'confirmado',
        eligibilityNotes: 'App 2.24.20 no celular.',
        checks: ['app', 'work'],
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      number: {
        eligibility: 'confirmado',
        checks: ['app', 'work'],
        label: 'Comercial teste',
        sector: 'comercial',
        status: 'connected',
      },
    });
    const locked = await app.inject({
      method: 'PATCH',
      url: `/whatsapp/numbers/${numberId}`,
      cookies: admin.cookies,
      payload: { phone: '21988887777' },
    });
    expect(locked.json()).toMatchObject({ error: 'phone_locked' });
    const twice = await register();
    expect(twice.json()).toMatchObject({ error: 'phone_taken' });
    const audit = await db.query.auditLog.findFirst({
      where: eq(auditLog.action, 'whatsapp.number_updated'),
    });
    expect(audit?.metadata).toEqual({ fields: ['checks', 'eligibility', 'eligibilityNotes'] });
    expect(JSON.stringify(audit?.metadata)).not.toContain('2.24');
  });

  it('does not ask for the syncs before the subscription went through; "Tentar de novo" does', async () => {
    answers.subscribe = () => json({ error: { code: 200, message: 'no permission' } }, 403);
    const first = await connect(admin.cookies, payload());
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      steps: { webhooks: 'failed', contacts: 'skipped', history: 'skipped' },
      number: { webhooksSubscribed: false, contactsSync: null, historySync: null },
    });
    expect(calls.some((c) => c.step === 'sync')).toBe(false);

    answers.subscribe = defaults().subscribe!;
    calls.length = 0;
    const id = first.json<{ number: { id: string } }>().number.id;
    const retry = await app.inject({
      method: 'POST',
      url: `/whatsapp/numbers/${id}/retry`,
      cookies: admin.cookies,
    });
    expect(retry.statusCode).toBe(200);
    expect(calls.map((c) => c.step)).toEqual(['subscribe', 'sync', 'sync']);
    expect(retry.json()).toMatchObject({
      steps: { webhooks: 'ok', contacts: 'requested', history: 'requested' },
    });
  });

  it('never sends again a sync Meta did not answer, and stops at the 24 hours', async () => {
    answers.sync = cut;
    const first = await connect(admin.cookies, payload());
    expect(first.json()).toMatchObject({
      steps: { contacts: 'unknown', history: 'skipped' },
      number: { contactsSync: 'unknown', historySync: null },
    });
    const id = first.json<{ number: { id: string } }>().number.id;

    // Meta refuses the history this time: it stays owed.
    answers.sync = () => json({ error: { code: 100, message: 'refused' } }, 400);
    calls.length = 0;
    const retry = await app.inject({
      method: 'POST',
      url: `/whatsapp/numbers/${id}/retry`,
      cookies: admin.cookies,
    });
    expect(
      calls.map((c) => [c.step, (c.body as { sync_type?: string } | null)?.sync_type]),
    ).toEqual([['sync', 'history']]);
    expect(retry.json()).toMatchObject({ steps: { contacts: 'unknown', history: 'failed' } });

    clock = new Date(START.getTime() + 24 * 3_600_000 + 1);
    // A new login: the first one expired with the clock.
    const later = await sessionFor('admin_master');
    const late = await app.inject({
      method: 'POST',
      url: `/whatsapp/numbers/${id}/retry`,
      cookies: later.cookies,
    });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: 'sync_expired' });
  });

  it('connecting the same number again replaces its token and starts its 24 hours anew', async () => {
    await connect(admin.cookies, payload());
    clock = new Date(START.getTime() + 3 * 86_400_000);
    const later = await sessionFor('admin_master');
    answers.exchange = () => json({ access_token: 'EAAG-second-token' });
    const again = await connect(later.cookies, payload({ phoneNumberId: NUMBER }));
    expect(again.statusCode).toBe(200);
    const rows = await db.select().from(waNumbers);
    expect(rows).toHaveLength(1);
    expect(createSecretBox(KEY).open(rows[0]!.tokenEnc!)).toBe('EAAG-second-token');
    expect(rows[0]!.connectedAt!.toISOString()).toBe(clock.toISOString());
    expect(rows[0]!.contactsSyncRequest).toBe('req-3');
    expect(rows[0]!.phone).toBe('5521999990000');
  });

  it('the webhook marks a number that left, and how far its history is', async () => {
    await connect(admin.cookies, payload());
    const deliver = (body: unknown) => {
      const raw = JSON.stringify(body);
      return app.inject({
        method: 'POST',
        url: '/integrations/whatsapp/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
        },
        payload: raw,
      });
    };
    const entry = (field: string, value: unknown) => ({
      object: 'whatsapp_business_account',
      entry: [{ id: WABA, changes: [{ field, value }] }],
    });
    const history = (progress: number) =>
      entry('history', {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '5521999990000', phone_number_id: NUMBER },
        history: [{ metadata: { phase: 0, chunk_order: 1, progress }, threads: [] }],
      });
    expect((await deliver(history(40))).statusCode).toBe(200);
    expect((await deliver(history(25))).statusCode).toBe(200);
    await deliver(
      entry('account_update', {
        event: 'PARTNER_REMOVED',
        disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
      }),
    );
    // Another WABA's account_update is not ours.
    await deliver({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '3199999999999999',
          changes: [{ field: 'account_update', value: { event: 'ACCOUNT_OFFBOARDED' } }],
        },
      ],
    });
    await processWhatsAppEvents({
      db,
      phoneNumberId: OFFICIAL_ID,
      log: () => {},
      now: () => clock,
    });

    const [row] = await db.select().from(waNumbers);
    expect(row).toMatchObject({
      historyProgress: 40,
      status: 'disconnected',
      disconnectReason: 'PARTNER_REMOVED: PRIMARY_INACTIVITY',
    });
    const retry = await app.inject({
      method: 'POST',
      url: `/whatsapp/numbers/${row!.id}/retry`,
      cookies: admin.cookies,
    });
    expect(retry.statusCode).toBe(404);
  });

  it('brings the number’s messages in as its own chat, never Sofia’s; its templates stay out', async () => {
    await connect(admin.cookies, payload());
    await db
      .insert(waTemplates)
      .values({ name: 'boas_vindas', language: 'pt_BR', status: 'APPROVED', category: 'MARKETING' })
      .onConflictDoNothing();
    const bodies = [
      {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '5521999990000', phone_number_id: NUMBER },
                  contacts: [{ wa_id: '5521988887777', profile: { name: 'Cliente' } }],
                  messages: [
                    {
                      id: 'wamid.SELLER1',
                      from: '5521988887777',
                      timestamp: '1792508400',
                      type: 'text',
                      text: { body: 'oi' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA,
            changes: [
              {
                field: 'message_template_status_update',
                value: {
                  event: 'REJECTED',
                  message_template_name: 'boas_vindas',
                  message_template_language: 'pt_BR',
                },
              },
            ],
          },
        ],
      },
    ];
    for (const body of bodies)
      await applyWhatsAppPayload(
        { db, phoneNumberId: null, log: () => {}, now: () => clock },
        body,
      );
    const [message] = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.wamid, `${numberId}:wamid.SELLER1`));
    expect(message).toMatchObject({ direction: 'in', author: 'contact', text: 'oi' });
    const [chat] = await db
      .select()
      .from(waConversations)
      .where(eq(waConversations.id, message!.conversationId));
    expect(chat).toMatchObject({ numberId, attendance: 'with_person', sofiaDueAt: null });
    // The official number's 24-hour window is not opened by a message to a work number.
    const [contact] = await db
      .select()
      .from(waContacts)
      .where(eq(waContacts.phone, '5521988887777'));
    expect(contact?.lastInboundAt).toBeNull();
    const [template] = await db
      .select()
      .from(waTemplates)
      .where(eq(waTemplates.name, 'boas_vindas'));
    expect(template?.status).toBe('APPROVED');
  });

  it('runs one connection at a time per number', async () => {
    answers.subscribe = () => json({ error: { code: 200, message: 'no permission' } }, 403);
    const first = await connect(admin.cookies, payload());
    const id = first.json<{ number: { id: string } }>().number.id;
    let release: () => void = () => {};
    answers.subscribe = () =>
      new Promise<Response>((resolve) => (release = () => resolve(json({ success: true }))));
    const retry = () =>
      app.inject({ method: 'POST', url: `/whatsapp/numbers/${id}/retry`, cookies: admin.cookies });
    const slow = retry();
    await vi.waitFor(() => expect(calls.filter((c) => c.step === 'subscribe')).toHaveLength(2));
    const busy = await retry();
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: 'busy' });
    release();
    expect((await slow).json()).toMatchObject({
      steps: { webhooks: 'ok', contacts: 'requested', history: 'requested' },
    });
    expect(calls.filter((c) => c.step === 'sync')).toHaveLength(2);
  });

  it('after the 24 hours still subscribes, but asks for no sync', async () => {
    answers.subscribe = () => json({ error: { code: 200, message: 'no permission' } }, 403);
    const first = await connect(admin.cookies, payload());
    const id = first.json<{ number: { id: string } }>().number.id;
    answers.subscribe = defaults().subscribe!;
    clock = new Date(START.getTime() + 2 * 86_400_000);
    const later = await sessionFor('admin_master');
    calls.length = 0;
    const retry = () =>
      app.inject({ method: 'POST', url: `/whatsapp/numbers/${id}/retry`, cookies: later.cookies });
    const subscribed = await retry();
    expect(subscribed.statusCode).toBe(200);
    expect(calls.map((c) => c.step)).toEqual(['subscribe']);
    expect(subscribed.json()).toMatchObject({
      steps: { webhooks: 'ok', contacts: 'skipped', history: 'skipped' },
      number: { webhooksSubscribed: true, contactsSync: null },
    });
    expect((await retry()).json()).toMatchObject({ error: 'sync_expired' });
  });

  it('answers 503 with the missing names while Embedded Signup is not configured', async () => {
    const bare = await buildApp({ env: baseEnv(), db, now: () => clock, whatsappFetch: metaFetch });
    try {
      const view = await bare.inject({
        method: 'GET',
        url: '/whatsapp/numbers',
        cookies: admin.cookies,
      });
      expect(view.json<WaNumbersView>()).toMatchObject({
        signup: null,
        missing: ['WHATSAPP_ES_CONFIG_ID', 'INTEGRATIONS_ENCRYPTION_KEY'],
      });
      const res = await connect(admin.cookies, payload(), bare);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'signup_not_configured' });
      expect(calls).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });
});
