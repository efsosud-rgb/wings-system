import { SESSION_COOKIE, WINGS_CLIENT_ID, type CrmStage } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  crmAutomationRuns,
  crmEmailOutbox,
  crmNotifications,
  leadEvents,
  leadTasks,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { processDueRuns, sendTemplateToLead } from './automations.js';
import { recordContactOptOut } from './contact-block.js';
import { entryStageOf } from './crm.js';
import { testTransport } from './crm-mail.js';
import { upsertLead } from './service.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

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
    }),
    db,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

type Role = 'gerente_comercial' | 'vendedor_expansao';
async function sessionFor(role: Role) {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

let manager: Awaited<ReturnType<typeof sessionFor>>;
let seller: Awaited<ReturnType<typeof sessionFor>>;
const stage: Record<string, CrmStage> = {};
let templateId = '';
let sequenceId = '';

const post = (url: string, payload: unknown, who = manager) =>
  app.inject({ method: 'POST', url, cookies: who.cookies, payload: payload as object });

// An Expansão lead WITHOUT a brand: with one, no e-mail may reach the lead (the brand rule,
// docs/integracoes/google-workspace.md), which the last test covers.
async function newLead(phone: string, email: string | null, brand: string | null = null) {
  const result = await upsertLead(db, {
    source: 'site_form',
    name: 'Fulana de Teste',
    phone,
    email,
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    pipeline: 'expansao',
    brand,
    skipResearch: true,
    event: { kind: 'lead.received.site_form' },
  });
  const row = await db.query.leads.findFirst({ where: eq(leads.phone, phone) });
  void result;
  return row!;
}

describe('Regras de automação', () => {
  it('lets a manager build templates, a sequence and rules; a seller cannot', async () => {
    manager = await sessionFor('gerente_comercial');
    seller = await sessionFor('vendedor_expansao');
    for (const name of ['Entrada', 'Proposta', 'Parado']) {
      const created = await post('/crm/stages', { pipeline: 'expansao', name });
      expect(created.statusCode).toBe(201);
      stage[name] = created.json<{ stage: CrmStage }>().stage;
    }
    expect(
      (await post('/crm/automations/templates', { name: 'x', subject: 'y', body: 'z' }, seller))
        .statusCode,
    ).toBe(403);

    const unknown = await post('/crm/automations/templates', {
      name: 'Ruim',
      subject: 'Olá {{nome}}',
      body: 'Seu CPF é {{cpf}}',
    });
    expect(unknown.statusCode).toBe(400);

    const template = await post('/crm/automations/templates', {
      name: 'Boas-vindas',
      subject: 'Olá, {{nome}}',
      body: 'Oi {{nome}}, sobre a {{marca}}. Falo em nome de {{vendedor}}.',
    });
    expect(template.statusCode).toBe(201);
    templateId = template.json<{ template: { id: string } }>().template.id;

    const sequence = await post('/crm/automations/sequences', {
      name: 'Cadência de proposta',
      steps: [
        {
          kind: 'create_task',
          afterHours: 0,
          config: { title: 'Passo 1', dueInHours: 1, businessHours: false },
        },
        { kind: 'send_email', afterHours: 48, config: { templateId } },
      ],
    });
    expect(sequence.statusCode).toBe(201);
    sequenceId = sequence.json<{ sequence: { id: string } }>().sequence.id;

    const rules = [
      {
        kind: 'create_task',
        config: { title: 'Ligar de novo', dueInHours: 2, businessHours: false, taskKind: 'call' },
      },
      { kind: 'notify', config: { recipients: ['owner'], message: 'Chegou na Proposta' } },
      { kind: 'send_email', config: { templateId } },
      { kind: 'start_sequence', config: { sequenceId } },
      {
        kind: 'notify',
        delayMinutes: 120,
        config: { recipients: ['owner'], message: 'Duas horas na Proposta' },
      },
    ];
    for (const rule of rules) {
      const res = await post('/crm/automations/rules', {
        pipeline: 'expansao',
        stageId: stage['Proposta']!.id,
        ...rule,
      });
      expect(res.statusCode).toBe(201);
    }
    const wrongFunnel = await post('/crm/automations/rules', {
      pipeline: 'formatacao',
      stageId: stage['Proposta']!.id,
      kind: 'notify',
      config: { recipients: ['owner'], message: 'x' },
    });
    expect(wrongFunnel.statusCode).toBe(400);
  });

  it('runs a stage’s rules on entry, in test mode, and holds the delayed ones', async () => {
    const lead = await newLead('5511911110001', 'fulana@example.test');
    const assigned = await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.id}`,
      cookies: manager.cookies,
      payload: { ownerEmployeeId: seller.employeeId },
    });
    expect(assigned.statusCode).toBe(200);
    const moved = await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.id}`,
      cookies: manager.cookies,
      payload: { stageId: stage['Proposta']!.id },
    });
    expect(moved.statusCode).toBe(200);

    const tasks = await db.select().from(leadTasks).where(eq(leadTasks.leadId, lead.id));
    expect(tasks.filter((t) => t.title === 'Ligar de novo')).toHaveLength(1);
    expect(tasks.find((t) => t.title === 'Ligar de novo')).toMatchObject({
      kind: 'call',
      auto: true,
      assigneeEmployeeId: seller.employeeId,
    });
    const notices = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.leadId, lead.id));
    expect(notices.filter((n) => n.kind === 'automation').map((n) => n.message)).toEqual([
      'Chegou na Proposta',
    ]);

    const [mail] = await db.select().from(crmEmailOutbox).where(eq(crmEmailOutbox.leadId, lead.id));
    expect(mail).toMatchObject({ mode: 'test', status: 'recorded', subject: 'Olá, Fulana' });
    // No brand on this deal (a branded Expansão deal gets no e-mail at all), so {{marca}} is empty.
    expect(mail?.body).toContain('Oi Fulana, sobre a .');
    const events = await db
      .select({ kind: leadEvents.kind, detail: leadEvents.detail })
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.kind, 'lead.email_sent')));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]!.detail)).not.toContain('example.test');

    // The sequence started: its first step ran, the e-mail 48 h later and the 2 h notice wait.
    expect(tasks.some((t) => t.title === 'Passo 1')).toBe(true);
    const pending = await db
      .select()
      .from(crmAutomationRuns)
      .where(and(eq(crmAutomationRuns.leadId, lead.id), eq(crmAutomationRuns.status, 'pending')));
    expect(pending.map((r) => r.kind).sort()).toEqual(['notify', 'send_email']);

    // Time passes: three hours later the notice is due, the e-mail still is not.
    const later = new Date(Date.now() + 3 * 3_600_000);
    const first = await processDueRuns(db, { mail: testTransport, now: () => later });
    expect(first.done).toBe(1);
    const afterTwoDays = new Date(Date.now() + 49 * 3_600_000);
    const second = await processDueRuns(db, { mail: testTransport, now: () => afterTwoDays });
    expect(second.done).toBe(1);
    expect(
      await db.select().from(crmEmailOutbox).where(eq(crmEmailOutbox.leadId, lead.id)),
    ).toHaveLength(2);
    // Running again does nothing twice.
    const third = await processDueRuns(db, { mail: testTransport, now: () => afterTwoDays });
    expect(third).toEqual({ done: 0, skipped: 0, failed: 0 });
  });

  it('cancels what is pending when the deal leaves the stage, and skips what meets a closed deal', async () => {
    const lead = await newLead('5511911110002', null);
    await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.id}`,
      cookies: manager.cookies,
      payload: { ownerEmployeeId: seller.employeeId },
    });
    await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.id}`,
      cookies: manager.cookies,
      payload: { stageId: stage['Proposta']!.id },
    });
    // No e-mail on file: the send is skipped with a reason, the rest goes on.
    const skipped = await db
      .select()
      .from(crmAutomationRuns)
      .where(and(eq(crmAutomationRuns.leadId, lead.id), eq(crmAutomationRuns.kind, 'send_email')));
    expect(skipped[0]).toMatchObject({ status: 'skipped', result: { reason: 'no_email' } });
    expect(
      (await db.select().from(crmEmailOutbox).where(eq(crmEmailOutbox.leadId, lead.id))).length,
    ).toBe(0);

    await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.id}`,
      cookies: manager.cookies,
      payload: { stageId: stage['Parado']!.id },
    });
    const pending = await db
      .select()
      .from(crmAutomationRuns)
      .where(and(eq(crmAutomationRuns.leadId, lead.id), eq(crmAutomationRuns.status, 'pending')));
    expect(pending).toHaveLength(0);
    const cancelled = await db
      .select()
      .from(crmAutomationRuns)
      .where(and(eq(crmAutomationRuns.leadId, lead.id), eq(crmAutomationRuns.status, 'cancelled')));
    expect(cancelled.length).toBeGreaterThan(0);
  });

  it('a "não me contate" by e-mail skips the rule\u2019s e-mail and the sequence\u2019s, nothing in the outbox', async () => {
    const lead = await newLead('5511911110011', 'naoquer@example.test');
    // Registered under another form of the same address: the key is normalised.
    await recordContactOptOut(db, {
      email: 'NaoQuer@Example.test',
      channels: ['email'],
      origin: 'crm',
      reason: 'Pediu',
      createdBy: manager.employeeId,
    });
    await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.id}`,
      cookies: manager.cookies,
      payload: { ownerEmployeeId: seller.employeeId },
    });
    await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.id}`,
      cookies: manager.cookies,
      payload: { stageId: stage['Proposta']!.id },
    });
    const afterTwoDays = new Date(Date.now() + 49 * 3_600_000);
    await processDueRuns(db, { mail: testTransport, now: () => afterTwoDays });
    const mails = await db
      .select()
      .from(crmAutomationRuns)
      .where(and(eq(crmAutomationRuns.leadId, lead.id), eq(crmAutomationRuns.kind, 'send_email')));
    // The rule's own e-mail and the sequence's step 48 h later.
    expect(mails).toHaveLength(2);
    for (const run of mails)
      expect(run).toMatchObject({ status: 'skipped', result: { reason: 'contact_blocked' } });
    expect(
      await db.select().from(crmEmailOutbox).where(eq(crmEmailOutbox.leadId, lead.id)),
    ).toHaveLength(0);
    const blocked = await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, lead.id), eq(leadEvents.kind, 'lead.contact_blocked')));
    expect(blocked).toHaveLength(2);
    expect(blocked[0]!.detail).toMatchObject({ channel: 'email', path: 'automacao' });
  });

  it('a removed rule that already ran is kept off, not deleted', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/crm/automations/rules?pipeline=expansao',
      cookies: manager.cookies,
    });
    const rules = list.json<{ rules: { id: string; kind: string }[] }>().rules;
    expect(rules).toHaveLength(5);
    const target = rules.find((r) => r.kind === 'create_task')!;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/crm/automations/rules/${target.id}`,
      cookies: manager.cookies,
    });
    expect(removed.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: '/crm/automations/rules?pipeline=expansao',
      cookies: manager.cookies,
    });
    expect(
      after
        .json<{ rules: { id: string; active: boolean }[] }>()
        .rules.find((r) => r.id === target.id)?.active,
    ).toBe(false);
  });
  it('starts the entry stage\u2019s rules for a lead born there, without twinning the first-contact task', async () => {
    const entry = await entryStageOf(db, 'expansao');
    for (const rule of [
      {
        kind: 'create_task',
        config: { title: 'Primeiro contato com o lead', taskKind: 'first_contact', dueInHours: 1 },
      },
      { kind: 'notify', config: { recipients: ['owner'], message: 'Lead novo na entrada' } },
    ]) {
      const res = await post('/crm/automations/rules', {
        pipeline: 'expansao',
        stageId: entry.id,
        ...rule,
      });
      expect(res.statusCode).toBe(201);
    }
    const result = await upsertLead(db, {
      source: 'site_form',
      name: 'Beltrana de Teste',
      phone: '5511911110003',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline: 'expansao',
      brand: 'Marca Teste',
      ownerEmployeeId: seller.employeeId,
      skipResearch: true,
      event: { kind: 'lead.received.site_form' },
    });
    const leadId = result.lead.id;
    const tasks = await db.select().from(leadTasks).where(eq(leadTasks.leadId, leadId));
    expect(tasks.filter((t) => t.kind === 'first_contact')).toHaveLength(1);
    const runs = await db
      .select()
      .from(crmAutomationRuns)
      .where(eq(crmAutomationRuns.leadId, leadId));
    expect(runs.find((r) => r.kind === 'create_task')).toMatchObject({
      status: 'skipped',
      result: { reason: 'already_exists' },
    });
    expect(runs.find((r) => r.kind === 'notify')?.status).toBe('done');

    // An import never starts the rules.
    const imported = await upsertLead(db, {
      source: 'csv_import',
      name: 'Importada de Teste',
      phone: '5511911110004',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline: 'expansao',
      importBatchId: 'lote-teste',
      skipResearch: true,
      event: { kind: 'lead.imported' },
    });
    expect(
      await db
        .select()
        .from(crmAutomationRuns)
        .where(eq(crmAutomationRuns.leadId, imported.lead.id)),
    ).toHaveLength(0);
  });

  it('sends no e-mail to the lead of an Expansão deal with a brand (brand_hidden), nothing in the outbox', async () => {
    const lead = await newLead('5511911110009', 'marca@exemplo.com.br', 'Marca Teste');
    const outcome = await sendTemplateToLead(db, {
      lead,
      templateId,
      transport: testTransport,
      runId: null,
      sentBy: null,
    });
    expect(outcome).toEqual({ ok: false, reason: 'brand_hidden' });
    expect(
      (await db.select().from(crmEmailOutbox).where(eq(crmEmailOutbox.leadId, lead.id))).length,
    ).toBe(0);
  });
});
