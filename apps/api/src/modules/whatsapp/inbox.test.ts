import { createHmac } from 'node:crypto';
import { SESSION_COOKIE, type RoleKey, type WaConversationItem } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leads, waConversations, waMessages } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { processWhatsAppEvents } from './intake.js';
import { snippetOf } from './thread.js';

/**
 * The inbox as WhatsApp Desktop (docs/whatsapp/cloud-api.md): the menu's count
 * of unread conversations (`GET /whatsapp/inbox/summary`) and the search inside
 * the messages' text, each in the reader's reach and nothing beyond it.
 * Messages arrive by Meta's signed webhook, as in production.
 */

const APP_SECRET = 'whatsapp-app-secret-for-tests';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

const whatsappFetch = (async () =>
  new Response(JSON.stringify({ error: { code: 100 } }), { status: 400 })) as typeof fetch;

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
      WHATSAPP_ACCESS_TOKEN: 'fake-whatsapp-token',
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

let phones = 0;
const newPhone = () => `55219770${String(3000 + ++phones)}`;

async function deal(phone: string, ownerId: string | null, name = 'Elena Prado') {
  const [row] = await db
    .insert(leads)
    .values({ source: 'manual', name, phone, ownerEmployeeId: ownerId, pipeline: 'formatacao' })
    .returning({ id: leads.id });
  return row!.id;
}

let seq = 0;
/** The person writes: Meta's published shape of a text, delivered signed and applied by the queue. */
async function write(from: string, text: string, fields?: Record<string, unknown>) {
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
              contacts: [{ profile: { name: 'Elena' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.INBOX${++seq}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...(fields ?? { type: 'text', text: { body: text } }),
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
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`,
    },
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  await processWhatsAppEvents({ db, phoneNumberId: PHONE_ID, log: () => {} });
  return `wamid.INBOX${seq}`;
}

async function conversationOfLead(leadId: string) {
  const [row] = await db.select().from(waConversations).where(eq(waConversations.leadId, leadId));
  return row!;
}

const summary = async (who: { cookies: Record<string, string> }) => {
  const response = await app.inject({ url: '/whatsapp/inbox/summary', cookies: who.cookies });
  expect(response.statusCode).toBe(200);
  return response.json<{ unread: number; stamp: string }>();
};

const search = async (cookies: Record<string, string>, q: string) => {
  const response = await app.inject({
    url: `/whatsapp/conversations?q=${encodeURIComponent(q)}`,
    cookies,
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ conversations: WaConversationItem[] }>().conversations;
};

const read = (cookies: Record<string, string>, conversationId: string) =>
  app.inject({ method: 'POST', url: `/whatsapp/conversations/${conversationId}/read`, cookies });

describe('the unread count on the menu', () => {
  it("counts the reader's conversations with a message not opened, by reach and per reader", async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const admin = await sessionFor('admin_master');
    const before = await summary(admin);

    const mine = newPhone();
    const lead = await deal(mine, seller.id);
    await write(mine, 'oi');
    await write(mine, 'tem alguém aí?');
    // No deal yet: only a full-scope reader reaches it.
    await write(newPhone(), 'bom dia');

    expect((await summary(seller)).unread).toBe(1);
    expect((await summary(other)).unread).toBe(0);
    expect((await summary(admin)).unread).toBe(before.unread + 2);

    // Opening it clears it for that reader only.
    const conversation = await conversationOfLead(lead);
    expect((await read(seller.cookies, conversation.id)).statusCode).toBe(204);
    expect((await summary(seller)).unread).toBe(0);
    expect((await summary(admin)).unread).toBe(before.unread + 2);

    // A new message counts again.
    await write(mine, '?');
    expect((await summary(seller)).unread).toBe(1);
  });

  it('a reply of ours counts as read for a reader who never opened it, as on the list', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const phone = newPhone();
    const lead = await deal(phone, seller.id);
    await write(phone, 'quero saber o preço');
    expect((await summary(seller)).unread).toBe(1);
    const conversation = await conversationOfLead(lead);
    await db.insert(waMessages).values({
      conversationId: conversation.id,
      contactId: conversation.contactId,
      leadId: lead,
      direction: 'out',
      author: 'employee',
      kind: 'text',
      text: 'Olá! Já te passo.',
      status: 'sent',
    });
    expect((await summary(seller)).unread).toBe(0);
  });

  it('moves the stamp when a message comes or the reader opens it, and only then', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const phone = newPhone();
    const lead = await deal(phone, seller.id);
    const first = await summary(seller);
    const otherFirst = await summary(other);
    expect(await summary(seller)).toEqual(first);

    await write(phone, 'oi');
    const second = await summary(seller);
    expect(second.stamp).not.toBe(first.stamp);
    // Another seller's stamp says nothing of this one's conversations.
    expect(await summary(other)).toEqual(otherFirst);

    await read(seller.cookies, (await conversationOfLead(lead)).id);
    expect((await summary(seller)).stamp).not.toBe(second.stamp);
  });

  it('is refused without the WhatsApp permission', async () => {
    const outsider = await sessionFor('marketing');
    const response = await app.inject({
      url: '/whatsapp/inbox/summary',
      cookies: outsider.cookies,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the search inside the messages', () => {
  it("finds a conversation by a message's text, with the message cut around the term", async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const phone = newPhone();
    await deal(phone, seller.id, 'Rita Moura');
    await write(phone, 'Bom dia! Vocês fazem a formatação de franquia de padaria em Niterói?');
    await write(phone, 'Aguardo o retorno.');
    const found = await search(seller.cookies, 'PADARIA');
    expect(found).toHaveLength(1);
    expect(found[0]!.match?.text).toContain('padaria');
    expect(found[0]!.preview).toBe('Aguardo o retorno.');
    // A search by the name alone brings no message.
    expect((await search(seller.cookies, 'Rita Moura'))[0]?.match).toBeNull();
  });

  it("never finds what is beyond the reader's reach", async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const admin = await sessionFor('admin_master');
    const phone = newPhone();
    await deal(phone, seller.id);
    await write(phone, 'meu orçamento é de cento e vinte mil zebrinhas');
    await write(newPhone(), 'sem negociação ainda: zebrinhas');

    expect(await search(other.cookies, 'zebrinhas')).toEqual([]);
    expect((await search(seller.cookies, 'zebrinhas')).map((c) => c.leadId !== null)).toEqual([
      true,
    ]);
    expect(await search(admin.cookies, 'zebrinhas')).toHaveLength(2);
  });

  it('looks inside the messages only from three letters, and takes % and _ as typed', async () => {
    const admin = await sessionFor('admin_master');
    const phone = newPhone();
    await deal(phone, null, 'Cliente Sem Dono');
    await write(phone, 'desconto de 15% no xy');
    expect(await search(admin.cookies, 'xy')).toEqual([]);
    expect((await search(admin.cookies, '15%')).map((c) => c.match?.text)).toEqual([
      'desconto de 15% no xy',
    ]);
    expect(await search(admin.cookies, '1_%')).toEqual([]);
  });

  it('does not take a reaction for a message', async () => {
    const admin = await sessionFor('admin_master');
    const phone = newPhone();
    await deal(phone, null);
    const wamid = await write(phone, 'texto qualquer');
    await write(phone, '', { type: 'reaction', reaction: { message_id: wamid, emoji: '🦒🦒🦒' } });
    expect(await search(admin.cookies, '🦒🦒🦒')).toEqual([]);
  });
});

describe('snippetOf', () => {
  it('keeps a short message whole and cuts a long one around the term', () => {
    expect(snippetOf('  oi,\n tudo bem? ', 'tudo')).toBe('oi, tudo bem?');
    const long = `${'a'.repeat(100)} palavra ${'b'.repeat(100)}`;
    const cut = snippetOf(long, 'PALAVRA', 40);
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toContain('palavra');
    expect(cut.length).toBe(42);
    // A term not found (a case the database folds differently) starts at the beginning.
    expect(snippetOf(long, 'zzz', 10)).toBe(`${'a'.repeat(10)}…`);
  });
});
