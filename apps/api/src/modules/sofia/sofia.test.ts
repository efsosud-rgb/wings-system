import { createHmac } from 'node:crypto';
import {
  SESSION_COOKIE,
  SOFIA_DEFAULT_SETTINGS,
  sofiaWords,
  WINGS_CLIENT_ID,
  type RoleKey,
  type SofiaConversationDetail,
  type SofiaSettings,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  clients,
  crmContacts,
  crmDistributionMembers,
  crmNotifications,
  leadContacts,
  leadEvents,
  leadTasks,
  leadTrackingLinks,
  leads,
  sofiaAiRuns,
  waTemplates,
  waContacts,
  waConversations,
  waMessages,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  createEmployee,
  setOfficialLive,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import type { AgentLlm, LlmRequest } from '../agent/llm.js';
import { whatsappConfigOf } from '../whatsapp/graph.js';
import { processWhatsAppEvents } from '../whatsapp/intake.js';
import { guardReply } from './brain.js';
import { nameFrom, runDueSofiaTurns, type SofiaDeps } from './engine.js';
import { saveSofiaSettings } from './settings.js';

/**
 * Sofia against a simulated Meta and a scripted model: she answers a new
 * conversation as Wings' virtual assistant, asks the Formatação questions one
 * at a time (buttons, lists and the name without the AI), creates the deal in
 * the funnel's rotation and hands it over; a deal with an owner goes straight
 * to the owner; a person can take the conversation and give it back; asking
 * for a person, SAIR, an AI failure and the daily ceiling each end as the
 * rules say. No test reaches the network, and the model never sees the name.
 */

const APP_SECRET = 'whatsapp-app-secret-for-tests';
const VERIFY = 'whatsapp-verify-token-long-enough';
const TOKEN = 'fake-whatsapp-token';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';
// A Wednesday, 12:00 in São Paulo: inside business hours.
const NOW = new Date('2026-10-07T15:00:00Z');
const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let env: ReturnType<typeof loadEnv>;
let formatSeller: string;
let expansionSeller: string;
let brandId: string;

const sends: Record<string, unknown>[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let sent = 0;
const whatsappFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.pathname.endsWith(`/${PHONE_ID}/messages`)) {
    sends.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.SOFIA${++sent}` }] });
  }
  if (url.pathname.endsWith(`/${PHONE_ID}/settings`))
    return json({ calling: { status: 'DISABLED' } });
  return json({ error: { code: 100, message: 'unknown path' } }, 400);
}) as typeof fetch;

/** The model, scripted: each call takes the next answer (or throws). */
const llmCalls: LlmRequest[] = [];
let llmAnswers: (Record<string, unknown> | Error)[] = [];
const llm: AgentLlm = {
  async complete(request) {
    llmCalls.push(request);
    const next = llmAnswers.shift();
    if (!next) throw new Error('no scripted answer');
    if (next instanceof Error) throw next;
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
    WHATSAPP_ACCESS_TOKEN: TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
    WHATSAPP_WABA_ID: WABA,
  });
  app = await buildApp({ env, db, now: () => new Date(clock), whatsappFetch });
  formatSeller = (await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' }))
    .id;
  expansionSeller = (await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' }))
    .id;
  await db.insert(crmDistributionMembers).values([
    { pipeline: 'formatacao', employeeId: formatSeller },
    { pipeline: 'expansao', employeeId: expansionSeller },
  ]);
  const [brand] = await db
    .insert(clients)
    .values({ name: 'Casa do Churros', slug: 'casa-do-churros' })
    .returning();
  brandId = brand!.id;
  await db
    .insert(leadTrackingLinks)
    .values({ clientId: brandId, channel: 'site', code: 'WCHUR2', phone: '5521999470288' });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(async () => {
  sends.length = 0;
  llmCalls.length = 0;
  llmAnswers = [];
  clock = NOW.getTime();
  await saveSofiaSettings(db, { ...SOFIA_DEFAULT_SETTINGS, enabled: true }, null, NOW);
  // A turn left waiting by an earlier test is not this test's.
  await db.update(waConversations).set({ sofiaDueAt: null });
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

const sign = (body: string) =>
  `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;

let seq = 0;
let phoneSeq = 0;
const newPhone = () => `55219${String(80000000 + ++phoneSeq).padStart(8, '0')}`;

/** Meta's shape of an incoming message: text, a button tap or a list choice. */
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
              contacts: [{ profile: { name: 'Elena' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.IN${++seq}`,
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
const tap = (id: string, title = 'x') => ({
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id, title } },
});
const pick = (id: string, title = 'x') => ({
  type: 'interactive',
  interactive: { type: 'list_reply', list_reply: { id, title } },
});

/** The person writes; the webhook stores it, the queue reads it, Sofia answers after the quiet time. */
async function write(from: string, message: Record<string, unknown>) {
  const payload = body(from, message);
  const res = await app.inject({
    method: 'POST',
    url: '/integrations/whatsapp/webhook',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) },
    payload,
  });
  expect(res.statusCode).toBe(200);
  await processWhatsAppEvents({
    db,
    phoneNumberId: PHONE_ID,
    log: () => {},
    now: () => new Date(clock),
  });
}
async function sofiaAnswers() {
  clock += 5_000;
  return runDueSofiaTurns(deps());
}
const conversationOf = async (phone: string) =>
  (
    await db
      .select()
      .from(waConversations)
      .innerJoin(waContacts, eq(waContacts.id, waConversations.contactId))
      .where(eq(waContacts.phone, phone))
  )[0]!.wa_conversations;
/** The part of a sent message the tests read. */
interface Sent {
  type: string;
  text: { body: string };
  interactive: {
    type: string;
    body: { text: string };
    action: {
      buttons: { reply: { title: string } }[];
      sections: { rows: { id: string; title: string }[] }[];
    };
  };
}
const lastSent = () => sends[sends.length - 1] as unknown as Sent;
const bodyOf = (m: Sent) => (m.type === 'text' ? m.text.body : m.interactive.body.text);

describe('Sofia, Formatação from first message to the seller', () => {
  it('introduces herself, asks one question at a time and hands a Formatação deal to the rotation', async () => {
    const phone = newPhone();
    await write(phone, text('oi'));
    llmAnswers = [said({ intent: 'indefinido' })];
    expect(await sofiaAnswers()).toBe(1);

    // First words: who she is, then the objective with three buttons.
    let out = lastSent();
    expect(out.type).toBe('interactive');
    expect(out.interactive.type).toBe('button');
    expect(bodyOf(out)).toContain('atendente virtual da Wings');
    expect(out.interactive.action.buttons.map((b) => b.reply.title)).toEqual([
      'Franquear negócio',
      'Abrir uma franquia',
      'Outro assunto',
    ]);
    expect((await conversationOf(phone)).attendance).toBe('sofia');

    // The button: no AI; the name comes next.
    await write(phone, tap('sofia:formatacao', 'Franquear negócio'));
    await sofiaAnswers();
    expect(llmCalls).toHaveLength(1);
    expect(bodyOf(lastSent())).toBe('Para começar, qual é o seu nome?');

    // The name is taken as written and never goes to the AI.
    await write(phone, text('Meu nome é Ana Paula'));
    await sofiaAnswers();
    expect(llmCalls).toHaveLength(1);
    expect(bodyOf(lastSent())).toBe('Qual é o nome da sua empresa?');

    llmAnswers = [
      said({ intent: 'formatacao', answers: { empresa: 'Burger da Ana' }, reply: 'Que legal!' }),
    ];
    await write(phone, text('Burger da Ana'));
    await sofiaAnswers();
    out = lastSent();
    expect(out.interactive.type).toBe('list');
    expect(bodyOf(out)).toBe('Que legal!\n\nEm qual segmento ela atua?');
    expect(out.interactive.action.sections[0]!.rows[0]).toEqual({
      id: 'sofia:q:segmento:0',
      title: 'Alimentação',
    });

    await write(phone, pick('sofia:q:segmento:0', 'Alimentação'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toBe('Em qual cidade e estado ela fica?');

    llmAnswers = [said({ intent: 'formatacao', answers: { cidade: 'Niterói, RJ' } })];
    await write(phone, text('Niterói, RJ'));
    await sofiaAnswers();
    expect(lastSent().interactive.type).toBe('list');

    await write(phone, pick('sofia:q:faturamento:2'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toContain('Instagram');
    await write(phone, text('não tenho'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toContain('site');
    await write(phone, text('não tenho'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toContain('como você conheceu a Wings');
    expect(llmCalls).toHaveLength(3);

    await write(phone, pick('sofia:q:origem:0', 'Instagram'));
    await sofiaAnswers();

    // The deal: Formatação, the rotation's seller, the answers on it.
    const conversation = await conversationOf(phone);
    expect(conversation.attendance).toBe('waiting_seller');
    const [lead] = await db.select().from(leads).where(eq(leads.id, conversation.leadId!));
    expect(lead).toMatchObject({
      pipeline: 'formatacao',
      ownerEmployeeId: formatSeller,
      name: 'Ana Paula',
      source: 'whatsapp',
      clientId: WINGS_CLIENT_ID,
      city: 'Niterói, RJ',
    });
    expect(lead!.formAnswers).toMatchObject({
      Empresa: 'Burger da Ana',
      Segmento: 'Alimentação',
      'Faturamento mensal': 'R$ 100 mil a 300 mil',
      Instagram: 'Não tem',
      'Como conheceu a Wings': 'Instagram',
    });
    expect(bodyOf(lastSent())).toContain('consultor da Wings');
    const tasks = await db.select().from(leadTasks).where(eq(leadTasks.leadId, lead!.id));
    expect(
      tasks.some((t) => t.kind === 'first_contact' && t.assigneeEmployeeId === formatSeller),
    ).toBe(true);
    const notice = await db
      .select()
      .from(crmNotifications)
      .where(and(eq(crmNotifications.leadId, lead!.id), eq(crmNotifications.kind, 'new_lead')));
    expect(notice[0]?.recipientEmployeeId).toBe(formatSeller);
    const messages = await db
      .select()
      .from(waMessages)
      .where(eq(waMessages.conversationId, conversation.id));
    expect(messages.every((m) => m.leadId === lead!.id)).toBe(true);
    expect(messages.filter((m) => m.author === 'sofia').length).toBeGreaterThanOrEqual(9);

    // The model never saw the name, the profile name or the phone.
    const seen = JSON.stringify(llmCalls.map((c) => c.messages));
    expect(seen).not.toContain('Ana Paula');
    expect(seen).not.toContain('Elena');
    expect(seen).not.toContain(phone);
    expect(
      llmCalls.every((c) => c.model === 'deepseek/deepseek-v4-flash' && c.noDataCollection),
    ).toBe(true);

    // Each call is in the ledger, at its real cost.
    const runs = await db.select().from(sofiaAiRuns);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.every((r) => r.costMicroUsd === 100 && r.outcome === 'ok')).toBe(true);

    // After the handover Sofia stays quiet: the seller has it.
    await write(phone, text('obrigada!'));
    expect(await sofiaAnswers()).toBe(0);
  });

  it('a burst of messages gets one answer, after the quiet time', async () => {
    const phone = newPhone();
    await write(phone, text('oi'));
    await write(phone, text('tudo bem?'));
    llmAnswers = [said({ intent: 'indefinido' })];
    clock += 1_000;
    expect(await runDueSofiaTurns(deps())).toBe(0); // not quiet yet
    expect(await sofiaAnswers()).toBe(1);
    expect(sends).toHaveLength(1);
    expect(await sofiaAnswers()).toBe(0);
  });

  it('understands the objective in free text and skips the buttons', async () => {
    const phone = newPhone();
    llmAnswers = [said({ intent: 'formatacao' })];
    await write(phone, text('Quero transformar minha hamburgueria em franquia'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toBe(
      `${sofiaWords(SOFIA_DEFAULT_SETTINGS.texts.greeting, null)}\n\nPara começar, qual é o seu nome?`,
    );
  });

  it('answers a question about prices with the fixed line, never with the model’s numbers', async () => {
    const phone = newPhone();
    llmAnswers = [
      said({ intent: 'formatacao', asked_values: true, reply: 'Custa R$ 50 mil de taxa.' }),
    ];
    await write(phone, text('quanto custa franquear?'));
    await sofiaAnswers();
    const words = bodyOf(lastSent());
    expect(words).not.toContain('R$');
    expect(words).toContain(SOFIA_DEFAULT_SETTINGS.texts.values);
  });
});

describe('who answers', () => {
  it('a phone whose open deal has an owner goes straight to the owner, with no Sofia', async () => {
    const phone = newPhone();
    await db.insert(leads).values({
      source: 'manual',
      name: 'Lead com dono',
      phone,
      pipeline: 'formatacao',
      ownerEmployeeId: formatSeller,
    });
    await write(phone, text('oi, sou eu de novo'));
    expect((await conversationOf(phone)).attendance).toBe('waiting_seller');
    expect(await sofiaAnswers()).toBe(0);
    expect(sends).toHaveLength(0);
  });

  it('with Sofia off a new conversation waits for a person and nothing is sent', async () => {
    await saveSofiaSettings(db, SOFIA_DEFAULT_SETTINGS, null, NOW);
    const phone = newPhone();
    await write(phone, text('oi'));
    const conversation = await conversationOf(phone);
    expect(conversation).toMatchObject({ attendance: 'waiting_human', reason: 'sofia_desligada' });
    expect(await sofiaAnswers()).toBe(0);
    expect(sends).toHaveLength(0);
  });

  it('asking for a person hands over without a deal, and tells the team', async () => {
    const admin = await sessionFor('admin_master');
    const phone = newPhone();
    llmAnswers = [said({ intent: 'quer_pessoa' })];
    await write(phone, text('quero falar com um atendente humano'));
    await sofiaAnswers();
    const conversation = await conversationOf(phone);
    expect(conversation).toMatchObject({ attendance: 'waiting_human', reason: 'quer_pessoa' });
    expect(conversation.leadId).toBeNull();
    expect(bodyOf(lastSent())).toContain('atendente virtual da Wings');
    expect(bodyOf(lastSent())).toContain(SOFIA_DEFAULT_SETTINGS.texts.handoffHuman);
    const notices = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.recipientEmployeeId, admin.id));
    expect(notices.some((n) => n.kind === 'sofia_handoff')).toBe(true);
  });

  it('not understanding twice hands over to a person', async () => {
    const phone = newPhone();
    llmAnswers = [said({ intent: 'indefinido' })];
    await write(phone, text('oi'));
    await sofiaAnswers();
    llmAnswers = [said({ intent: 'indefinido', understood: false })];
    await write(phone, text('asdfgh'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toContain(SOFIA_DEFAULT_SETTINGS.texts.notUnderstood);
    llmAnswers = [said({ intent: 'indefinido', understood: false })];
    await write(phone, text('qwerty'));
    await sofiaAnswers();
    expect(await conversationOf(phone)).toMatchObject({
      attendance: 'waiting_human',
      reason: 'nao_entendeu',
    });
  });

  it('SAIR confirms, closes and blocks active messages, without the AI', async () => {
    const phone = newPhone();
    await write(phone, text('SAIR'));
    await sofiaAnswers();
    expect(llmCalls).toHaveLength(0);
    expect(bodyOf(lastSent())).toBe(SOFIA_DEFAULT_SETTINGS.texts.optOut);
    expect(await conversationOf(phone)).toMatchObject({
      attendance: 'closed',
      reason: 'nao_contatar',
    });
    const [contact] = await db.select().from(waContacts).where(eq(waContacts.phone, phone));
    expect(contact!.optOutAt).not.toBeNull();
  });

  it('an AI failure sends the fixed line and a person takes over', async () => {
    const phone = newPhone();
    llmAnswers = [new Error('provider down')];
    await write(phone, text('olá, boa tarde'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toContain(SOFIA_DEFAULT_SETTINGS.texts.aiDown);
    expect(await conversationOf(phone)).toMatchObject({
      attendance: 'waiting_human',
      reason: 'ia_indisponivel',
    });
    // The failed call still counts at its reservation.
    const [run] = await db.select().from(sofiaAiRuns).where(eq(sofiaAiRuns.outcome, 'failed'));
    expect(run?.costMicroUsd).toBeNull();
  });

  it('past the daily ceiling no AI call is made and a person takes over', async () => {
    await db.insert(sofiaAiRuns).values({
      startedAt: new Date(clock),
      model: 'deepseek/deepseek-v4-flash',
      promptVersion: 'x',
      reservedMicroUsd: 10_000,
      costMicroUsd: 1_000_000,
    });
    const phone = newPhone();
    await write(phone, text('oi'));
    await sofiaAnswers();
    expect(llmCalls).toHaveLength(0);
    expect(await conversationOf(phone)).toMatchObject({ reason: 'teto_diario' });
    await db.delete(sofiaAiRuns).where(eq(sofiaAiRuns.costMicroUsd, 1_000_000));
  });

  it('a seller writing takes the conversation; giving it back wakes Sofia on the next message', async () => {
    const admin = await sessionFor('admin_master');
    const phone = newPhone();
    llmAnswers = [said({ intent: 'indefinido' })];
    await write(phone, text('oi'));
    await sofiaAnswers();
    const conversation = await conversationOf(phone);
    const send = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/text`,
      cookies: admin.cookies,
      payload: { text: 'Olá, aqui é a Diretoria.' },
    });
    expect(send.statusCode).toBe(201);
    expect((await conversationOf(phone)).attendance).toBe('with_person');
    await write(phone, text('ah, oi!'));
    expect(await sofiaAnswers()).toBe(0);

    const back = await app.inject({
      method: 'POST',
      url: `/sofia/conversations/${conversation.id}/attendance`,
      cookies: admin.cookies,
      payload: { action: 'give_back' },
    });
    expect(back.json()).toEqual({ state: 'sofia' });
    expect(await sofiaAnswers()).toBe(0); // nothing new from the person yet
    await write(phone, tap('sofia:formatacao'));
    expect(await sofiaAnswers()).toBe(1);
    expect(bodyOf(lastSent())).toBe('Para começar, qual é o seu nome?');
  });
});

describe('the screen and the settings', () => {
  it('a seller cannot change the settings; Diretoria can, and the change is audited', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const board = await sessionFor('diretoria');
    const next: SofiaSettings = { ...SOFIA_DEFAULT_SETTINGS, enabled: false };
    const denied = await app.inject({
      method: 'PUT',
      url: '/sofia/settings',
      cookies: seller.cookies,
      payload: next,
    });
    expect(denied.statusCode).toBe(403);
    const bad = await app.inject({
      method: 'PUT',
      url: '/sofia/settings',
      cookies: board.cookies,
      payload: { ...next, texts: { ...next.texts, greeting: 'Oi! Eu sou a Sofia.' } },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'PUT',
      url: '/sofia/settings',
      cookies: board.cookies,
      payload: next,
    });
    expect(ok.statusCode).toBe(200);
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sofia.disabled'), eq(auditLog.actorEmployeeId, board.id)));
    expect(entry).toBeTruthy();
  });

  it('shows what Sofia found out; the screen is closed to a seller (Eric, 13/10)', async () => {
    const admin = await sessionFor('admin_master');
    const seller = await sessionFor('vendedor_formatacao');
    const phone = newPhone();
    await write(phone, tap('sofia:formatacao'));
    await sofiaAnswers();
    await write(phone, text('Joana'));
    await sofiaAnswers();
    const conversation = await conversationOf(phone);
    const detail = await app.inject({
      method: 'GET',
      url: `/sofia/conversations/${conversation.id}`,
      cookies: admin.cookies,
    });
    const data = detail.json<SofiaConversationDetail>();
    expect(data.item).toMatchObject({ state: 'sofia', segment: 'formatacao' });
    expect(data.facts).toEqual([{ key: 'nome', label: 'Nome', answer: 'Joana' }]);
    expect(data.thread.messages.some((m) => m.bySofia)).toBe(true);
    expect(data.can).toMatchObject({ take: true, close: true });

    // The screen with every conversation is for Gerente Comercial, Diretoria and
    // Admin Master; a seller talks to their own leads from the deal and the inbox.
    for (const url of [
      `/sofia/conversations/${conversation.id}`,
      '/sofia/conversations',
      '/sofia/overview',
    ]) {
      const refused = await app.inject({ method: 'GET', url, cookies: seller.cookies });
      expect(refused.statusCode, url).toBe(403);
    }
  });
});

describe('a tracking link', () => {
  it('with Sofia on, counts the click and leaves the deal to her; off, makes the lead at once as before', async () => {
    const [before] = await db
      .select()
      .from(leadTrackingLinks)
      .where(eq(leadTrackingLinks.code, 'WCHUR2'));
    const phone = newPhone();
    await write(phone, text('WCHUR2 Olá! Quero saber da franquia Casa do Churros.'));
    const on = await conversationOf(phone);
    expect(on).toMatchObject({
      attendance: 'sofia',
      segment: 'expansao',
      brandClientId: brandId,
    });
    expect(on.leadId).toBeNull();
    const [link] = await db
      .select()
      .from(leadTrackingLinks)
      .where(eq(leadTrackingLinks.code, 'WCHUR2'));
    expect(link!.hits).toBe(before!.hits + 1);

    await saveSofiaSettings(db, SOFIA_DEFAULT_SETTINGS, null, NOW);
    const other = newPhone();
    await write(other, text('WCHUR2 Olá! Quero saber da franquia Casa do Churros.'));
    const off = await conversationOf(other);
    expect(off.leadId).not.toBeNull();
  });
});

describe('a franchise lead never hears of Wings (Eric, 07/10)', () => {
  /** Every word Sofia sent in a conversation. */
  const sofiaWordsIn = async (conversationId: string) =>
    (
      await db
        .select({ text: waMessages.text })
        .from(waMessages)
        .where(and(eq(waMessages.conversationId, conversationId), eq(waMessages.author, 'sofia')))
    ).map((m) => m.text ?? '');

  it('a brand link: she speaks for the brand’s expansion team and hands an Expansão deal with the brand', async () => {
    const phone = newPhone();
    const from = sends.length;
    llmAnswers = [said({ intent: 'expansao' })];
    await write(phone, text('WCHUR2 Olá! Quero saber da franquia Casa do Churros.'));
    await sofiaAnswers();
    let out = lastSent();
    expect(bodyOf(out)).toContain('atendente virtual do time de expansão da Casa do Churros');
    expect(bodyOf(out)).toContain('Vi que você se interessou pela franquia Casa do Churros');
    expect(out.interactive.action.buttons.map((b) => b.reply.title)).toEqual([
      'Sim',
      'Outra marca',
      'Outro assunto',
    ]);

    await write(phone, tap('sofia:marca-sim', 'Sim'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toBe('Qual é o seu nome?');
    await write(phone, text('Carlos Lima'));
    await sofiaAnswers();
    llmAnswers = [
      said({
        intent: 'expansao',
        answers: { cidade: 'Campinas, SP' },
        reply: 'A Wings agradece!',
      }),
    ];
    await write(phone, text('Campinas, SP'));
    await sofiaAnswers();
    out = lastSent();
    // The model's line named Wings: dropped, only the question went.
    expect(bodyOf(out)).toBe('Quanto você pretende investir?');
    await write(phone, pick('sofia:q:investimento:1'));
    await sofiaAnswers();
    await write(phone, pick('sofia:q:prazo:0'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toBe('Por último: como você chegou até nós?');
    await write(phone, pick('sofia:q:origem:0'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toContain('consultor do time de expansão da Casa do Churros');

    const conversation = await conversationOf(phone);
    expect(conversation.attendance).toBe('waiting_seller');
    const [lead] = await db.select().from(leads).where(eq(leads.id, conversation.leadId!));
    expect(lead).toMatchObject({
      pipeline: 'expansao',
      clientId: brandId,
      brand: 'Casa do Churros',
      ownerEmployeeId: expansionSeller,
      source: 'whatsapp_link',
      name: 'Carlos Lima',
    });
    // Not one word about Wings, in what was stored or what went to Meta.
    const words = await sofiaWordsIn(conversation.id);
    expect(words.length).toBeGreaterThanOrEqual(7);
    expect(words.some((w) => /wings/i.test(w))).toBe(false);
    expect(JSON.stringify(sends.slice(from))).not.toMatch(/wings/i);
    // The model was told whom she speaks for.
    expect(JSON.stringify(llmCalls.at(-1)?.messages)).toContain(
      'time de expansão da Casa do Churros',
    );
  });

  it('Formatação and an unknown origin speak for Wings Company, until the brand is known', async () => {
    const phone = newPhone();
    await write(phone, tap('sofia:expansao', 'Abrir uma franquia'));
    await sofiaAnswers();
    expect(bodyOf(lastSent())).toContain('atendente virtual da Wings Company');
    expect(bodyOf(lastSent())).toContain(SOFIA_DEFAULT_SETTINGS.texts.brandQuestion);

    llmAnswers = [said({ intent: 'expansao', brand: 'casa do churros' })];
    await write(phone, text('a casa do churros'));
    await sofiaAnswers();
    const conversation = await conversationOf(phone);
    expect(conversation.brandClientId).toBe(brandId);
    // From here on she is the brand's: the next question carries no Wings.
    expect(bodyOf(lastSent())).toBe('Qual é o seu nome?');
    const thread = await app.inject({
      method: 'GET',
      url: `/sofia/conversations/${conversation.id}`,
      cookies: (await sessionFor('admin_master')).cookies,
    });
    expect(thread.json<SofiaConversationDetail>().thread.speaksFor).toBe('Casa do Churros');
  });

  it('the seller of a brand deal cannot send a text or a template that names Wings', async () => {
    await setOfficialLive(db, true); // a seller sends only once the official number is live
    const seller = await sessionFor('vendedor_expansao');
    const phone = newPhone();
    const [lead] = await db
      .insert(leads)
      .values({
        source: 'manual',
        name: 'Lead da marca',
        phone,
        pipeline: 'expansao',
        clientId: brandId,
        ownerEmployeeId: seller.id,
      })
      .returning();
    await write(phone, text('oi, quero saber da franquia'));
    const refused = await app.inject({
      method: 'POST',
      url: `/leads/${lead!.id}/whatsapp/text`,
      cookies: seller.cookies,
      payload: { text: 'Olá! Aqui é da Wings Company.' },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: 'brand_voice' });
    expect(refused.json().message).toContain('Casa do Churros');

    await db.insert(waTemplates).values({
      name: 'retomada_wings',
      language: 'pt_BR',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Oi! Aqui é a equipe da Wings, tudo bem?' }],
    });
    const template = await app.inject({
      method: 'POST',
      url: `/leads/${lead!.id}/whatsapp/template`,
      cookies: seller.cookies,
      payload: { name: 'retomada_wings', language: 'pt_BR', params: [] },
    });
    expect(template.statusCode).toBe(422);

    const ok = await app.inject({
      method: 'POST',
      url: `/leads/${lead!.id}/whatsapp/text`,
      cookies: seller.cookies,
      payload: { text: 'Olá! Aqui é do time de expansão da Casa do Churros.' },
    });
    expect(ok.statusCode).toBe(201);
    const permission = await app.inject({
      method: 'POST',
      url: `/leads/${lead!.id}/whatsapp/call-permission`,
      cookies: seller.cookies,
    });
    expect(permission.statusCode).toBe(201);
    expect(JSON.stringify(sends.at(-1))).toContain('A Casa do Churros gostaria de poder te ligar');
  });

  it('the settings refuse the word Wings, and the greeting must say who she speaks for', async () => {
    const board = await sessionFor('diretoria');
    const put = (settings: SofiaSettings) =>
      app.inject({
        method: 'PUT',
        url: '/sofia/settings',
        cookies: board.cookies,
        payload: settings,
      });
    const base = SOFIA_DEFAULT_SETTINGS;
    expect(
      (
        await put({
          ...base,
          texts: { ...base.texts, handoffSeller: 'Um consultor da Wings fala com você.' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await put({
          ...base,
          texts: { ...base.texts, greeting: 'Olá! Sou a Sofia, atendente virtual.' },
        })
      ).statusCode,
    ).toBe(400);
    const expansao = base.expansao.map((q) =>
      q.key === 'origem' ? { ...q, text: 'Como conheceu a Wings?' } : q,
    );
    expect((await put({ ...base, expansao })).statusCode).toBe(400);
    expect((await put(base)).statusCode).toBe(200);
  });
});

describe('the WhatsApp screen (WhatsApp Web of each person)', () => {
  type Item = {
    conversationId: string;
    unreadCount: number;
    attendance: string;
    lastStatus: string | null;
  };
  const list = async (cookies: Record<string, string>, query = '') =>
    (await app.inject({ method: 'GET', url: `/whatsapp/conversations${query}`, cookies })).json<{
      conversations: Item[];
    }>().conversations;

  it('counts unread per reader, clears on opening, and finds by name', async () => {
    const seller = await sessionFor('vendedor_formatacao');
    const admin = await sessionFor('admin_master');
    const phone = newPhone();
    await db.insert(leads).values({
      source: 'manual',
      name: 'Rita Moura',
      phone,
      pipeline: 'formatacao',
      ownerEmployeeId: seller.id,
    });
    await write(phone, text('oi'));
    await write(phone, text('tem alguém aí?'));
    const conversation = await conversationOf(phone);
    const mine = (await list(seller.cookies)).find((c) => c.conversationId === conversation.id);
    expect(mine).toMatchObject({ unreadCount: 2, attendance: 'waiting_seller' });
    expect((await list(seller.cookies, '?filter=unread')).map((c) => c.conversationId)).toContain(
      conversation.id,
    );

    const opened = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/read`,
      cookies: seller.cookies,
    });
    expect(opened.statusCode).toBe(204);
    expect(
      (await list(seller.cookies)).find((c) => c.conversationId === conversation.id)?.unreadCount,
    ).toBe(0);
    // Another reader's unread is theirs.
    expect(
      (await list(admin.cookies)).find((c) => c.conversationId === conversation.id)?.unreadCount,
    ).toBe(2);
    await write(phone, text('?'));
    expect(
      (await list(seller.cookies)).find((c) => c.conversationId === conversation.id)?.unreadCount,
    ).toBe(1);
    expect((await list(seller.cookies, '?q=rita')).map((c) => c.conversationId)).toEqual([
      conversation.id,
    ]);
  });

  it('a seller opens only the conversations of their own deals', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const phone = newPhone();
    await db.insert(leads).values({
      source: 'manual',
      name: 'Bruno Sales',
      phone,
      pipeline: 'formatacao',
      ownerEmployeeId: owner.id,
    });
    await write(phone, text('bom dia'));
    const conversation = await conversationOf(phone);
    const url = `/whatsapp/conversations/${conversation.id}`;
    expect((await app.inject({ method: 'GET', url, cookies: owner.cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url, cookies: other.cookies })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: `${url}/read`, cookies: other.cookies })).statusCode,
    ).toBe(404);
    expect((await list(other.cookies)).some((c) => c.conversationId === conversation.id)).toBe(
      false,
    );
  });

  it('"Nova conversa" finds the reader’s deals (and contacts), with the conversation each has', async () => {
    const owner = await sessionFor('vendedor_formatacao');
    const other = await sessionFor('vendedor_formatacao');
    const phone = newPhone();
    const [lead] = await db
      .insert(leads)
      .values({
        source: 'manual',
        name: 'Patrícia Nogueira',
        phone,
        pipeline: 'formatacao',
        ownerEmployeeId: owner.id,
      })
      .returning();
    const find = async (cookies: Record<string, string>, q: string) =>
      (
        await app.inject({
          method: 'GET',
          url: `/whatsapp/targets?q=${encodeURIComponent(q)}`,
          cookies,
        })
      ).json<{ targets: { leadId: string; conversationId: string | null; open: boolean }[] }>()
        .targets;
    expect(await find(owner.cookies, 'Patrícia')).toEqual([
      expect.objectContaining({ leadId: lead!.id, conversationId: null, open: true }),
    ]);
    expect(await find(other.cookies, 'Patrícia')).toEqual([]);
    // The deal's contact carries the same phone (the usual case): still one row, not two.
    const [contact] = await db
      .insert(crmContacts)
      .values({ name: 'Patrícia Nogueira', phone })
      .returning();
    await db.insert(leadContacts).values({ leadId: lead!.id, contactId: contact!.id });
    expect((await find(owner.cookies, 'Patrícia')).map((t) => t.leadId)).toEqual([lead!.id]);
    expect((await find(owner.cookies, phone.slice(-8))).map((t) => t.leadId)).toEqual([lead!.id]);
    await write(phone, text('oi'));
    const byPhone = await find(owner.cookies, phone.slice(-8));
    expect(byPhone[0]?.conversationId).toBe((await conversationOf(phone)).id);
  });
});

describe('what the review found (each was a real path)', () => {
  it('an old PARAR is never read again: Sofia reads only what came after the conversation became hers', async () => {
    const admin = await sessionFor('admin_master');
    const phone = newPhone();
    llmAnswers = [said({ intent: 'indefinido' })];
    await write(phone, text('oi'));
    await sofiaAnswers();
    const conversation = await conversationOf(phone);
    await app.inject({
      method: 'POST',
      url: `/sofia/conversations/${conversation.id}/attendance`,
      cookies: admin.cookies,
      payload: { action: 'take' },
    });
    await write(phone, text('PARAR'));
    await write(phone, text('desculpa, pode continuar'));
    await app.inject({
      method: 'POST',
      url: `/sofia/conversations/${conversation.id}/attendance`,
      cookies: admin.cookies,
      payload: { action: 'close' },
    });
    llmAnswers = [said({ intent: 'formatacao' })];
    await write(phone, text('Quero franquear minha empresa'));
    await sofiaAnswers();
    const after = await conversationOf(phone);
    expect(after.attendance).toBe('sofia');
    expect(bodyOf(lastSent())).toContain('qual é o seu nome?');
    // The model saw the new message as the last one, and the old PARAR was not acted on.
    const [contact] = await db.select().from(waContacts).where(eq(waContacts.phone, phone));
    expect(contact!.optOutAt).toBeNull();
  });

  it('a deal that gets an owner while Sofia talks goes to the owner, and its funnel is not changed', async () => {
    const phone = newPhone();
    llmAnswers = [said({ intent: 'indefinido' })];
    await write(phone, text('oi'));
    await sofiaAnswers();
    const [owned] = await db
      .insert(leads)
      .values({
        source: 'site_form',
        name: 'Lead do site',
        phone,
        pipeline: 'expansao',
        clientId: brandId,
        ownerEmployeeId: expansionSeller,
      })
      .returning();
    await write(phone, tap('sofia:formatacao'));
    expect(await sofiaAnswers()).toBe(0);
    const conversation = await conversationOf(phone);
    expect(conversation).toMatchObject({ attendance: 'waiting_seller', leadId: owned!.id });
    const [lead] = await db.select().from(leads).where(eq(leads.id, owned!.id));
    expect(lead).toMatchObject({ pipeline: 'expansao', clientId: brandId });
  });

  it('a sticker after SAIR gets no answer', async () => {
    const phone = newPhone();
    await write(phone, text('SAIR'));
    await sofiaAnswers();
    const before = sends.length;
    await write(phone, { type: 'sticker', sticker: { id: 'st1', mime_type: 'image/webp' } });
    await sofiaAnswers();
    expect(sends.length).toBe(before);
    expect((await conversationOf(phone)).attendance).toBe('closed');
  });

  it('a person taking the conversation while the model thinks stops Sofia: nothing sent, nothing overwritten', async () => {
    const phone = newPhone();
    await write(phone, tap('sofia:formatacao'));
    await sofiaAnswers();
    await write(phone, text('Bia'));
    await sofiaAnswers();
    const conversation = await conversationOf(phone);
    const before = sends.length;
    const slow: AgentLlm = {
      async complete() {
        // A seller clicks "Assumir" during the call.
        await db
          .update(waConversations)
          .set({ attendance: 'with_person' })
          .where(eq(waConversations.id, conversation.id));
        return {
          text: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'sofia_turn',
              arguments: JSON.stringify(said({ intent: 'quer_pessoa' })),
            },
          ],
          usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.0001 },
          finishReason: 'tool_calls',
        };
      },
    };
    await write(phone, text('Burger da Bia'));
    clock += 5_000;
    await runDueSofiaTurns({ ...deps(), llm: slow });
    expect(sends.length).toBe(before);
    expect((await conversationOf(phone)).attendance).toBe('with_person');
  });

  it('a name the rule cannot read is asked again by rule; the model never gets it', async () => {
    const phone = newPhone();
    await write(phone, tap('sofia:formatacao'));
    await sofiaAnswers();
    await write(phone, text('😀😀'));
    await sofiaAnswers();
    expect(llmCalls).toHaveLength(0);
    expect(bodyOf(lastSent())).toBe(
      `${SOFIA_DEFAULT_SETTINGS.texts.notUnderstood}\n\nPara começar, qual é o seu nome?`,
    );
    await write(phone, text('Ana Paula Souza, prazer!'));
    await sofiaAnswers();
    expect(llmCalls).toHaveLength(0);
    expect(bodyOf(lastSent())).toBe('Qual é o nome da sua empresa?');
    const conversation = await conversationOf(phone);
    expect((conversation.sofiaFacts as { answers: Record<string, string> }).answers.nome).toBe(
      'Ana Paula Souza',
    );
  });

  it('a brand lead whose phone had a won Formatação sale gets a new Expansão deal with the brand; the sale stays won', async () => {
    const phone = newPhone();
    const [sale] = await db
      .insert(leads)
      .values({
        source: 'manual',
        name: 'Cliente antigo',
        phone,
        pipeline: 'formatacao',
        won: true,
        ownerEmployeeId: formatSeller,
      })
      .returning();
    llmAnswers = [said({ intent: 'expansao' })];
    await write(phone, text('WCHUR2 Olá! Quero saber da franquia Casa do Churros.'));
    await sofiaAnswers();
    await write(phone, tap('sofia:marca-sim'));
    await sofiaAnswers();
    await write(phone, text('Rui'));
    await sofiaAnswers();
    llmAnswers = [said({ intent: 'expansao', answers: { cidade: 'Santos, SP' } })];
    await write(phone, text('Santos, SP'));
    await sofiaAnswers();
    await write(phone, pick('sofia:q:investimento:0'));
    await sofiaAnswers();
    await write(phone, pick('sofia:q:prazo:0'));
    await sofiaAnswers();
    await write(phone, pick('sofia:q:origem:0'));
    await sofiaAnswers();
    const conversation = await conversationOf(phone);
    expect(conversation.leadId).not.toBe(sale!.id);
    const [deal] = await db.select().from(leads).where(eq(leads.id, conversation.leadId!));
    expect(deal).toMatchObject({ pipeline: 'expansao', clientId: brandId, won: null });
    const [old] = await db.select().from(leads).where(eq(leads.id, sale!.id));
    expect(old!.won).toBe(true);
  });

  it('a reply in a deal’s conversation goes to that conversation’s number, not the deal’s main phone', async () => {
    const admin = await sessionFor('admin_master');
    const main = newPhone();
    const other = newPhone();
    const [lead] = await db
      .insert(leads)
      .values({
        source: 'manual',
        name: 'Negócio com contato',
        phone: main,
        pipeline: 'formatacao',
        ownerEmployeeId: formatSeller,
      })
      .returning();
    const [contact] = await db
      .insert(crmContacts)
      .values({ name: 'Sócio', phone: other })
      .returning();
    await db.insert(leadContacts).values({ leadId: lead!.id, contactId: contact!.id });
    await write(other, text('oi, sou o sócio'));
    const conversation = await conversationOf(other);
    expect(conversation.leadId).toBe(lead!.id);
    // The deal is the seller's: the Admin takes the conversation before writing (attendance.ts).
    const take = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/assign`,
      cookies: admin.cookies,
      payload: { version: conversation.version, employeeId: admin.id },
    });
    expect(take.statusCode).toBe(204);
    const res = await app.inject({
      method: 'POST',
      url: `/whatsapp/conversations/${conversation.id}/text`,
      cookies: admin.cookies,
      payload: { text: 'Olá! Recebemos sua mensagem.' },
    });
    expect(res.statusCode).toBe(201);
    expect((sends.at(-1) as { to: string }).to).not.toBe(main);
  });

  it('the settings refuse a name question that is not of the name kind', async () => {
    const board = await sessionFor('diretoria');
    const formatacao = SOFIA_DEFAULT_SETTINGS.formatacao.map((q) =>
      q.key === 'nome' ? { ...q, kind: 'text' as const } : q,
    );
    const res = await app.inject({
      method: 'PUT',
      url: '/sofia/settings',
      cookies: board.cookies,
      payload: { ...SOFIA_DEFAULT_SETTINGS, formatacao },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the guards', () => {
  it('drops a model line with a number, a price word, a promise, a question or a claim to be a person', () => {
    expect(guardReply('Que legal!')).toBe('Que legal!');
    expect(guardReply('O investimento é baixo.')).toBe('');
    expect(guardReply('Custa R$ 50 mil.')).toBe('');
    expect(guardReply('Garanto que vai dar certo.')).toBe('');
    expect(guardReply('Posso ajudar em algo mais?')).toBe('');
    expect(guardReply('Sou uma pessoa de verdade.')).toBe('');
    expect(guardReply('Veja em www.wings.com')).toBe('');
  });

  it('reads a name as people write it, and refuses what is not one', () => {
    expect(nameFrom('Meu nome é Ana Paula')).toBe('Ana Paula');
    expect(nameFrom('sou o João.')).toBe('João');
    expect(nameFrom('quanto custa?')).toBeNull();
    expect(nameFrom('tenho 3 lojas')).toBeNull();
  });
});

describe('a lead the site form made, tied by the ref in the first message (15/10)', () => {
  const REF = 'K7M2QX';
  const sentTexts = () => JSON.stringify(sends);
  async function formLead(over: Record<string, unknown> = {}) {
    const [lead] = await db
      .insert(leads)
      .values({
        clientId: brandId,
        name: 'Marina Souza',
        phone: '5521999991111',
        source: 'site_form',
        pipeline: 'expansao',
        clientMapped: true,
        companyName: 'Padaria Aurora',
        instagram: 'padaria.aurora',
        website: 'https://aurora.com.br',
        formRef: REF,
        formRefAt: new Date(clock - 60_000),
        ...over,
      })
      .returning();
    return lead!;
  }
  // The ref is unique among leads: the earlier test's lead gives it up (leads with conversations are never deleted).
  const clean = () => db.update(leads).set({ formRef: null }).where(eq(leads.formRef, REF));

  it('ties the conversation to the form lead from another number, knows its answers and does not greet by name', async () => {
    await clean();
    const lead = await formLead();
    const before = (await db.select().from(leads)).length;
    const sender = newPhone();
    llmAnswers = [said({ intent: 'indefinido' })];
    await write(sender, text(`WCHUR2 ${REF} Olá! Quero saber sobre a franquia Casa do Churros.`));
    const conversation = await conversationOf(sender);
    expect(conversation.leadId).toBe(lead.id);
    expect(conversation.attendance).toBe('sofia');
    expect(conversation.sofiaFacts).toMatchObject({
      formKnown: true,
      formName: null,
      brandConfirmed: true,
    });
    // No second lead was made for the message.
    expect((await db.select().from(leads)).length).toBe(before);

    await sofiaAnswers();
    const facts = (await conversationOf(sender)).sofiaFacts as {
      step: string;
      answers: Record<string, string>;
    };
    expect(Object.values(facts.answers)).toEqual(expect.arrayContaining(['Marina Souza']));
    // The name the form brought is hers, so the first question is the next one that is missing (the city).
    expect(facts.step).toBe('cidade');
    // The ref alone does not reveal the lead: the person's name is not in what she sent.
    expect(sentTexts()).not.toContain('Marina');
    expect(sentTexts()).not.toContain('Aurora');
    const events = await db.select().from(leadEvents).where(eq(leadEvents.leadId, lead.id));
    expect(events.map((e) => e.kind)).toContain('lead.whatsapp_linked');
  });

  it('greets by the first name when the number is the one the form gave', async () => {
    await clean();
    const lead = await formLead({ phone: '5521999992222' });
    llmAnswers = [said({ intent: 'indefinido' })];
    await write('5521999992222', text(`WCHUR2 ${REF} Olá!`));
    expect((await conversationOf('5521999992222')).leadId).toBe(lead.id);
    await sofiaAnswers();
    expect(sentTexts()).toContain('Marina');
    expect(sentTexts()).toContain('formulário');
  });

  it('ignores a ref that expired, is unknown, or comes without the link code', async () => {
    await clean();
    await formLead({ formRefAt: new Date(clock - 8 * 86_400_000) });
    const expired = newPhone();
    await write(expired, text(`WCHUR2 ${REF} Olá!`));
    expect((await conversationOf(expired)).leadId).toBeNull();

    await db
      .update(leads)
      .set({ formRefAt: new Date(clock) })
      .where(eq(leads.formRef, REF));
    const unknown = newPhone();
    await write(unknown, text('WCHUR2 ZZZZZZ Olá!'));
    expect((await conversationOf(unknown)).leadId).toBeNull();
    const noCode = newPhone();
    await write(noCode, text(`${REF} ${REF}`));
    expect((await conversationOf(noCode)).leadId).toBeNull();
  });

  it('with Sofia off, the ref still ties the message to the form lead and makes no second lead', async () => {
    await clean();
    const lead = await formLead();
    await saveSofiaSettings(db, SOFIA_DEFAULT_SETTINGS, null, NOW);
    const before = (await db.select().from(leads)).length;
    const sender = newPhone();
    await write(sender, text(`WCHUR2 ${REF} Olá!`));
    expect((await conversationOf(sender)).leadId).toBe(lead.id);
    expect((await db.select().from(leads)).length).toBe(before);
  });
});
