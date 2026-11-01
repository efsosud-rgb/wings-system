import { createHmac } from 'node:crypto';
import { SESSION_COOKIE, SOFIA_DEFAULT_SETTINGS, type Actor, type RoleKey } from '@wings/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  crmDistributionMembers,
  waContacts,
  waConversations,
  waMessages,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { AgentLlm } from '../agent/llm.js';
import { takeOver } from '../whatsapp/attendance.js';
import { whatsappConfigOf } from '../whatsapp/graph.js';
import { processWhatsAppEvents } from '../whatsapp/intake.js';
import { runDueSofiaTurns, type SofiaDeps } from './engine.js';
import { saveSofiaSettings } from './settings.js';

/**
 * The races between a person and the Sofia found by the 27/10 audit (WA-01 and WA-02,
 * `/opt/auditoria-integral/achados/whatsapp-sofia.md`, tests R1 and R2): whoever takes the
 * conversation keeps it, and the Sofia stays quiet. Meta and the model are simulated.
 */

const APP_SECRET = 'whatsapp-app-secret-for-tests';
const VERIFY = 'whatsapp-verify-token-long-enough';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';
// A Wednesday, 12:00 in São Paulo: inside office hours.
const NOW = new Date('2026-10-07T15:00:00Z');
const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let env: ReturnType<typeof loadEnv>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let sent = 0;
/** A send with this text waits "at Meta" until the gate opens. */
let hold: { text: string; reached: () => void; gate: Promise<void> } | null = null;
const whatsappFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.pathname.endsWith(`/${PHONE_ID}/messages`)) {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const textBody = (payload.text as { body?: string } | undefined)?.body;
    if (hold && textBody === hold.text) {
      hold.reached();
      await hold.gate;
    }
    return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.RACE${++sent}` }] });
  }
  if (url.pathname.endsWith(`/${PHONE_ID}/settings`))
    return json({ calling: { status: 'DISABLED' } });
  return json({ error: { code: 100, message: 'unknown path' } }, 400);
}) as typeof fetch;

let llmAnswers: Record<string, unknown>[] = [];
const llm: AgentLlm = {
  async complete() {
    const next = llmAnswers.shift();
    if (!next) throw new Error('no scripted answer');
    return {
      text: '',
      toolCalls: [{ id: 'c1', name: 'sofia_turn', arguments: JSON.stringify(next) }],
      usage: { inputTokens: 900, outputTokens: 60, costUsd: 0.0001 },
      finishReason: 'tool_calls',
    };
  },
};
const said = (over: Record<string, unknown>) => ({
  intent: 'indefinido',
  answers: {},
  understood: true,
  asked_values: false,
  brand: null,
  reply: '',
  ...over,
});

let clock = NOW.getTime();
const deps = (): SofiaDeps => ({
  db,
  llm,
  fetchImpl: whatsappFetch,
  config: whatsappConfigOf(env),
  dailyUsd: 1,
  now: () => new Date(clock),
  log: () => {},
});

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY,
    WHATSAPP_ACCESS_TOKEN: 'fake-whatsapp-token',
    WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
    WHATSAPP_WABA_ID: WABA,
  });
  app = await buildApp({ env, db, now: () => new Date(clock), whatsappFetch });
  const seller = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
  await db
    .insert(crmDistributionMembers)
    .values([{ pipeline: 'formatacao', employeeId: seller.id }]);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(async () => {
  llmAnswers = [];
  hold = null;
  clock = NOW.getTime();
  await saveSofiaSettings(db, { ...SOFIA_DEFAULT_SETTINGS, enabled: true }, null, NOW);
  await db.update(waConversations).set({ sofiaDueAt: null });
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

const sign = (raw: string) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

let seq = 0;
let phoneSeq = 0;
const newPhone = () => `55219${String(80000000 + ++phoneSeq).padStart(8, '0')}`;

function body(from: string, message: Record<string, unknown>) {
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
              metadata: { display_phone_number: '15556696643', phone_number_id: PHONE_ID },
              contacts: [{ profile: { name: 'Pessoa Teste' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.RIN${++seq}`,
                  timestamp: unix(new Date(clock - 1_000)),
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  });
}
const text = (t: string) => ({ type: 'text', text: { body: t } });
const tap = (id: string) => ({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id, title: 'x' } },
});

/** The webhook only: the signed body is stored, the queue has not read it yet. */
async function deliver(payload: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/integrations/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) },
    payload,
  });
  expect(res.statusCode).toBe(200);
}
const intake = () =>
  processWhatsAppEvents({ db, phoneNumberId: PHONE_ID, log: () => {}, now: () => new Date(clock) });
async function write(from: string, message: Record<string, unknown>) {
  await deliver(body(from, message));
  await intake();
}
const conversationOf = async (phone: string) =>
  (
    await db
      .select()
      .from(waConversations)
      .innerJoin(waContacts, eq(waContacts.id, waConversations.contactId))
      .where(eq(waContacts.phone, phone))
  )[0]!.wa_conversations;
const sofiaMessages = async (conversationId: string) =>
  (
    await db
      .select({ id: waMessages.id })
      .from(waMessages)
      .where(and(eq(waMessages.conversationId, conversationId), eq(waMessages.author, 'sofia')))
  ).length;

/** Waits until another connection is blocked on a row lock. */
async function untilSomeoneWaitsOnALock() {
  for (let i = 0; i < 250; i++) {
    const { rows } = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('nobody waited on the lock');
}

describe('Sofia and a person on the same conversation (WA-01, WA-02)', () => {
  it('a message arriving while a person takes the conversation does not give it back to the Sofia', async () => {
    // A conversation that waited because the Sofia was off; now she is on.
    await saveSofiaSettings(db, SOFIA_DEFAULT_SETTINGS, null, NOW);
    const admin = await sessionFor('admin_master');
    const phone = newPhone();
    await write(phone, text('oi, alguém?'));
    const conversation = await conversationOf(phone);
    expect(conversation).toMatchObject({ attendance: 'waiting_human', reason: 'sofia_desligada' });
    await saveSofiaSettings(db, { ...SOFIA_DEFAULT_SETTINGS, enabled: true }, null, NOW);

    await deliver(body(phone, text('tô esperando')));
    // At the same moment a person clicks "Assumir": the row is theirs until it is written.
    let reading: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from wa_conversations where id = ${conversation.id} for update`,
      );
      reading = intake();
      await untilSomeoneWaitsOnALock();
      await takeOver(tx as unknown as Database, {
        conversationId: conversation.id,
        version: null,
        actor: { employeeId: admin.id } as Actor,
        at: new Date(clock),
      });
    });
    await reading;
    const attendance = (await conversationOf(phone)).attendance;
    llmAnswers = [said({ intent: 'indefinido' })];
    clock += 5_000;
    await runDueSofiaTurns(deps());

    expect({ attendance, sofiaSent: await sofiaMessages(conversation.id) }).toEqual({
      attendance: 'with_person',
      sofiaSent: 0,
    });
  });

  it('a person writing from the screen stops the Sofia before the message leaves', async () => {
    const admin = await sessionFor('admin_master');
    const phone = newPhone();
    llmAnswers = [said({ intent: 'indefinido' })];
    await write(phone, text('oi'));
    clock += 5_000;
    await runDueSofiaTurns(deps());
    const conversation = await conversationOf(phone);
    const sofiaBefore = await sofiaMessages(conversation.id);
    // The lead taps "Franquear negócio": the Sofia's turn falls due in 4 s.
    await write(phone, tap('sofia:formatacao'));
    clock += 5_000;

    // A person answers from the screen while Meta is slow to answer that send.
    const words = 'Oi! Aqui é a Diretoria, eu sigo com você.';
    let release!: () => void;
    let reached!: () => void;
    const atMeta = new Promise<void>((resolve) => (reached = resolve));
    hold = { text: words, reached, gate: new Promise<void>((resolve) => (release = resolve)) };
    const sending = app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/text`,
      cookies: admin.cookies,
      payload: { text: words },
    });
    await atMeta;
    // The Sofia's loop runs while the person's message is at Meta (every 2 s in production).
    await runDueSofiaTurns(deps());
    release();
    expect((await sending).statusCode).toBe(201);

    expect({
      sofiaSentMeanwhile: (await sofiaMessages(conversation.id)) - sofiaBefore,
      attendance: (await conversationOf(phone)).attendance,
    }).toEqual({ sofiaSentMeanwhile: 0, attendance: 'with_person' });
  });
});
