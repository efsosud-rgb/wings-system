import { createHmac } from 'node:crypto';
import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type DealWhatsApp,
  type RoleKey,
  type WaConversationItem,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  leadTrackingLinks,
  leads,
  sessions,
  waContacts,
  waConversations,
  waMessages,
  waTemplates,
  waWebhookEvents,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { processWhatsAppEvents, purgeWhatsAppPayloads } from './intake.js';

/**
 * The official WhatsApp in the CRM, against a simulated Meta: the webhook
 * (handshake, signature, re-sends), messages landing on the deal of the
 * phone, statuses only moving forward, the 24-hour window, templates, files,
 * and the access rule (Admin and Diretoria every lead, a seller only their
 * own). No test reaches the network.
 */

const APP_SECRET = 'whatsapp-app-secret-for-tests';
const VERIFY = 'whatsapp-verify-token-long-enough';
const TOKEN = 'fake-whatsapp-token';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';
const NOW = new Date('2026-10-07T15:00:00Z');
const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

/** What the fake Graph API answers next to a send (`queue`), and every call it got. */
const sends: { to: string; body: Record<string, unknown> }[] = [];
let nextSend: () => Response | Promise<Response> = () => accepted('wamid.OUT1');
let templatesAnswer: unknown[] = [];
const calls: { url: string; auth: string | null }[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const accepted = (wamid: string, waId = '552199990001') =>
  json({
    messaging_product: 'whatsapp',
    contacts: [{ input: 'x', wa_id: waId }],
    messages: [{ id: wamid }],
  });

const whatsappFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const auth = new Headers(init?.headers).get('authorization');
  calls.push({ url: url.href, auth });
  expect(url.searchParams.has('access_token')).toBe(false);
  if (url.hostname === 'lookaside.fbsbx.com') return new Response('PNGDATA', { status: 200 });
  expect(auth).toBe(`Bearer ${TOKEN}`);
  if (url.pathname.endsWith(`/${PHONE_ID}/messages`)) {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sends.push({ to: String(body.to), body });
    return nextSend();
  }
  if (url.pathname.endsWith(`/${WABA}/message_templates`)) return json({ data: templatesAnswer });
  if (url.pathname.endsWith('/media-img'))
    return json({
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
      mime_type: 'image/jpeg',
      file_size: 7,
    });
  if (url.pathname.endsWith('/media-html'))
    return json({
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=2',
      mime_type: 'text/html',
      file_size: 7,
    });
  if (url.pathname.endsWith('/media-evil'))
    return json({ url: 'https://evil.example/steal', mime_type: 'image/jpeg', file_size: 7 });
  return json({ error: { code: 100, message: 'unknown path' } }, 400);
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
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY,
      WHATSAPP_ACCESS_TOKEN: TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
      WHATSAPP_WABA_ID: WABA,
    }),
    db,
    now: () => NOW,
    whatsappFetch,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(() => {
  sends.length = 0;
  calls.length = 0;
  nextSend = () => accepted('wamid.OUT1');
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

async function deal(
  phone: string | null,
  ownerId: string | null,
  extra: Partial<typeof leads.$inferInsert> = {},
) {
  const [row] = await db
    .insert(leads)
    .values({
      source: 'manual',
      name: 'Elena Prado',
      phone,
      ownerEmployeeId: ownerId,
      pipeline: 'formatacao',
      ...extra,
    })
    .returning({ id: leads.id });
  return row!.id;
}

const sign = (body: string) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
const deliver = (body: string, signature: string | null = sign(body)) =>
  app.inject({
    method: 'POST',
    url: '/integrations/whatsapp/webhook',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    payload: body,
  });
const run = () =>
  processWhatsAppEvents({ db, phoneNumberId: PHONE_ID, log: () => {}, now: () => NOW });

let seq = 0;
/** Meta's published shape of an incoming text message. */
function inbound(
  from: string,
  text: string,
  opts: { id?: string; at?: Date; name?: string; phoneId?: string } = {},
) {
  const id = opts.id ?? `wamid.IN${++seq}`;
  return {
    id,
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15556696643',
                  phone_number_id: opts.phoneId ?? PHONE_ID,
                },
                contacts: [{ profile: { name: opts.name ?? 'Elena' }, wa_id: from }],
                messages: [
                  {
                    from,
                    id,
                    timestamp: unix(opts.at ?? new Date(NOW.getTime() - 3_600_000)),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  };
}
function statusBody(
  wamid: string,
  status: string,
  at: Date,
  error?: { code: number; title: string },
) {
  return JSON.stringify({
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
                  id: wamid,
                  status,
                  timestamp: unix(at),
                  recipient_id: '552199990001',
                  ...(error ? { errors: [error] } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe('the webhook handshake and signature', () => {
  it('echoes the challenge only for our verify token', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4242`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('4242');
    const bad = await app.inject({
      method: 'GET',
      url: '/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong-token-xxxxxxxx&hub.challenge=1',
    });
    expect(bad.statusCode).toBe(403);
  });

  it('refuses an unsigned or tampered body and stores nothing', async () => {
    const { body } = inbound('5521999990001', 'oi');
    expect((await deliver(body, null)).statusCode).toBe(401);
    expect((await deliver(body, sign('{"other":1}'))).statusCode).toBe(401);
    expect(await db.select().from(waWebhookEvents)).toHaveLength(0);
  });

  it('stores a signed body and answers at once', async () => {
    const { body } = inbound('5521911110000', 'oi');
    const response = await deliver(body);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: 1 });
    await run();
  });
});

describe('incoming messages', () => {
  it('land on the open deal of the phone, even without the 9th digit, once', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521999990001', owner.id);
    await deal('5521999990001', owner.id, { won: false, closedAt: new Date('2026-09-01') });
    // Meta's wa_id of an old Brazilian mobile lacks the 9: 55 21 9999 0001.
    const message = inbound('552199990001', 'Olá, quero saber da franquia');
    await deliver(message.body);
    await deliver(message.body); // Meta re-sends
    await run();
    const rows = await db.select().from(waMessages).where(eq(waMessages.wamid, message.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      leadId,
      direction: 'in',
      author: 'contact',
      kind: 'text',
      text: 'Olá, quero saber da franquia',
    });

    const thread = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/whatsapp`,
      cookies: owner.cookies,
    });
    expect(thread.statusCode).toBe(200);
    const data = thread.json<DealWhatsApp>();
    expect(data).toMatchObject({
      configured: true,
      calling: false,
      profileName: 'Elena',
      optedOut: false,
    });
    expect(data.window.open).toBe(true);
    expect(data.messages.map((m) => m.text)).toEqual(['Olá, quero saber da franquia']);
    const [contact] = await db
      .select()
      .from(waContacts)
      .where(eq(waContacts.phone, '5521999990001'));
    expect(contact?.waId).toBe('552199990001');
  });

  it('skips a change for another number of the same app', async () => {
    const message = inbound('5521933330000', 'oi', { phoneId: '999' });
    await deliver(message.body);
    await run();
    expect(await db.select().from(waMessages).where(eq(waMessages.wamid, message.id))).toHaveLength(
      0,
    );
  });

  it('waits with no deal, for a full-scope reader only, and moves to the deal made later', async () => {
    const admin = await sessionFor('admin_master');
    const seller = await sessionFor('vendedor_formatacao');
    const message = inbound('5521944440000', 'Oi, vi o anúncio');
    await deliver(message.body);
    await run();
    const inbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      cookies: admin.cookies,
    });
    const waiting = inbox
      .json<{ conversations: WaConversationItem[] }>()
      .conversations.find((c) => c.phone === '5521944440000');
    expect(waiting).toMatchObject({
      leadId: null,
      unanswered: true,
      windowOpen: true,
      preview: 'Oi, vi o anúncio',
    });

    const sellerInbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      cookies: seller.cookies,
    });
    expect(
      sellerInbox
        .json<{ conversations: WaConversationItem[] }>()
        .conversations.some((c) => c.phone === '5521944440000'),
    ).toBe(false);
    const sellerOpen = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${waiting!.conversationId}`,
      cookies: seller.cookies,
    });
    expect(sellerOpen.statusCode).toBe(404);
    const adminOpen = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${waiting!.conversationId}`,
      cookies: admin.cookies,
    });
    expect(adminOpen.json<DealWhatsApp>().messages).toHaveLength(1);

    // Someone makes the deal by hand with that phone: the messages go to it.
    const leadId = await deal('5521944440000', admin.id);
    const thread = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/whatsapp`,
      cookies: admin.cookies,
    });
    expect(thread.json<DealWhatsApp>().messages.map((m) => m.text)).toEqual(['Oi, vi o anúncio']);
    const left = await db
      .select()
      .from(waConversations)
      .where(eq(waConversations.id, waiting!.conversationId));
    expect(left[0]?.leadId).toBe(leadId);
  });

  it('makes the lead from a tracking code, as the Z-API door does', async () => {
    const code = 'WHTS23';
    await db
      .insert(leadTrackingLinks)
      .values({ clientId: WINGS_CLIENT_ID, channel: 'linktree', code, phone: '5521999470288' });
    const message = inbound('5541988887777', `${code} Olá! Quero saber mais`);
    await deliver(message.body);
    await run();
    const [lead] = await db.select().from(leads).where(eq(leads.phone, '5541988887777'));
    expect(lead).toMatchObject({ source: 'whatsapp_link' });
    const [row] = await db.select().from(waMessages).where(eq(waMessages.wamid, message.id));
    expect(row?.leadId).toBe(lead!.id);
    const [conversation] = await db
      .select()
      .from(waConversations)
      .where(eq(waConversations.id, row!.conversationId));
    expect(conversation?.originCode).toBe(code);
  });
});

describe('sending', () => {
  it('sends free text inside the window, once, and records who sent it', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521955550000', owner.id);
    await deliver(inbound('5521955550000', 'Oi').body);
    await run();
    const response = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/text`,
      cookies: owner.cookies,
      payload: { text: 'Olá Elena, aqui é da Wings.' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().message).toMatchObject({
      direction: 'out',
      status: 'sent',
      text: 'Olá Elena, aqui é da Wings.',
      authorName: 'Funcionário de Teste',
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body).toMatchObject({
      messaging_product: 'whatsapp',
      to: '5521955550000',
      type: 'text',
      text: { body: 'Olá Elena, aqui é da Wings.', preview_url: false },
    });
    const [row] = await db.select().from(waMessages).where(eq(waMessages.wamid, 'wamid.OUT1'));
    expect(row).toMatchObject({ leadId, employeeId: owner.id, status: 'sent' });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'whatsapp.message_sent'));
    expect(audit?.metadata).toMatchObject({ kind: 'text', outcome: 'sent' });
    expect(JSON.stringify(audit?.metadata)).not.toContain('Elena');
  });

  it('refuses free text outside the 24 hours without calling Meta', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521966660000', owner.id);
    await deliver(
      inbound('5521966660000', 'Oi', { at: new Date(NOW.getTime() - 25 * 3_600_000) }).body,
    );
    await run();
    const response = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/text`,
      cookies: owner.cookies,
      payload: { text: 'Oi' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('window_closed');
    const never = await deal('5521966661111', owner.id);
    const first = await app.inject({
      method: 'POST',
      url: `/leads/${never}/whatsapp/text`,
      cookies: owner.cookies,
      payload: { text: 'Oi' },
    });
    expect(first.statusCode).toBe(409);
    expect(sends).toHaveLength(0);
  });

  it('keeps a refused send with the reason, and an unanswered one as unknown, never retried', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521977770000', owner.id);
    await deliver(inbound('5521977770000', 'Oi').body);
    await run();
    nextSend = () =>
      json({ error: { code: 131026, type: 'OAuthException', message: 'undeliverable' } }, 400);
    const refused = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/text`,
      cookies: owner.cookies,
      payload: { text: 'Um' },
    });
    expect(refused.json().message).toMatchObject({ status: 'failed' });
    expect(refused.json().message.error).toContain('Não entregue');
    nextSend = () => Promise.reject(new Error('socket hang up'));
    const lost = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/text`,
      cookies: owner.cookies,
      payload: { text: 'Dois' },
    });
    expect(lost.json().message).toMatchObject({ status: 'pending' });
    expect(lost.json().message.error).toContain('pode ter ido ou não');
    expect(sends).toHaveLength(2);
  });

  it('sends an approved template outside the window, with its fields, and refuses a wrong one', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521988880000', owner.id);
    templatesAnswer = [
      {
        id: 't1',
        name: 'retomar_conversa',
        language: 'pt_BR',
        status: 'APPROVED',
        category: 'UTILITY',
        components: [
          { type: 'BODY', text: 'Olá {{1}}, aqui é {{2}} da Wings. Podemos continuar?' },
        ],
      },
      {
        id: 't2',
        name: 'promo',
        language: 'pt_BR',
        status: 'REJECTED',
        category: 'MARKETING',
        components: [],
      },
    ];
    const listed = await app.inject({
      method: 'GET',
      url: '/whatsapp/templates?refresh=1',
      cookies: owner.cookies,
    });
    expect(listed.json().templates).toEqual([
      {
        name: 'retomar_conversa',
        language: 'pt_BR',
        category: 'UTILITY',
        body: 'Olá {{1}}, aqui é {{2}} da Wings. Podemos continuar?',
        paramCount: 2,
        artVersion: false,
      },
    ]);
    const wrong = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/template`,
      cookies: owner.cookies,
      payload: { name: 'retomar_conversa', language: 'pt_BR', params: ['Elena'] },
    });
    expect(wrong.statusCode).toBe(422);
    const rejected = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/template`,
      cookies: owner.cookies,
      payload: { name: 'promo', language: 'pt_BR', params: [] },
    });
    expect(rejected.statusCode).toBe(422);
    nextSend = () => accepted('wamid.TPL1');
    const sent = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/template`,
      cookies: owner.cookies,
      payload: { name: 'retomar_conversa', language: 'pt_BR', params: ['Elena', 'Thais'] },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().message).toMatchObject({
      kind: 'template',
      text: 'Olá Elena, aqui é Thais da Wings. Podemos continuar?',
      template: { name: 'retomar_conversa', language: 'pt_BR' },
    });
    expect(sends.at(-1)!.body).toMatchObject({
      type: 'template',
      template: {
        name: 'retomar_conversa',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Elena' },
              { type: 'text', text: 'Thais' },
            ],
          },
        ],
      },
    });
  });

  it('blocks templates to a person who asked to stop, until they write again', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521912120000', owner.id);
    await deliver(inbound('5521912120000', 'SAIR').body);
    await run();
    const blocked = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/template`,
      cookies: owner.cookies,
      payload: { name: 'retomar_conversa', language: 'pt_BR', params: ['a', 'b'] },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('opted_out');
    await deliver(inbound('5521912120000', 'Pensei melhor, me liga').body);
    await run();
    const thread = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/whatsapp`,
      cookies: owner.cookies,
    });
    expect(thread.json<DealWhatsApp>().optedOut).toBe(false);
  });
});

describe('statuses', () => {
  it('only move forward, keep the failure code, and fill a late time', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521913130000', owner.id);
    await deliver(inbound('5521913130000', 'Oi').body);
    await run();
    nextSend = () => accepted('wamid.ST1');
    await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/text`,
      cookies: owner.cookies,
      payload: { text: 'Um' },
    });
    const t = (min: number) => new Date(NOW.getTime() + min * 60_000);
    await deliver(statusBody('wamid.ST1', 'read', t(3)));
    await deliver(statusBody('wamid.ST1', 'delivered', t(2))); // late
    await deliver(
      statusBody('wamid.ST1', 'failed', t(4), { code: 131026, title: 'Message undeliverable' }),
    );
    await run();
    const [row] = await db.select().from(waMessages).where(eq(waMessages.wamid, 'wamid.ST1'));
    expect(row).toMatchObject({ status: 'read', errorCode: null });
    expect(row?.deliveredAt?.toISOString()).toBe(t(2).toISOString());

    nextSend = () => accepted('wamid.ST2');
    await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/text`,
      cookies: owner.cookies,
      payload: { text: 'Dois' },
    });
    await deliver(
      statusBody('wamid.ST2', 'failed', t(5), { code: 131047, title: 'Re-engagement message' }),
    );
    await run();
    const [failed] = await db.select().from(waMessages).where(eq(waMessages.wamid, 'wamid.ST2'));
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 131047,
      errorTitle: 'Re-engagement message',
    });
  });
});

describe('who may see, send and open files', () => {
  it('a seller only on their own leads; Diretoria on any lead, sending too', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const diretoria = await sessionFor('diretoria');
    const leadId = await deal('5521914140000', owner.id);
    const unowned = await deal('5521914141111', null);
    await deliver(inbound('5521914140000', 'Oi').body);
    await run();
    for (const url of [`/leads/${leadId}/whatsapp`]) {
      expect((await app.inject({ method: 'GET', url, cookies: other.cookies })).statusCode).toBe(
        404,
      );
      expect(
        (await app.inject({ method: 'GET', url, cookies: diretoria.cookies })).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/leads/${unowned}/whatsapp`,
          cookies: owner.cookies,
        })
      ).statusCode,
    ).toBe(404);
    const otherSend = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/text`,
      cookies: other.cookies,
      payload: { text: 'x' },
    });
    expect(otherSend.statusCode).toBe(404);
    const otherInbox = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations',
      cookies: other.cookies,
    });
    expect(
      otherInbox
        .json<{ conversations: WaConversationItem[] }>()
        .conversations.some((c) => c.leadId === leadId),
    ).toBe(false);
    nextSend = () => accepted('wamid.DIR1');
    const dirSend = await app.inject({
      method: 'POST',
      url: `/leads/${leadId}/whatsapp/text`,
      cookies: diretoria.cookies,
      payload: { text: 'Aqui é da diretoria.' },
    });
    expect(dirSend.statusCode).toBe(201);
    const marketing = await sessionFor('marketing');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/leads/${leadId}/whatsapp`,
          cookies: marketing.cookies,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('serves a received image in place, any other file as a download, only to who sees the deal', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const leadId = await deal('5521915150000', owner.id);
    const [contact] = await db
      .insert(waContacts)
      .values({ phone: '5521915150000', lastInboundAt: NOW })
      .returning();
    const [conversation] = await db
      .insert(waConversations)
      .values({ contactId: contact!.id, leadId })
      .returning();
    const file = async (mediaId: string, filename: string | null) =>
      (
        await db
          .insert(waMessages)
          .values({
            conversationId: conversation!.id,
            contactId: contact!.id,
            leadId,
            direction: 'in',
            author: 'contact',
            kind: 'document',
            content: { media: { id: mediaId, mimeType: 'x', filename } },
          })
          .returning()
      )[0]!.id;
    const image = await file('media-img', 'foto.jpg');
    const html = await file('media-html', '<script>.html');
    const evil = await file('media-evil', null);
    const shown = await app.inject({
      method: 'GET',
      url: `/whatsapp/messages/${image}/media`,
      cookies: owner.cookies,
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['content-type']).toBe('image/jpeg');
    expect(shown.headers['content-disposition']).toMatch(/^inline/);
    expect(shown.headers['content-security-policy']).toContain('sandbox');
    expect(shown.body).toBe('PNGDATA');
    const downloaded = await app.inject({
      method: 'GET',
      url: `/whatsapp/messages/${html}/media`,
      cookies: owner.cookies,
    });
    expect(downloaded.headers['content-type']).toBe('application/octet-stream');
    expect(downloaded.headers['content-disposition']).toMatch(
      /^attachment; filename="_script_.html"/,
    );
    const before = calls.length;
    const refused = await app.inject({
      method: 'GET',
      url: `/whatsapp/messages/${evil}/media`,
      cookies: owner.cookies,
    });
    expect(refused.statusCode).toBe(502);
    expect(calls.slice(before).some((c) => c.url.includes('evil.example'))).toBe(false);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/whatsapp/messages/${image}/media`,
          cookies: other.cookies,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('housekeeping', () => {
  it('a screen refreshing itself does not count as the person being active', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const old = new Date(Date.now() - 10 * 60_000);
    await db.update(sessions).set({ lastSeenAt: old });
    const leadId = await deal('5521916160000', owner.id);
    await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/whatsapp`,
      cookies: owner.cookies,
      headers: { 'x-wings-passive': '1' },
    });
    const all = await db.select({ lastSeenAt: sessions.lastSeenAt }).from(sessions);
    expect(all.every((s) => s.lastSeenAt.getTime() === old.getTime())).toBe(true);
    await app.inject({ method: 'GET', url: `/leads/${leadId}/whatsapp`, cookies: owner.cookies });
    const after = await db.select({ lastSeenAt: sessions.lastSeenAt }).from(sessions);
    expect(after.some((s) => s.lastSeenAt.getTime() > old.getTime())).toBe(true);
  });

  it('clears stored bodies after 90 days', async () => {
    await db
      .insert(waWebhookEvents)
      .values({ payload: { x: 1 }, status: 'done', receivedAt: new Date('2026-06-01T00:00:00Z') });
    const { purged } = await purgeWhatsAppPayloads(db, NOW);
    expect(purged).toBeGreaterThanOrEqual(1);
    const left = await db
      .select()
      .from(waWebhookEvents)
      .where(eq(waWebhookEvents.receivedAt, new Date('2026-06-01T00:00:00Z')));
    expect(left[0]?.payload).toBeNull();
  });

  it('keeps the template list in step with Meta reviews', async () => {
    await db
      .insert(waTemplates)
      .values({ name: 'boas_vindas', language: 'pt_BR', status: 'PENDING' })
      .onConflictDoNothing();
    await deliver(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: WABA,
            changes: [
              {
                field: 'message_template_status_update',
                value: {
                  event: 'APPROVED',
                  message_template_id: 9,
                  message_template_name: 'boas_vindas',
                  message_template_language: 'pt_BR',
                },
              },
            ],
          },
        ],
      }),
    );
    await run();
    const [row] = await db.select().from(waTemplates).where(eq(waTemplates.name, 'boas_vindas'));
    expect(row?.status).toBe('APPROVED');
  });
});

describe('the official number switch (Eric, 14/10)', () => {
  it('starts off, is read by a seller and flipped only by an Admin Master, audited', async () => {
    const seller = await sessionFor('vendedor_expansao');
    const admin = await sessionFor('admin_master');
    const read = (cookies: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/whatsapp/official-number', cookies });
    expect((await read(seller.cookies)).json()).toEqual({ live: false });
    const put = (cookies: Record<string, string>) =>
      app.inject({
        method: 'PUT',
        url: '/whatsapp/official-number',
        cookies,
        payload: { live: true },
      });
    expect((await put(seller.cookies)).statusCode).toBe(403);
    expect((await put(admin.cookies)).json()).toEqual({ live: true });
    expect((await read(seller.cookies)).json()).toEqual({ live: true });
    const entry = await db.query.auditLog.findFirst({
      where: eq(auditLog.action, 'whatsapp.official_number_switched'),
    });
    expect(entry?.actorEmployeeId).toBe(admin.id);
  });
});
