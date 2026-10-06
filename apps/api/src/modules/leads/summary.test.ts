import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type LeadAiSummary,
  type RoleKey,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leadEvents, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { AgentLlm, LlmRequest } from '../agent/llm.js';
import { addNote } from './crm.js';
import { loadLead, upsertLead } from './service.js';
import { scrubForModel, summaryInputOf } from './summary.js';

/**
 * The deal's AI summary: made from the timeline and the form answers only,
 * with no phone, e-mail or document in what the model reads; stored on the
 * lead with the date; "—" (503) while no model is configured.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let seller: { employeeId: string; cookies: Record<string, string> };
const seen: LlmRequest[] = [];
let reply = 'Negociação em aberto na etapa inicial.';

const scriptedLlm: AgentLlm = {
  async complete(request) {
    seen.push(request);
    return {
      text: reply,
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0012 },
      finishReason: 'stop',
    };
  },
};

const envOf = () =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
  });

const loginAs = async (on: FastifyInstance, role: RoleKey) => {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await on.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
};

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({ env: envOf(), db, agentLlm: scriptedLlm });
  seller = await loginAs(app, 'vendedor_expansao');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(() => {
  seen.length = 0;
});

const arrive = (name: string, phone: string, email: string | null = null) =>
  upsertLead(db, {
    source: 'meta_lead_ads',
    name,
    phone,
    email,
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    pipeline: 'expansao',
    ownerEmployeeId: seller.employeeId,
    distribute: false,
    skipResearch: true,
    company: null,
    formAnswers: {
      Budget: 'R$ 60 mil a R$ 100 mil',
      Telefone: '21999990401',
      'E-mail': 'maria@example.com',
      CPF: '123.456.789-09',
      'Já trabalha com franquia': 'Não',
    },
    event: { kind: 'lead.received.meta_lead_ads' },
  });

describe('the deal summary', () => {
  it('sends the model only the timeline and the answers, with no phone, e-mail or document, and stores the text with the date', async () => {
    const lead = await arrive('Maria Helena', '21999990401', 'maria@example.com');
    await addNote(db, {
      leadId: lead.lead.id,
      body: 'Ligar no (21) 99999-0401 ou maria@example.com; CPF 123.456.789-09; CNPJ 12.345.678/0001-90; cel 21999990401. Quer abrir em Niterói.',
      authorEmployeeId: seller.employeeId,
    });
    const made = await app.inject({
      method: 'POST',
      url: `/leads/${lead.lead.id}/resumo`,
      cookies: seller.cookies,
    });
    expect(made.statusCode).toBe(200);
    const { summary } = made.json<{ summary: LeadAiSummary }>();
    expect(summary.text).toBe(reply);
    expect(summary.basedOn).toEqual({ events: 2, answers: 2 });
    expect(summary.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(seen).toHaveLength(1);
    const prompt = seen[0]!.messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(seen[0]!.noDataCollection).toBe(true);
    expect(seen[0]!.tools).toEqual([]);
    for (const secret of [
      'Maria Helena',
      '21999990401',
      '99999-0401',
      'maria@example.com',
      '123.456.789-09',
      '12.345.678/0001-90',
      'Telefone:',
      'E-mail:',
      'CPF:',
    ])
      expect(prompt).not.toContain(secret);
    expect(prompt).toContain('Quer abrir em Niterói');
    expect(prompt).toContain('Budget: R$ 60 mil a R$ 100 mil');
    expect(prompt).toContain('chegou pelo Meta Lead Ads');

    const row = await db.query.leads.findFirst({ where: eq(leads.id, lead.lead.id) });
    expect(row?.aiSummary).toMatchObject({ text: reply, model: expect.any(String) });
    const stored = await loadLead(db, lead.lead.id);
    expect(stored?.lead.aiSummary?.text).toBe(reply);
    const events = await db
      .select({ kind: leadEvents.kind, detail: leadEvents.detail })
      .from(leadEvents)
      .where(eq(leadEvents.leadId, lead.lead.id));
    expect(events.some((e) => e.kind === 'lead.summary_generated')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(reply);
  });

  it('answers a question from the same text and stores nothing', async () => {
    const lead = await arrive('Outra', '21999990402');
    reply = 'Não consta no registro.';
    const asked = await app.inject({
      method: 'POST',
      url: `/leads/${lead.lead.id}/resumo/pergunta`,
      cookies: seller.cookies,
      payload: { question: 'Ela já tem ponto?' },
    });
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toMatchObject({ answer: 'Não consta no registro.' });
    expect(seen[0]!.messages.at(-1)?.content).toContain('PERGUNTA: Ela já tem ponto?');
    const row = await db.query.leads.findFirst({ where: eq(leads.id, lead.lead.id) });
    expect(row?.aiSummary).toBeNull();
  });

  it('answers 503 with a plain reason while no model is configured', async () => {
    const bare = await buildApp({ env: envOf(), db });
    const session = await loginAs(bare, 'vendedor_expansao');
    const lead = await upsertLead(db, {
      source: 'site_form',
      name: 'Sem IA',
      phone: '21999990403',
      email: null,
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      pipeline: 'expansao',
      ownerEmployeeId: session.employeeId,
      distribute: false,
      skipResearch: true,
      company: null,
      event: { kind: 'lead.received.site_form' },
    });
    const made = await bare.inject({
      method: 'POST',
      url: `/leads/${lead.lead.id}/resumo`,
      cookies: session.cookies,
    });
    expect(made.statusCode).toBe(503);
    expect(made.json()).toMatchObject({ error: 'ai_unavailable' });
    await bare.close();
  });

  it('scrubs bare digit runs and CNPJ on top of the shared scrubber', () => {
    expect(scrubForModel('cel 21999990401, cnpj 12.345.678/0001-90, valor 45000')).toBe(
      'cel [número removido], cnpj [documento removido], valor 45000',
    );
  });

  it('leaves out form questions about contact or documents', () => {
    const input = summaryInputOf({
      lead: {
        pipeline: 'expansao',
        firstMessage: null,
        formAnswers: { Budget: 'alto', WhatsApp: '21 9', Endereço: 'rua x', Cidade: 'Niterói' },
        work: { stage: 'Novo', won: null },
      } as never,
      events: [],
      notes: [],
      tasks: [],
      history: [],
      activities: [],
    });
    expect(input.answers).toBe(2);
    expect(input.text).toContain('Cidade: Niterói');
    expect(input.text).not.toContain('WhatsApp');
    expect(input.text).not.toContain('rua x');
  });
});
