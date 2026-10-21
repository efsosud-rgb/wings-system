import { WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  crmDistributionMembers,
  crmNotifications,
  jobs,
  leadEvents,
  leads,
  leadTasks,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { RETURN_TASK_TITLE } from './crm.js';
import { SITE_FORM_RETURN_MIN_AGE_MS } from './service.js';

/**
 * A person the CRM already has fills "Fale com a Wings" again (Eric, 21/10/2026): the seller who
 * owns the deal hears it in the bell and gets a return task, and the new answer stays on the
 * timeline without touching what the deal already keeps. The same form sent twice in a row (a
 * double click) is not a return: a lead younger than `SITE_FORM_RETURN_MIN_AGE_MS` only gets the
 * timeline line. RD echoes every submission through its webhook minutes later: that echo must add
 * no notice, task, e-mail or paid research, while a later RD conversion of a known lead is still
 * researched as before. A deal nobody owns tells Diretoria and the managers, and keeps no owner.
 */

const SLUG = 'fale-com-a-wings';
const QUESTION = 'O que você procura?';
const RD_SECRET = 'rd-secret-with-enough-length-again';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let seller: { id: string };
let manager: { id: string };
let admin: { id: string };
let board: { id: string };

/** Turnstile simulated: the token "good" passes. */
const captchaFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const success = new URLSearchParams(String(init?.body ?? '')).get('response') === 'good';
  return new Response(JSON.stringify({ success, 'error-codes': [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  seller = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
  manager = await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
  admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
  board = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
  await db
    .insert(crmDistributionMembers)
    .values({ pipeline: 'formatacao', employeeId: seller.id, active: true });
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      TURNSTILE_SITE_KEY: '0x4AAAAAAA-site',
      TURNSTILE_SECRET_KEY: '0x4AAAAAAA-secret',
      RD_STATION_WEBHOOK_SECRET: RD_SECRET,
    }),
    db,
    captchaFetch,
  });
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  await app?.close();
  await harness?.drop();
});

/** Everything the page makes required, filled with made-up data; each call changes what it needs. */
const fale = (overrides: Record<string, unknown> = {}) => ({
  name: 'Pessoa Teste',
  email: 'volta.um@example.com',
  phone: '(21) 97777-1001',
  companyName: 'Padaria Um',
  instagram: '@padaria.um',
  qualifierAnswer: 'formatacao',
  consent: true,
  turnstileToken: 'good',
  website: '',
  page: 'https://fale.wingscompany.com.br/?utm_source=google&utm_campaign=primeira',
  tracking: {},
  ...overrides,
});
/** The route allows 10 posts per IP in 10 minutes: a test that posts a lot brings its own address. */
const post = (payload: Record<string, unknown>, remoteAddress = '127.0.0.1') =>
  app.inject({ method: 'POST', url: `/public/site-forms/${SLUG}`, payload, remoteAddress });

/** The body RD's screen webhook sends when the same person converts there (its echo of the form by default). */
const rdConversion = (contact: Record<string, unknown>, identifier = SLUG) =>
  app.inject({
    method: 'POST',
    url: '/integrations/rd-station/webhook',
    headers: { 'x-wings-webhook-secret': RD_SECRET },
    payload: {
      event_type: 'WEBHOOK.CONVERTED',
      entity_type: 'CONTACT',
      event_timestamp: '2026-10-21T16:00:00.000-03:00',
      event_identifier: identifier,
      contact: { name: 'Pessoa Teste', legal_bases: [], ...contact },
    },
  });

/** Makes the lead older than the resubmission window, as a person who comes back later is. */
const ageLead = (leadId: string) =>
  db
    .update(leads)
    .set({ createdAt: new Date(Date.now() - SITE_FORM_RETURN_MIN_AGE_MS - 1_000) })
    .where(eq(leads.id, leadId));

const leadsOfPhone = (phone: string) => db.select().from(leads).where(eq(leads.phone, phone));
const noticesOf = (leadId: string, kind: string) =>
  db
    .select()
    .from(crmNotifications)
    .where(and(eq(crmNotifications.leadId, leadId), eq(crmNotifications.kind, kind)));
const returnTasksOf = (leadId: string) =>
  db
    .select()
    .from(leadTasks)
    .where(and(eq(leadTasks.leadId, leadId), eq(leadTasks.title, RETURN_TASK_TITLE)));
const eventsOf = (leadId: string, kind: string) =>
  db
    .select()
    .from(leadEvents)
    .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.kind, kind)));
const matchedOf = (events: { detail: unknown }[]) =>
  events.map((event) => (event.detail as { matched?: string }).matched).sort();
const researchJobs = () => db.select().from(jobs).where(eq(jobs.type, 'enrich_lead'));

describe('a lead that already exists fills the site form again', () => {
  const PHONE = '5521977771001';

  it('sent twice in a row (a double click): one lead, the second answer on the timeline, no task and no notice', async () => {
    const first = await post(fale());
    expect(first.statusCode).toBe(200);
    const [lead] = await leadsOfPhone(PHONE);
    expect(lead).toMatchObject({ ownerEmployeeId: seller.id, pipeline: 'formatacao' });
    expect(lead!.stageId).not.toBeNull();
    expect(await noticesOf(lead!.id, 'new_lead')).toHaveLength(1);

    const twice = await post(fale());
    expect(twice.statusCode).toBe(200);
    expect(twice.json()).toEqual({ ok: true, whatsappUrl: null });
    expect(await leadsOfPhone(PHONE)).toHaveLength(1);
    const arrivals = await eventsOf(lead!.id, 'lead.received.site_form');
    expect(matchedOf(arrivals)).toEqual(['existing', 'new']);
    expect(await returnTasksOf(lead!.id)).toHaveLength(0);
    expect(await noticesOf(lead!.id, 'lead_returned')).toHaveLength(0);
    expect(await noticesOf(lead!.id, 'new_lead')).toHaveLength(1);
  });

  it('ten minutes later: tells the owner in the bell, makes one return task and keeps the new answer on the timeline, nothing else touched', async () => {
    const [lead] = await leadsOfPhone(PHONE);
    await ageLead(lead!.id);

    const before = new Date();
    const again = await post(
      fale({
        companyName: 'Padaria Dois',
        instagram: '@padaria.dois',
        siteUrl: 'https://padaria-dois.example.com',
        qualifierAnswer: 'consultoria',
        page: 'https://fale.wingscompany.com.br/?utm_source=instagram&utm_campaign=segunda',
      }),
    );
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true, whatsappUrl: null });
    const rows = await leadsOfPhone(PHONE);
    expect(rows).toHaveLength(1);
    // The deal keeps what it had (first answer, first touch, owner, stage); only a gap is filled.
    expect(rows[0]).toMatchObject({
      id: lead!.id,
      companyName: 'Padaria Um',
      instagram: 'padaria.um',
      website: 'https://padaria-dois.example.com/',
      formAnswers: { [QUESTION]: 'Transformar meu negócio em franquia' },
      utmSource: 'google',
      utmCampaign: 'primeira',
      ownerEmployeeId: seller.id,
      stageId: lead!.stageId,
      won: null,
    });

    // The timeline keeps the new answer, under the same arrival event matched to the lead.
    const arrivals = await eventsOf(lead!.id, 'lead.received.site_form');
    expect(arrivals).toHaveLength(3);
    const returned = arrivals.find(
      (event) => (event.detail as { qualifier?: string }).qualifier === 'consultoria',
    );
    expect(returned?.detail).toMatchObject({
      matched: 'existing',
      submitted: {
        answers: { [QUESTION]: 'Consultoria para o meu negócio' },
        companyName: 'Padaria Dois',
        instagram: 'padaria.dois',
        website: 'https://padaria-dois.example.com',
        utm: { source: 'instagram', campaign: 'segunda', medium: null },
      },
    });
    const [merged] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, lead!.id), eq(auditLog.action, 'lead.merged')));
    expect(merged?.metadata).toMatchObject({ source: 'site_form', slug: SLUG });

    // One return task for the owner, due like the first contact; the first-contact task stays.
    const tasks = await returnTasksOf(lead!.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: 'follow_up',
      auto: true,
      assigneeEmployeeId: seller.id,
      doneAt: null,
    });
    expect(tasks[0]!.dueAt.getTime()).toBeGreaterThan(before.getTime());
    expect(await eventsOf(lead!.id, 'lead.task_created')).toHaveLength(2);
    const firstContact = await db
      .select()
      .from(leadTasks)
      .where(and(eq(leadTasks.leadId, lead!.id), eq(leadTasks.kind, 'first_contact')));
    expect(firstContact).toHaveLength(1);

    // The bell only: one notice to the owner, no e-mail queued, the new-lead notice not repeated.
    const notices = await noticesOf(lead!.id, 'lead_returned');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ recipientEmployeeId: seller.id, emailState: 'none' });
    expect(notices[0]!.message).toContain('preencheu o formulário do site de novo');
    expect(notices[0]!.message).toContain('Retorno até');
    expect(await noticesOf(lead!.id, 'new_lead')).toHaveLength(1);
    // The site form's research switch is off: nothing paid was queued by any submission.
    expect(await researchJobs()).toHaveLength(0);
  });

  it("RD's echo of the submission, and a submission while the task is open, add no notice, task or paid research", async () => {
    const [lead] = await leadsOfPhone(PHONE);
    const echo = await rdConversion({
      uuid: 'rd-uuid-volta-um',
      email: 'volta.um@example.com',
      personal_phone: '(21) 97777-1001',
    });
    expect(echo.statusCode).toBe(200);
    expect(echo.json()).toMatchObject({ leads: [{ leadId: lead!.id, created: false }] });
    expect(await leadsOfPhone(PHONE)).toHaveLength(1);
    const echoed = await eventsOf(lead!.id, 'lead.received.rd_station');
    expect(echoed).toHaveLength(1);
    expect(echoed[0]!.detail).toMatchObject({ matched: 'existing' });
    expect(await noticesOf(lead!.id, 'lead_returned')).toHaveLength(1);
    expect(await noticesOf(lead!.id, 'new_lead')).toHaveLength(1);
    expect(await returnTasksOf(lead!.id)).toHaveLength(1);
    expect(await researchJobs()).toHaveLength(0);
    expect(await eventsOf(lead!.id, 'research.queued')).toHaveLength(0);

    // The same person sends the form once more while the return task is still open: timeline only.
    const third = await post(fale({ companyName: 'Padaria Três' }));
    expect(third.statusCode).toBe(200);
    expect(await eventsOf(lead!.id, 'lead.received.site_form')).toHaveLength(4);
    expect(await noticesOf(lead!.id, 'lead_returned')).toHaveLength(1);
    expect(await returnTasksOf(lead!.id)).toHaveLength(1);

    // Once the seller marks the return done, the next submission opens a new task; the notice
    // stays one per day.
    await db
      .update(leadTasks)
      .set({ doneAt: new Date(), doneBy: seller.id })
      .where(and(eq(leadTasks.leadId, lead!.id), eq(leadTasks.title, RETURN_TASK_TITLE)));
    const fourth = await post(fale({ companyName: 'Padaria Quatro' }));
    expect(fourth.statusCode).toBe(200);
    const tasks = await returnTasksOf(lead!.id);
    expect(tasks).toHaveLength(2);
    expect(tasks.filter((task) => task.doneAt === null)).toHaveLength(1);
    expect(await noticesOf(lead!.id, 'lead_returned')).toHaveLength(1);
  });

  it('the next day the owner is told again (one notice per day); the open task absorbs the submission', async () => {
    const [lead] = await leadsOfPhone(PHONE);
    // Only the clock moves: a day later, across midnight in São Paulo, whatever the hour now.
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    try {
      const tomorrow = await post(fale({ companyName: 'Padaria Cinco' }));
      expect(tomorrow.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    const notices = await noticesOf(lead!.id, 'lead_returned');
    expect(notices).toHaveLength(2);
    expect(notices.map((notice) => notice.recipientEmployeeId)).toEqual([seller.id, seller.id]);
    expect(new Set(notices.map((notice) => notice.dedupeKey)).size).toBe(2);
    const tasks = await returnTasksOf(lead!.id);
    expect(tasks).toHaveLength(2);
    expect(tasks.filter((task) => task.doneAt === null)).toHaveLength(1);
  });

  it('two submissions at the same moment land on one lead, with one return task and one notice', async () => {
    const PHONE_3 = '5521977771003';
    const ip = '10.0.0.3';
    const person = {
      phone: '(21) 97777-1003',
      email: 'volta.tres@example.com',
      companyName: 'Mercado Três',
    };
    const born = await post(fale(person), ip);
    expect(born.statusCode).toBe(200);
    const [lead] = await leadsOfPhone(PHONE_3);
    expect(lead!.ownerEmployeeId).toBe(seller.id);
    await ageLead(lead!.id);

    const [a, b] = await Promise.all([
      post(fale({ ...person, companyName: 'Mercado Três B' }), ip),
      post(fale({ ...person, companyName: 'Mercado Três C' }), ip),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(await leadsOfPhone(PHONE_3)).toHaveLength(1);
    expect(matchedOf(await eventsOf(lead!.id, 'lead.received.site_form'))).toEqual([
      'existing',
      'existing',
      'new',
    ]);
    expect(await returnTasksOf(lead!.id)).toHaveLength(1);
    expect(await noticesOf(lead!.id, 'lead_returned')).toHaveLength(1);
  });

  it('a lead nobody owns: Diretoria and the managers hear it, no task, no owner given, the rotation untouched', async () => {
    const PHONE_2 = '5521977771002';
    const [orphan] = await db
      .insert(leads)
      .values({
        clientId: WINGS_CLIENT_ID,
        clientMapped: true,
        name: 'Sem Dono Teste',
        phone: PHONE_2,
        source: 'rd_crm',
        pipeline: 'formatacao',
      })
      .returning();
    await ageLead(orphan!.id);
    const [member] = await db
      .select()
      .from(crmDistributionMembers)
      .where(eq(crmDistributionMembers.employeeId, seller.id));

    const response = await post(
      fale({
        phone: '(21) 97777-1002',
        email: 'sem.dono@example.com',
        companyName: 'Loja Sem Dono',
      }),
    );
    expect(response.statusCode).toBe(200);
    const rows = await leadsOfPhone(PHONE_2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: orphan!.id, ownerEmployeeId: null, stageId: null });
    expect(await returnTasksOf(orphan!.id)).toHaveLength(0);
    const notices = await noticesOf(orphan!.id, 'lead_returned');
    expect(notices.map((notice) => notice.recipientEmployeeId).sort()).toEqual(
      [manager.id, admin.id, board.id].sort(),
    );
    expect(notices[0]!.message).toContain('sem dono');
    const [after] = await db
      .select()
      .from(crmDistributionMembers)
      .where(eq(crmDistributionMembers.employeeId, seller.id));
    expect(after!.lastAssignedAt?.getTime()).toBe(member!.lastAssignedAt?.getTime());
  });

  it('an RD conversion of a known lead whose research failed, with no site form arrival, is researched as before', async () => {
    const PHONE_4 = '5521977771004';
    const [lead] = await db
      .insert(leads)
      .values({
        clientId: WINGS_CLIENT_ID,
        clientMapped: true,
        name: 'Pesquisa Falhou Teste',
        phone: PHONE_4,
        source: 'rd_crm',
        pipeline: 'formatacao',
        enrichmentState: 'failed',
      })
      .returning();
    const response = await rdConversion(
      { email: 'pesquisa.falhou@example.com', personal_phone: '(21) 97777-1004' },
      'outra-pagina',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ leads: [{ leadId: lead!.id, created: false }] });
    const [after] = await db.select().from(leads).where(eq(leads.id, lead!.id));
    expect(after).toMatchObject({ enrichmentState: 'pending' });
    expect(after!.enrichmentJobId).not.toBeNull();
    expect(await eventsOf(lead!.id, 'research.queued')).toHaveLength(1);
    expect(await researchJobs()).toHaveLength(1);
  });
});
