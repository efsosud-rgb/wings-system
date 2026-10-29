import {
  SESSION_COOKIE,
  type RoleKey,
  type WaAttendanceView,
  type WaInboxPage,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  crmDistributionMembers,
  crmNotifications,
  leads,
  waContacts,
  waConversationEvents,
  waConversations,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  createEmployee,
  setOfficialLive,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import { applyWhatsAppPayload } from './intake.js';

/**
 * Who answers a conversation (docs/whatsapp/central.md, "Atendimento") against a simulated Meta:
 * the holder and the lock, "Assumir" with the one who had it told, a transfer with a notice, the
 * department queue, resolve and reopen, "está respondendo", the version that refuses a stale
 * action, the rotation, and the history. Made-up people and phones; no test reaches the network.
 */

const TOKEN = 'fake-official-token';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';
const NOW = new Date('2026-10-07T15:00:00Z');
const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let clock = NOW;
let sent = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const whatsappFetch = (async (input: string | URL | Request) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: `wamid.OUT${++sent}` }] });
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

type Session = { id: string; cookies: Record<string, string> };

async function sessionFor(role: RoleKey): Promise<Session> {
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

let adminA: Session;
let adminB: Session;
let seller: Session;
let otherSeller: Session;

beforeAll(async () => {
  adminA = await sessionFor('admin_master');
  adminB = await sessionFor('gerente_comercial');
  seller = await sessionFor('vendedor_formatacao');
  otherSeller = await sessionFor('vendedor_expansao');
});

beforeEach(async () => {
  clock = NOW;
  await setOfficialLive(db, true);
});

let phoneSeq = 0;
const newPhone = () => `55219${String(70000000 + ++phoneSeq).padStart(8, '0')}`;
let seq = 0;

/** The person writes to the official number (Meta's shape, made-up data). */
async function personWrites(phone: string, text = 'Oi, quero saber mais') {
  await applyWhatsAppPayload(
    { db, phoneNumberId: PHONE_ID, wabaId: WABA, log: () => {}, now: () => clock },
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
                metadata: { display_phone_number: '15550000000', phone_number_id: PHONE_ID },
                contacts: [{ profile: { name: 'Pessoa Fictícia' }, wa_id: phone }],
                messages: [
                  {
                    from: phone,
                    id: `wamid.IN${++seq}`,
                    timestamp: unix(clock),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  );
}

async function conversationOf(phone: string) {
  const [row] = await db
    .select({ conversation: waConversations })
    .from(waConversations)
    .innerJoin(waContacts, eq(waContacts.id, waConversations.contactId))
    .where(eq(waContacts.phone, phone));
  return row!.conversation;
}

const post = (who: Session, url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url, cookies: who.cookies, payload });
const say = (who: Session, id: string, text = 'Olá! Como posso ajudar?') =>
  post(who, `/whatsapp/conversations/${id}/text`, { text });
const view = async (who: Session, id: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/whatsapp/conversations/${id}/attendance`,
    cookies: who.cookies,
  });
  expect(res.statusCode).toBe(200);
  return res.json<WaAttendanceView>();
};
const assign = (
  who: Session,
  id: string,
  version: number,
  employeeId: string | null,
  queue?: string,
) => post(who, `/whatsapp/conversations/${id}/assign`, { version, employeeId, queue });
const noticesOf = (employeeId: string) =>
  db
    .select({ message: crmNotifications.message })
    .from(crmNotifications)
    .where(
      and(
        eq(crmNotifications.recipientEmployeeId, employeeId),
        eq(crmNotifications.kind, 'whatsapp_assigned'),
      ),
    );
const kindsOf = async (conversationId: string) =>
  (
    await db
      .select({ kind: waConversationEvents.kind })
      .from(waConversationEvents)
      .where(eq(waConversationEvents.conversationId, conversationId))
      .orderBy(waConversationEvents.createdAt)
  ).map((row) => row.kind);

describe('the holder and the lock', () => {
  it('the first person to write holds it; anyone else is refused with the name, takes it, and the first one hears', async () => {
    const phone = newPhone();
    await personWrites(phone);
    let conversation = await conversationOf(phone);
    expect(conversation).toMatchObject({ attendance: 'waiting_human', assigneeEmployeeId: null });

    expect((await say(adminA, conversation.id)).statusCode).toBe(201);
    conversation = await conversationOf(phone);
    expect(conversation).toMatchObject({
      attendance: 'with_person',
      assigneeEmployeeId: adminA.id,
    });

    const refused = await say(adminB, conversation.id, 'Eu também respondo');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'not_holder' });
    expect(refused.json().message).toContain('Assuma a conversa');

    const seen = await view(adminB, conversation.id);
    expect(seen.attendance).toMatchObject({ holderId: adminA.id, assigned: true });
    expect(seen.attendance.can).toMatchObject({ take: true, transfer: true });

    expect(
      (await assign(adminB, conversation.id, seen.attendance.version, adminB.id)).statusCode,
    ).toBe(204);
    expect((await say(adminB, conversation.id)).statusCode).toBe(201);
    expect((await say(adminA, conversation.id, 'Ainda sou eu')).statusCode).toBe(409);
    expect((await noticesOf(adminA.id)).map((n) => n.message).join(' ')).toContain(
      'assumiu uma conversa do WhatsApp que estava com você',
    );
    expect(await kindsOf(conversation.id)).toEqual(['taken', 'taken']);
    const audits = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.action, 'whatsapp.conversation_taken'));
    expect(audits.length).toBeGreaterThan(0);
  });

  it('a stale version is refused: two people taking at once, only the first wins', async () => {
    const phone = newPhone();
    await personWrites(phone);
    const { id, version } = await conversationOf(phone);
    expect((await assign(adminA, id, version, adminA.id)).statusCode).toBe(204);
    const late = await assign(adminB, id, version, adminB.id);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: 'conversation_changed' });
    expect((await conversationOf(phone)).assigneeEmployeeId).toBe(adminA.id);
  });

  it("the deal's owner holds a deal's conversation: a manager takes it before writing", async () => {
    const phone = newPhone();
    await db.insert(leads).values({
      source: 'manual',
      name: 'Negócio fictício',
      phone,
      ownerEmployeeId: seller.id,
      pipeline: 'formatacao',
    });
    await personWrites(phone);
    const conversation = await conversationOf(phone);
    expect((await view(seller, conversation.id)).attendance).toMatchObject({
      holderId: seller.id,
      assigned: false,
    });
    expect((await say(adminA, conversation.id)).statusCode).toBe(409);
    expect((await say(seller, conversation.id)).statusCode).toBe(201);
  });
});

describe('transfer, queue, resolve and reopen', () => {
  it('the holder passes it to a seller, who hears, sees it under Minhas and answers it', async () => {
    const phone = newPhone();
    await personWrites(phone);
    let conversation = await conversationOf(phone);
    await say(adminA, conversation.id);
    conversation = await conversationOf(phone);
    // The seller does not reach a conversation with no deal...
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/whatsapp/conversations/${conversation.id}`,
          cookies: seller.cookies,
        })
      ).statusCode,
    ).toBe(404);
    // ...until it is given to them.
    expect(
      (await assign(adminA, conversation.id, conversation.version, seller.id)).statusCode,
    ).toBe(204);
    expect((await conversationOf(phone)).attendance).toBe('waiting_seller');
    expect((await noticesOf(seller.id)).map((n) => n.message).join(' ')).toContain(
      'passou uma conversa do WhatsApp para você',
    );
    const mine = await app.inject({
      method: 'GET',
      url: '/whatsapp/conversations?filter=mine',
      cookies: seller.cookies,
    });
    const item = mine
      .json<WaInboxPage>()
      .conversations.find((c) => c.conversationId === conversation.id);
    expect(item).toMatchObject({ holderId: seller.id });
    expect((await say(seller, conversation.id)).statusCode).toBe(201);
    expect((await say(adminA, conversation.id, 'Ainda eu')).statusCode).toBe(409);
  });

  it('a full-scope reader passes it on, only to someone who talks on WhatsApp; a seller does not', async () => {
    const phone = newPhone();
    await personWrites(phone);
    let conversation = await conversationOf(phone);
    await assign(adminA, conversation.id, conversation.version, seller.id);
    conversation = await conversationOf(phone);
    // The seller holds it but does not see the team: back to a queue, never to a person.
    const bySeller = await assign(seller, conversation.id, conversation.version, otherSeller.id);
    expect(bySeller.statusCode).toBe(403);
    expect((await view(seller, conversation.id)).people).toEqual([]);
    const marketing = await sessionFor('marketing');
    const toMarketing = await assign(adminA, conversation.id, conversation.version, marketing.id);
    expect(toMarketing.statusCode).toBe(400);
    expect(toMarketing.json()).toMatchObject({ error: 'person_invalid' });
    expect(
      (await assign(adminA, conversation.id, conversation.version, otherSeller.id)).statusCode,
    ).toBe(204);
    conversation = await conversationOf(phone);
    // The first seller no longer reaches it at all.
    expect(
      (await assign(seller, conversation.id, conversation.version, seller.id)).statusCode,
    ).toBe(404);
    expect(await kindsOf(conversation.id)).toEqual(['transferred', 'transferred']);
  });

  it("back to a department's queue: nobody holds it, the Sem responsável tab and the department filter find it", async () => {
    const phone = newPhone();
    await personWrites(phone);
    let conversation = await conversationOf(phone);
    await say(adminA, conversation.id);
    conversation = await conversationOf(phone);
    expect(
      (await assign(adminA, conversation.id, conversation.version, null, 'formatacao-financeiro'))
        .statusCode,
    ).toBe(204);
    expect(await conversationOf(phone)).toMatchObject({
      assigneeEmployeeId: null,
      queue: 'formatacao-financeiro',
      attendance: 'waiting_human',
    });
    for (const url of [
      '/whatsapp/conversations?filter=unassigned',
      '/whatsapp/conversations?sector=formatacao-financeiro',
    ]) {
      const page = (
        await app.inject({ method: 'GET', url, cookies: adminB.cookies })
      ).json<WaInboxPage>();
      expect(
        page.conversations.some((c) => c.conversationId === conversation.id),
        url,
      ).toBe(true);
    }
  });

  it("a deal's conversation does not go to a queue: its owner would hold it again", async () => {
    const phone = newPhone();
    await db.insert(leads).values({
      source: 'manual',
      name: 'Negócio fictício',
      phone,
      ownerEmployeeId: seller.id,
      pipeline: 'formatacao',
    });
    await personWrites(phone);
    const conversation = await conversationOf(phone);
    const res = await assign(adminA, conversation.id, conversation.version, null, 'comercial');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'has_owner' });
  });

  it('resolve closes it with its holder, reopen brings it back to them; a new message starts over', async () => {
    const phone = newPhone();
    await personWrites(phone);
    let conversation = await conversationOf(phone);
    await say(adminA, conversation.id);
    conversation = await conversationOf(phone);
    expect(
      (
        await post(seller, `/whatsapp/conversations/${conversation.id}/resolve`, {
          version: conversation.version,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(adminA, `/whatsapp/conversations/${conversation.id}/resolve`, {
          version: conversation.version,
        })
      ).statusCode,
    ).toBe(204);
    conversation = await conversationOf(phone);
    expect(conversation).toMatchObject({ attendance: 'closed', assigneeEmployeeId: adminA.id });
    expect(
      (
        await post(adminA, `/whatsapp/conversations/${conversation.id}/reopen`, {
          version: conversation.version,
        })
      ).statusCode,
    ).toBe(204);
    conversation = await conversationOf(phone);
    expect(conversation).toMatchObject({
      attendance: 'with_person',
      assigneeEmployeeId: adminA.id,
    });

    // Resolved again, then the person writes: a closed conversation starts over (Eric, 07/10).
    await post(adminA, `/whatsapp/conversations/${conversation.id}/resolve`, {
      version: conversation.version,
    });
    await personWrites(phone, 'Voltei');
    expect(await conversationOf(phone)).toMatchObject({
      attendance: 'waiting_human',
      assigneeEmployeeId: null,
    });
    expect(await kindsOf(conversation.id)).toEqual([
      'taken',
      'resolved',
      'reopened',
      'resolved',
      'reopened',
    ]);
  });
});

describe('está respondendo', () => {
  it('the other person sees who is typing, for a few seconds only', async () => {
    const phone = newPhone();
    await personWrites(phone);
    const { id } = await conversationOf(phone);
    const first = await post(adminA, `/whatsapp/conversations/${id}/replying`);
    expect(first.json()).toEqual({ replyingName: null });
    const second = await post(adminB, `/whatsapp/conversations/${id}/replying`);
    expect(second.json().replyingName).toEqual(expect.any(String));
    expect((await view(adminB, id)).attendance.replyingName).toEqual(expect.any(String));
    expect((await view(adminA, id)).attendance.replyingName).toBeNull();
    clock = new Date(NOW.getTime() + 60_000);
    expect((await view(adminB, id)).attendance.replyingName).toBeNull();
  });
});

describe('the rotation', () => {
  it('off (the default), a conversation nobody holds waits; on, the funnel’s next person gets it and hears', async () => {
    const phoneA = newPhone();
    await db.insert(leads).values({
      source: 'manual',
      name: 'Sem dono A',
      phone: phoneA,
      ownerEmployeeId: null,
      pipeline: 'formatacao',
    });
    await personWrites(phoneA);
    expect((await conversationOf(phoneA)).assigneeEmployeeId).toBeNull();

    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/whatsapp/assignment',
          cookies: seller.cookies,
          payload: { mode: 'rodizio' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/whatsapp/assignment',
          cookies: adminA.cookies,
          payload: { mode: 'rodizio' },
        })
      ).statusCode,
    ).toBe(200);
    await db
      .insert(crmDistributionMembers)
      .values({ pipeline: 'formatacao', employeeId: seller.id });
    const phoneB = newPhone();
    await db.insert(leads).values({
      source: 'manual',
      name: 'Sem dono B',
      phone: phoneB,
      ownerEmployeeId: null,
      pipeline: 'formatacao',
    });
    await personWrites(phoneB);
    const conversation = await conversationOf(phoneB);
    expect(conversation).toMatchObject({
      assigneeEmployeeId: seller.id,
      attendance: 'waiting_seller',
    });
    expect(await kindsOf(conversation.id)).toEqual(['distributed']);
    expect((await noticesOf(seller.id)).map((n) => n.message).join(' ')).toContain(
      'O rodízio passou',
    );
    await app.inject({
      method: 'PUT',
      url: '/whatsapp/assignment',
      cookies: adminA.cookies,
      payload: { mode: 'manual' },
    });
    await db.delete(crmDistributionMembers);
  });
});
