import { randomBytes } from 'node:crypto';
import {
  SESSION_COOKIE,
  SOFIA_DEFAULT_SETTINGS,
  type DealWhatsApp,
  type RoleKey,
  type WaFailedEvent,
  type WaInboxPage,
  type WaNewTarget,
} from '@wings/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  crmNotifications,
  leadEvents,
  leadTriageQueue,
  leads,
  waContacts,
  waConversations,
  waMessages,
  waNumberTemplates,
  waNumbers,
  waTemplates,
  waWebhookEvents,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  createEmployee,
  setOfficialLive,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import { configureLeadTriage } from '../leads/triage-schedule.js';
import { saveSofiaSettings } from '../sofia/settings.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import { applyWhatsAppPayload, processWhatsAppEvents, storeWhatsAppEvent } from './intake.js';
import { storeWhatsAppMedia } from './media-store.js';
import { numberConfigOf } from './numbers.js';

/**
 * The Central WhatsApp (docs/whatsapp/central.md) against a simulated Meta: a work number's own
 * traffic entering the CRM as its chat (messages, phone echoes, the history, the phone's
 * contacts), never Sofia's nor the triage's; the list's filters and pages; who reaches a work
 * number's chat; joining a chat to a deal; sending through the number's own token; and the
 * webhook queue waiting longer after each failure. The webhook bodies follow the shapes in Meta's
 * reference with made-up data: NOT verified against Meta. No test reaches the network.
 */

const KEY = randomBytes(32).toString('base64');
const TOKEN = 'fake-official-token';
const NUMBER_TOKEN = 'EAAG-fake-work-number-token';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';
const WORK_ID = '4200000000000077';
const WORK_WABA = '3100000000000077';
const WORK_PHONE = '5521911110000';
const PERSON = '5521988880001';
const NOW = new Date('2026-10-07T15:00:00Z');
const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let clock = NOW;

const sends: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
/** Each read of a WABA's templates: which WABA, with which token. */
const templateReads: { url: string; auth: string | null }[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const whatsappFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const auth = new Headers(init?.headers).get('authorization');
  if (url.pathname.endsWith('/message_templates')) {
    templateReads.push({ url: url.pathname, auth });
    return json({
      data: [
        {
          id: '9100000000000001',
          name: 'retomar_conversa_numero',
          language: 'pt_BR',
          status: 'APPROVED',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: 'Olá! Ainda quer conversar sobre a franquia?' }],
        },
      ],
    });
  }
  if (url.pathname.endsWith('/messages')) {
    sends.push({ url: url.pathname, auth, body: JSON.parse(String(init?.body)) });
    return json({ contacts: [{ wa_id: PERSON }], messages: [{ id: `wamid.SENT${sends.length}` }] });
  }
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
      WHATSAPP_APP_SECRET: 'whatsapp-app-secret-for-tests',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'whatsapp-verify-token-long-enough',
      WHATSAPP_ACCESS_TOKEN: TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
      WHATSAPP_WABA_ID: WABA,
      INTEGRATIONS_ENCRYPTION_KEY: KEY,
    }),
    db,
    now: () => clock,
    whatsappFetch,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
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

let owner: Awaited<ReturnType<typeof sessionFor>>;
let otherSeller: Awaited<ReturnType<typeof sessionFor>>;
let admin: Awaited<ReturnType<typeof sessionFor>>;
let numberId = '';

beforeAll(async () => {
  owner = await sessionFor('vendedor_expansao');
  otherSeller = await sessionFor('vendedor_formatacao');
  admin = await sessionFor('admin_master');
});

beforeEach(async () => {
  clock = NOW;
  sends.length = 0;
  templateReads.length = 0;
  await setOfficialLive(db, true);
  await db.delete(leadTriageQueue);
  await db.delete(waMessages);
  await db.delete(waConversations);
  await db.delete(waNumbers);
  await db.delete(leadEvents);
  await db.delete(leads);
  await db.delete(waWebhookEvents);
  const [row] = await db
    .insert(waNumbers)
    .values({
      phone: WORK_PHONE,
      label: 'Comercial Expansão',
      sector: 'comercial',
      ownerEmployeeId: owner.id,
      phoneNumberId: WORK_ID,
      wabaId: WORK_WABA,
      tokenEnc: createSecretBox(KEY).seal(NUMBER_TOKEN),
      status: 'connected',
      connectedAt: ago(60 * 24),
      webhooksSubscribed: true,
    })
    .returning({ id: waNumbers.id });
  numberId = row!.id;
});

async function deal(phone: string, ownerId: string | null, name = 'Negociação fictícia') {
  const [row] = await db
    .insert(leads)
    .values({ source: 'manual', name, phone, ownerEmployeeId: ownerId, pipeline: 'expansao' })
    .returning({ id: leads.id });
  return row!.id;
}

/** One change for the work number, as Meta's reference shapes it (made-up data). */
const workChange = (field: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WORK_WABA,
      changes: [
        {
          field,
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: WORK_PHONE, phone_number_id: WORK_ID },
            ...value,
          },
        },
      ],
    },
  ],
});

const fixtures = {
  message: (id: string, at: Date, text = 'Oi, vi o anúncio') =>
    workChange('messages', {
      contacts: [{ wa_id: PERSON, profile: { name: 'Pessoa Fictícia' } }],
      messages: [{ from: PERSON, id, timestamp: unix(at), type: 'text', text: { body: text } }],
    }),
  echo: (id: string, at: Date) =>
    workChange('smb_message_echoes', {
      message_echoes: [
        {
          from: WORK_PHONE,
          to: PERSON,
          id,
          timestamp: unix(at),
          type: 'text',
          text: { body: 'Resposta pelo celular' },
        },
      ],
    }),
  history: (at: Date) =>
    workChange('history', {
      history: [
        {
          metadata: { phase: 1, chunk_order: 1, progress: 55 },
          threads: [
            {
              id: PERSON,
              messages: [
                {
                  from: PERSON,
                  id: 'wamid.HIST1',
                  timestamp: unix(at),
                  type: 'text',
                  text: { body: 'Mensagem antiga' },
                  history_context: { status: 'READ' },
                },
                {
                  from: WORK_PHONE,
                  to: PERSON,
                  id: 'wamid.HIST2',
                  timestamp: unix(new Date(at.getTime() + 60_000)),
                  type: 'text',
                  text: { body: 'Resposta antiga' },
                  history_context: { status: 'DELIVERED' },
                },
              ],
            },
          ],
        },
      ],
    }),
  contacts: (removed = false) =>
    workChange('smb_app_state_sync', {
      state_sync: [
        {
          type: 'contact',
          contact: { full_name: 'Nome no Celular', first_name: 'Nome', phone_number: PERSON },
          action: removed ? 'remove' : 'add',
          metadata: { timestamp: unix(NOW) },
        },
      ],
    }),
};

const apply = (body: unknown) =>
  applyWhatsAppPayload(
    { db, phoneNumberId: PHONE_ID, wabaId: WABA, log: () => {}, now: () => clock },
    body,
  );

const chatOfPerson = async () =>
  (await db.select().from(waConversations).where(eq(waConversations.numberId, numberId)))[0];

const list = (cookies: Record<string, string>, query = '') =>
  app.inject({ method: 'GET', url: `/whatsapp/conversations${query}`, cookies });

describe('a work number’s own traffic in the CRM', () => {
  it('the person’s message, the phone’s echo, the history and the phone’s contact name land in one chat, never Sofia’s', async () => {
    await saveSofiaSettings(db, { ...SOFIA_DEFAULT_SETTINGS, enabled: true }, null, NOW);
    const triaged: unknown[] = [];
    configureLeadTriage((target) => triaged.push(target));
    try {
      await apply(fixtures.history(ago(60 * 24 * 30)));
      await apply(fixtures.message('wamid.LIVE1', ago(30)));
      await apply(fixtures.echo('wamid.ECHO1', ago(20)));
      await apply(fixtures.contacts());
      // Meta re-sends: nothing doubles.
      await apply(fixtures.message('wamid.LIVE1', ago(30)));
    } finally {
      configureLeadTriage(null);
      await saveSofiaSettings(db, { ...SOFIA_DEFAULT_SETTINGS, enabled: false }, null, NOW);
    }
    expect(triaged).toEqual([]);
    const chat = await chatOfPerson();
    expect(chat).toMatchObject({
      attendance: 'with_person',
      sofiaDueAt: null,
      phoneContactName: 'Nome no Celular',
      leadId: null,
    });
    const messages = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.conversationId, chat!.id))
      .orderBy(waMessages.createdAt);
    expect(
      messages.map((m) => [
        m.wamid,
        m.direction,
        m.author,
        m.status,
        Boolean((m.content as { history?: boolean }).history),
      ]),
    ).toEqual([
      [`${numberId}:wamid.HIST1`, 'in', 'contact', null, true],
      [`${numberId}:wamid.HIST2`, 'out', 'app', 'delivered', true],
      [`${numberId}:wamid.LIVE1`, 'in', 'contact', null, false],
      [`${numberId}:wamid.ECHO1`, 'out', 'app', 'sent', false],
    ]);
    // The history keeps its own day.
    expect(messages[0]!.createdAt.toISOString()).toBe(ago(60 * 24 * 30).toISOString());
    expect(await db.select().from(leadTriageQueue)).toHaveLength(0);
    // The official number's window and opt-out are not touched.
    const [contact] = await db.select().from(waContacts).where(eq(waContacts.phone, PERSON));
    expect(contact).toMatchObject({ lastInboundAt: null, optOutAt: null });
    const [number] = await db.select().from(waNumbers).where(eq(waNumbers.id, numberId));
    expect(number?.historyProgress).toBe(55);

    // A contact removed on the phone takes the saved name away.
    await apply(fixtures.contacts(true));
    expect((await chatOfPerson())?.phoneContactName).toBeNull();

    // The owner reads it as the number's chat: what went from the phone says so, no Sofia.
    const view = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${chat!.id}`,
      cookies: owner.cookies,
    });
    const data = view.json<DealWhatsApp>();
    expect(data.messages.map((m) => m.fromPhone)).toEqual([false, true, false, true]);
    expect(data).toMatchObject({
      number: { id: numberId, label: 'Comercial Expansão' },
      configured: true,
      calling: false,
      window: { open: true },
    });
  });

  it('joins the deal only when exactly one open deal has the phone, and says so in its history', async () => {
    const first = await deal(PERSON, owner.id);
    await deal(PERSON, otherSeller.id, 'Outra negociação');
    await apply(fixtures.message('wamid.AMB1', ago(10)));
    expect((await chatOfPerson())?.leadId).toBeNull();

    await db.delete(waMessages);
    await db.delete(waConversations);
    await db.update(leads).set({ won: true }).where(eq(leads.name, 'Outra negociação'));
    await apply(fixtures.message('wamid.ONE1', ago(10)));
    const chat = await chatOfPerson();
    expect(chat?.leadId).toBe(first);
    const [message] = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.conversationId, chat!.id));
    expect(message?.leadId).toBe(first);
    const [event] = await db.select().from(leadEvents).where(eq(leadEvents.leadId, first));
    expect(event).toMatchObject({
      kind: 'lead.whatsapp_linked',
      detail: { via: 'auto', numberId, conversationId: chat!.id },
    });
  });

  it('moves our own send’s status forward under the number', async () => {
    await apply(fixtures.message('wamid.W1', ago(10)));
    const chat = await chatOfPerson();
    const sent = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/text`,
      cookies: owner.cookies,
      payload: { text: 'Olá pelo número do comercial' },
    });
    expect(sent.statusCode).toBe(201);
    await apply(
      workChange('messages', {
        statuses: [
          { id: 'wamid.SENT1', status: 'read', timestamp: unix(NOW), recipient_id: PERSON },
        ],
      }),
    );
    const [row] = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.wamid, `${numberId}:wamid.SENT1`));
    expect(row?.status).toBe('read');
  });
});

describe('sending through a work number', () => {
  it('goes with the number’s own token and id, inside the 24 h of the person’s last message there', async () => {
    // Sellers are locked out of the official number; their own work number is not.
    await setOfficialLive(db, false);
    await apply(fixtures.message('wamid.S1', ago(60)));
    const chat = await chatOfPerson();
    const res = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/text`,
      cookies: owner.cookies,
      payload: { text: 'Oi! Aqui é do comercial.' },
    });
    expect(res.statusCode).toBe(201);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      url: `/v23.0/${WORK_ID}/messages`,
      auth: `Bearer ${NUMBER_TOKEN}`,
    });
    const audit = await db.query.auditLog.findFirst({
      where: eq(auditLog.action, 'whatsapp.message_sent'),
      orderBy: (t, { desc }) => [desc(t.at)],
    });
    expect(audit?.metadata).toMatchObject({ numberId, outcome: 'sent' });
  });

  it('refuses free text outside the 24 h, without calling Meta', async () => {
    await apply(fixtures.message('wamid.S2', ago(60 * 25)));
    const chat = await chatOfPerson();
    const late = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/text`,
      cookies: owner.cookies,
      payload: { text: 'Oi' },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: 'window_closed' });
    expect(sends).toHaveLength(0);
  });

  it("outside the 24 h, sends its own WABA's templates, read with its token; never the official ones", async () => {
    await apply(fixtures.message('wamid.S3', ago(60 * 25)));
    const chat = await chatOfPerson();
    await db
      .insert(waTemplates)
      .values({
        name: 'so_do_oficial',
        language: 'pt_BR',
        status: 'APPROVED',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Olá! Só no número oficial.' }],
      })
      .onConflictDoNothing();
    const list = await app.inject({
      method: 'GET',
      url: `/whatsapp/templates?numberId=${numberId}`,
      cookies: owner.cookies,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ templates: { name: string }[] }>().templates.map((t) => t.name)).toEqual([
      'retomar_conversa_numero',
    ]);
    expect(templateReads).toEqual([
      { url: `/v23.0/${WORK_WABA}/message_templates`, auth: `Bearer ${NUMBER_TOKEN}` },
    ]);
    // A seller who does not reach the number does not read its templates either.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/whatsapp/templates?numberId=${numberId}`,
          cookies: otherSeller.cookies,
        })
      ).statusCode,
    ).toBe(404);
    const send = (name: string) =>
      app.inject({
        method: 'POST',
        url: `/whatsapp/conversations/${chat!.id}/template`,
        cookies: owner.cookies,
        payload: { name, language: 'pt_BR', params: [], companyArticle: 'a' },
      });
    const official = await send('so_do_oficial');
    expect(official.statusCode).toBe(422);
    expect(official.json()).toMatchObject({ error: 'template_unknown' });
    expect(sends).toHaveLength(0);
    const sent = await send('retomar_conversa_numero');
    expect(sent.statusCode).toBe(201);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      url: `/v23.0/${WORK_ID}/messages`,
      auth: `Bearer ${NUMBER_TOKEN}`,
      body: { type: 'template', template: { name: 'retomar_conversa_numero' } },
    });
    // Its review on Meta moves only its own row.
    await apply(
      workChange('message_template_status_update', {
        event: 'PAUSED',
        message_template_id: '9100000000000001',
        message_template_name: 'retomar_conversa_numero',
        message_template_language: 'pt_BR',
        reason: null,
      }),
    );
    const [row] = await db
      .select()
      .from(waNumberTemplates)
      .where(eq(waNumberTemplates.numberId, numberId));
    expect(row?.status).toBe('PAUSED');
  });
});

describe('who reaches a work number’s chat', () => {
  it('its owner and full scope; another seller gets 404 everywhere, even owning the deal', async () => {
    const leadId = await deal(PERSON, otherSeller.id);
    await apply(fixtures.message('wamid.R1', ago(5)));
    const chat = await chatOfPerson();
    expect(chat?.leadId).toBe(leadId);
    await apply(
      workChange('messages', {
        messages: [
          {
            from: PERSON,
            id: 'wamid.R2',
            timestamp: unix(ago(4)),
            type: 'image',
            image: { id: 'media-1', mime_type: 'image/jpeg' },
          },
        ],
      }),
    );
    const [image] = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.wamid, `${numberId}:wamid.R2`));

    for (const reader of [owner, admin]) {
      const page = (await list(reader.cookies)).json<WaInboxPage>();
      expect(page.conversations.map((c) => c.conversationId)).toContain(chat!.id);
      const row = page.conversations.find((c) => c.conversationId === chat!.id);
      expect(row?.number).toMatchObject({ id: numberId, label: 'Comercial Expansão' });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/whatsapp/conversations/${chat!.id}`,
            cookies: reader.cookies,
          })
        ).statusCode,
      ).toBe(200);
    }
    const outside = (await list(otherSeller.cookies)).json<WaInboxPage>();
    expect(outside.conversations.map((c) => c.conversationId)).not.toContain(chat!.id);
    for (const url of [
      `/whatsapp/conversations/${chat!.id}`,
      `/whatsapp/messages/${image!.id}/media`,
    ])
      expect(
        (await app.inject({ method: 'GET', url, cookies: otherSeller.cookies })).statusCode,
      ).toBe(404);
    const send = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/text`,
      cookies: otherSeller.cookies,
      payload: { text: 'Oi' },
    });
    expect(send.statusCode).toBe(404);

    // The deal's own page shows its official chat only, and points to the number's chat for those who reach it.
    const dealPage = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/whatsapp`,
      cookies: admin.cookies,
    });
    const data = dealPage.json<DealWhatsApp>();
    expect(data.messages).toHaveLength(0);
    expect(data.numberChats).toEqual([
      { conversationId: chat!.id, number: expect.objectContaining({ id: numberId }) },
    ]);
    const sellerPage = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/whatsapp`,
      cookies: otherSeller.cookies,
    });
    expect(sellerPage.json<DealWhatsApp>().numberChats).toEqual([]);
  });

  it('Sofia’s screen never lists a work number’s chat', async () => {
    await apply(fixtures.message('wamid.SF1', ago(5)));
    const chat = await chatOfPerson();
    const sofia = await app.inject({
      method: 'GET',
      url: '/sofia/conversations',
      cookies: admin.cookies,
    });
    expect(
      sofia
        .json<{ conversations: { conversationId: string }[] }>()
        .conversations.map((c) => c.conversationId),
    ).not.toContain(chat!.id);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/sofia/conversations/${chat!.id}`,
          cookies: admin.cookies,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('the Central’s list', () => {
  it('narrows by number, responsible, Sofia or person, department, state and day, and pages on', async () => {
    // An official conversation with no deal (Sofia's) and the work number's chat.
    await apply({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: PHONE_ID },
                contacts: [{ wa_id: '5521988880002', profile: { name: 'Oficial' } }],
                messages: [
                  {
                    from: '5521988880002',
                    id: 'wamid.OF1',
                    timestamp: unix(ago(90)),
                    type: 'text',
                    text: { body: 'oi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    await db
      .update(waConversations)
      .set({ attendance: 'sofia' })
      .where(isNull(waConversations.numberId));
    await apply(fixtures.message('wamid.L1', ago(10)));
    const chat = await chatOfPerson();
    const ids = async (query: string) =>
      (await list(admin.cookies, query))
        .json<WaInboxPage>()
        .conversations.map((c) => c.conversationId);

    expect(await ids(`?number=${numberId}`)).toEqual([chat!.id]);
    expect(await ids('?number=official')).not.toContain(chat!.id);
    expect(await ids('?filter=sofia')).not.toContain(chat!.id);
    expect(await ids('?filter=human')).toContain(chat!.id);
    expect(await ids('?sector=comercial')).toEqual([chat!.id]);
    expect(await ids('?sector=marketing')).toEqual([]);
    expect(await ids('?state=with_person')).toContain(chat!.id);
    // The chat has no deal: its number's owner is the responsible.
    expect(
      (await list(owner.cookies, '?filter=mine'))
        .json<WaInboxPage>()
        .conversations.map((c) => c.conversationId),
    ).toEqual([chat!.id]);
    expect(await ids('?filter=unassigned')).not.toContain(chat!.id);
    expect(await ids('?from=2026-10-07&to=2026-10-07')).toContain(chat!.id);
    expect(await ids('?to=2026-10-06')).toEqual([]);
    expect((await list(admin.cookies, '?before=nonsense')).statusCode).toBe(400);

    // History is never unread.
    await apply(fixtures.history(ago(60 * 24 * 40)));
    const row = (await list(owner.cookies))
      .json<WaInboxPage>()
      .conversations.find((c) => c.conversationId === chat!.id);
    expect(row?.unreadCount).toBe(1);
  });

  it('pages: 50 a time, the next page starts after the last one, nothing repeated or skipped', async () => {
    for (let i = 0; i < 53; i++)
      await applyWhatsAppPayload(
        { db, phoneNumberId: PHONE_ID, wabaId: WABA, log: () => {}, now: () => clock },
        workChange('messages', {
          messages: [
            {
              from: `55219888${String(10000 + i)}`,
              id: `wamid.P${i}`,
              timestamp: unix(ago(100 - i)),
              type: 'text',
              text: { body: `m${i}` },
            },
          ],
        }),
      );
    const first = (await list(owner.cookies, `?number=${numberId}`)).json<WaInboxPage>();
    expect(first.conversations).toHaveLength(50);
    expect(first.next).not.toBeNull();
    const second = (
      await list(owner.cookies, `?number=${numberId}&before=${encodeURIComponent(first.next!)}`)
    ).json<WaInboxPage>();
    expect(second.conversations).toHaveLength(3);
    expect(second.next).toBeNull();
    const all = [...first.conversations, ...second.conversations].map((c) => c.conversationId);
    expect(new Set(all).size).toBe(53);
  });
});

describe('joining a chat to a deal (the person chooses)', () => {
  it('lists the deals of the phone in the reader’s reach; joins one, once, written in its history and the audit', async () => {
    const a = await deal(PERSON, owner.id, 'Primeira');
    await deal(PERSON, owner.id, 'Segunda');
    const foreign = await deal('5521988889999', owner.id, 'De outro telefone');
    await apply(fixtures.message('wamid.J1', ago(5)));
    const chat = await chatOfPerson();
    expect(chat?.leadId).toBeNull();
    const deals = await app.inject({
      method: 'GET',
      url: `/whatsapp/conversations/${chat!.id}/deals`,
      cookies: owner.cookies,
    });
    expect(
      deals
        .json<{ deals: WaNewTarget[] }>()
        .deals.map((d) => d.name)
        .sort(),
    ).toEqual(['Primeira', 'Segunda']);
    const wrong = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/link`,
      cookies: owner.cookies,
      payload: { leadId: foreign },
    });
    expect(wrong.statusCode).toBe(404);
    const linked = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/link`,
      cookies: owner.cookies,
      payload: { leadId: a },
    });
    expect(linked.statusCode).toBe(204);
    expect((await chatOfPerson())?.leadId).toBe(a);
    const again = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${chat!.id}/link`,
      cookies: owner.cookies,
      payload: { leadId: a },
    });
    expect(again.statusCode).toBe(409);
    const [event] = await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, a), eq(leadEvents.kind, 'lead.whatsapp_linked')));
    expect(event).toMatchObject({ actorEmployeeId: owner.id, detail: { via: 'manual', numberId } });
    const audit = await db.query.auditLog.findFirst({
      where: eq(auditLog.action, 'whatsapp.conversation_linked'),
    });
    expect(audit).toMatchObject({ entityId: a, metadata: { conversationId: chat!.id, numberId } });
    expect(JSON.stringify(audit?.metadata)).not.toContain(PERSON);
  });

  it('"Nova conversa" by a work number opens its chat on the deal’s phone, sending nothing', async () => {
    const leadId = await deal(PERSON, owner.id);
    const numbers = await app.inject({
      method: 'GET',
      url: '/whatsapp/chat-numbers',
      cookies: owner.cookies,
    });
    expect(numbers.json<{ numbers: { id: string; connected: boolean }[] }>().numbers).toEqual([
      expect.objectContaining({ id: numberId, connected: true }),
    ]);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/chat-numbers',
          cookies: otherSeller.cookies,
        })
      ).json<{ numbers: unknown[] }>().numbers,
    ).toEqual([]);
    const started = await app.inject({
      method: 'POST',
      url: `/whatsapp/chat-numbers/${numberId}/conversations`,
      cookies: owner.cookies,
      payload: { leadId, phone: PERSON },
    });
    expect(started.statusCode).toBe(200);
    const chat = await chatOfPerson();
    expect(started.json()).toEqual({ conversationId: chat!.id });
    expect(chat?.leadId).toBe(leadId);
    expect(sends).toHaveLength(0);
    const notTheirs = await app.inject({
      method: 'POST',
      url: `/whatsapp/chat-numbers/${numberId}/conversations`,
      cookies: owner.cookies,
      payload: { leadId, phone: '5521988887777' },
    });
    expect(notTheirs.statusCode).toBe(422);
  });
});

describe('our sends Meta never answered', () => {
  it('are marked unknown after 10 minutes and the sender hears; nothing is sent again', async () => {
    const phone = '5521977771234';
    const [contact] = await db.insert(waContacts).values({ phone }).returning();
    const [conversation] = await db
      .insert(waConversations)
      .values({ contactId: contact!.id, lastMessageAt: ago(30) })
      .returning();
    const [stuck] = await db
      .insert(waMessages)
      .values({
        conversationId: conversation!.id,
        contactId: contact!.id,
        direction: 'out',
        author: 'employee',
        employeeId: owner.id,
        kind: 'text',
        text: 'Mensagem de teste',
        status: 'pending',
        createdAt: ago(20),
      })
      .returning();
    const [fresh] = await db
      .insert(waMessages)
      .values({
        conversationId: conversation!.id,
        contactId: contact!.id,
        direction: 'out',
        author: 'employee',
        employeeId: owner.id,
        kind: 'text',
        text: 'Ainda indo',
        status: 'pending',
        createdAt: ago(2),
      })
      .returning();
    const swept = await processWhatsAppEvents({
      db,
      phoneNumberId: PHONE_ID,
      wabaId: WABA,
      log: () => {},
      now: () => clock,
    });
    expect(swept.processed).toBe(0);
    const [after] = await db.select().from(waMessages).where(eq(waMessages.id, stuck!.id));
    expect(after).toMatchObject({ status: 'pending', wamid: null, errorTitle: 'unknown_outcome' });
    const [still] = await db.select().from(waMessages).where(eq(waMessages.id, fresh!.id));
    expect(still!.errorTitle).toBeNull();
    const notices = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.kind, 'whatsapp_send_unknown'));
    expect(notices.map((n) => n.recipientEmployeeId)).toEqual([owner.id]);
    expect(sends).toHaveLength(0);
    // A second pass tells nobody twice.
    await processWhatsAppEvents({
      db,
      phoneNumberId: PHONE_ID,
      wabaId: WABA,
      log: () => {},
      now: () => clock,
    });
    expect(
      await db.$count(crmNotifications, eq(crmNotifications.kind, 'whatsapp_send_unknown')),
    ).toBe(1);
  });
});

describe('the webhook queue', () => {
  // A timestamp no Date can hold: the body fails every time, as a broken database would.
  const broken = () =>
    workChange('messages', {
      messages: [
        { from: PERSON, id: 'wamid.BAD', timestamp: '1e30', type: 'text', text: { body: 'x' } },
      ],
    });
  const run = () =>
    processWhatsAppEvents({
      db,
      phoneNumberId: PHONE_ID,
      wabaId: WABA,
      log: () => {},
      now: () => clock,
    });

  it('waits longer after each failure, gives up after 5, and the Admin Master sends it back, without its content', async () => {
    const id = await storeWhatsAppEvent(db, broken());
    const state = async () =>
      (await db.select().from(waWebhookEvents).where(eq(waWebhookEvents.id, id)))[0]!;
    await run();
    expect(await state()).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await state()).nextAttemptAt.toISOString()).toBe(
      new Date(NOW.getTime() + 2 * 60_000).toISOString(),
    );
    // Before its time nothing happens.
    clock = new Date(NOW.getTime() + 60_000);
    expect((await run()).processed).toBe(0);
    for (const minutes of [3, 8, 17, 34]) {
      clock = new Date(NOW.getTime() + minutes * 60_000);
      await run();
    }
    expect(await state()).toMatchObject({ status: 'failed', attempts: 5 });
    // The Admin Master hears it in Avisos, once, by the screen it is on (never its content).
    const notices = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.kind, 'whatsapp_webhook_failed'));
    expect(notices.map((n) => n.recipientEmployeeId)).toContain(admin.id);
    expect(notices.map((n) => n.recipientEmployeeId)).not.toContain(owner.id);
    expect(JSON.stringify(notices)).not.toContain(PERSON);

    const failed = await app.inject({
      method: 'GET',
      url: '/whatsapp/webhook-events/failed',
      cookies: admin.cookies,
    });
    expect(failed.json<{ events: WaFailedEvent[] }>().events).toEqual([
      expect.objectContaining({ id, attempts: 5, lastError: 'error', hasPayload: true }),
    ]);
    expect(failed.body).not.toContain(PERSON);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/whatsapp/webhook-events/failed',
          cookies: owner.cookies,
        })
      ).statusCode,
    ).toBe(403);
    const retry = await app.inject({
      method: 'POST',
      url: `/whatsapp/webhook-events/${id}/retry`,
      cookies: admin.cookies,
    });
    expect(retry.statusCode).toBe(202);
    expect(await state()).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    const audit = await db.query.auditLog.findFirst({
      where: eq(auditLog.action, 'whatsapp.webhook_event_retried'),
    });
    expect(audit).toMatchObject({ entityId: id, metadata: {} });
    // A body the purge cleared has nothing left to send back.
    await db
      .update(waWebhookEvents)
      .set({ status: 'failed', payload: null })
      .where(eq(waWebhookEvents.id, id));
    const gone = await app.inject({
      method: 'POST',
      url: `/whatsapp/webhook-events/${id}/retry`,
      cookies: admin.cookies,
    });
    expect(gone.statusCode).toBe(409);
    expect(await db.select().from(waMessages)).toHaveLength(0);
  });
});

describe('a work number’s received file', () => {
  it('is copied to our storage with that number’s own token, never the official one', async () => {
    await apply(
      workChange('messages', {
        messages: [
          {
            from: PERSON,
            id: 'wamid.IMG1',
            timestamp: unix(ago(2)),
            type: 'image',
            image: { id: 'media-work', mime_type: 'image/jpeg' },
          },
        ],
      }),
    );
    const auths: (string | null)[] = [];
    const mediaFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      auths.push(new Headers(init?.headers).get('authorization'));
      if (url.hostname === 'lookaside.fbsbx.com') return new Response('JPEGDATA');
      return json({
        url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
        mime_type: 'image/jpeg',
        file_size: 8,
      });
    }) as typeof fetch;
    const put: string[] = [];
    const storage = {
      put: async (key: string) => {
        put.push(key);
      },
      delete: async () => undefined,
    } as unknown as ObjectStorage;
    const result = await storeWhatsAppMedia({
      db,
      storage,
      config: { token: TOKEN, phoneNumberId: PHONE_ID, wabaId: WABA },
      numberConfig: (id) => numberConfigOf(db, createSecretBox(KEY), id),
      fetchImpl: mediaFetch,
      log: () => {},
      now: () => clock,
    });
    expect(result).toMatchObject({ queued: 1, stored: 1 });
    expect(put).toHaveLength(1);
    expect(auths).toEqual([`Bearer ${NUMBER_TOKEN}`, `Bearer ${NUMBER_TOKEN}`]);
  });
});
