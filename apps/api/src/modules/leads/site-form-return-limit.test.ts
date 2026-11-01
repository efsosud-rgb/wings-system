import { WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  crmDistributionMembers,
  crmNotifications,
  leadEvents,
  leads,
  leadTasks,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { recordContactOptOut } from './contact-block.js';
import { RETURN_LIMIT_MS, RETURN_TASK_TITLE } from './crm.js';
import { SITE_FORM_RETURN_MIN_AGE_MS } from './service.js';

/**
 * The 24 h limit on a lead that fills "Fale com a Wings" again (Eric, 29/10/2026: "no máximo 1 aviso
 * e 1 tarefa por lead a cada 24 h"). The rest of the return (the notice, the task, RD's echo) is in
 * `site-form-again.test.ts`.
 */

const SLUG = 'fale-com-a-wings';
const RD_SECRET = 'rd-secret-with-enough-length-again';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let seller: { id: string };

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
  await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
  await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
  await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
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

/**
 * pg warns (and pg 9 will refuse) when a query starts on a connection still busy with another, which
 * is what two reads side by side inside one transaction do. The return path reads the "não me
 * contate" register through the transaction, one query at a time; any warning here means reads
 * went side by side again.
 */
const busyClientWarnings: string[] = [];
const onWarning = (warning: Error) => {
  if (/already executing a query/.test(warning.message)) busyClientWarnings.push(warning.message);
};
process.on('warning', onWarning);

afterAll(async () => {
  vi.useRealTimers();
  process.off('warning', onWarning);
  await app?.close();
  await harness?.drop();
  expect(busyClientWarnings).toEqual([]);
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

/**
 * Eric, 29/10/2026: "no máximo 1 aviso e 1 tarefa por lead a cada 24 h". A form sent over and over
 * cannot pile tasks on a seller; the answer is kept every time. A lead marked as a robot's
 * (docs/leads/suspeitos.md) and a person who asked not to be contacted (docs/crm/nao-me-contate.md)
 * get no task.
 */
describe('the 24 h limit on a lead that fills the site form again', () => {
  const HOUR = 60 * 60 * 1000;
  let n = 0;
  /** A lead of its own (phone, e-mail and address of the request), already old enough to be a return. */
  const born = async (extra: Record<string, unknown> = {}) => {
    n += 1;
    const person = {
      phone: `(21) 97777-20${String(n).padStart(2, '0')}`,
      email: `limite.${n}@example.com`,
      companyName: `Loja ${n}`,
      ...extra,
    };
    const ip = `10.1.0.${n}`;
    expect((await post(fale(person), ip)).statusCode).toBe(200);
    const [lead] = await leadsOfPhone(`55${String(person.phone).replace(/\D/g, '')}`);
    await ageLead(lead!.id);
    return { lead: lead!, person, ip };
  };
  /** Sends the form again with the clock at `at`; only the clock moves. */
  const sendAt = async (
    who: { person: Record<string, unknown>; ip: string },
    at: number,
    company: string,
  ) => {
    vi.setSystemTime(at);
    try {
      expect((await post(fale({ ...who.person, companyName: company }), who.ip)).statusCode).toBe(
        200,
      );
    } finally {
      vi.useRealTimers();
    }
  };

  it('holds a task and a notice made 23 h 59 min before, keeps every answer, and lets the next one through after 24 h', async () => {
    const who = await born();
    const start = Date.now();
    await sendAt(who, start, 'Resposta 1');
    const [task] = await returnTasksOf(who.lead.id);
    expect(task).toBeDefined();
    expect(await noticesOf(who.lead.id, 'lead_returned')).toHaveLength(1);
    // The seller finishes it at once: the limit counts from when it was made, not from when it is open.
    await db
      .update(leadTasks)
      .set({ doneAt: new Date(start), doneBy: seller.id })
      .where(eq(leadTasks.id, task!.id));

    await sendAt(who, start + HOUR, 'Resposta 2');
    await sendAt(who, start + RETURN_LIMIT_MS - 60_000, 'Resposta 3');
    expect(await returnTasksOf(who.lead.id)).toHaveLength(1);
    expect(await noticesOf(who.lead.id, 'lead_returned')).toHaveLength(1);
    // Every answer is on the timeline, the limited ones too (one arrival of the lead, one of each send).
    const answers = (await eventsOf(who.lead.id, 'lead.received.site_form'))
      .map((event) => (event.detail as { submitted?: { companyName?: string } }).submitted)
      .map((submitted) => submitted?.companyName)
      .filter((company) => company?.startsWith('Resposta'))
      .sort();
    expect(answers).toEqual(['Resposta 1', 'Resposta 2', 'Resposta 3']);

    await sendAt(who, start + RETURN_LIMIT_MS + 60_000, 'Resposta 4');
    expect(await returnTasksOf(who.lead.id)).toHaveLength(2);
    expect(await noticesOf(who.lead.id, 'lead_returned')).toHaveLength(2);
    // And the limit starts over from that task and notice.
    await sendAt(who, start + RETURN_LIMIT_MS + 2 * HOUR, 'Resposta 5');
    expect(await noticesOf(who.lead.id, 'lead_returned')).toHaveLength(2);
  });

  it('a lead nobody owns: the board and managers are told once in 24 h, not once per submission', async () => {
    n += 1;
    const phone = `552197777${3000 + n}`;
    const [orphan] = await db
      .insert(leads)
      .values({
        clientId: WINGS_CLIENT_ID,
        clientMapped: true,
        name: 'Sem Dono Limite',
        phone,
        source: 'rd_crm',
        pipeline: 'formatacao',
      })
      .returning();
    await ageLead(orphan!.id);
    const who = {
      person: { phone: `(21) 9777-7${3000 + n}`, email: `orfao.${n}@example.com` },
      ip: `10.2.0.${n}`,
    };
    const start = Date.now();
    await sendAt(who, start, 'Orfão 1');
    await sendAt(who, start + 2 * HOUR, 'Orfão 2');
    expect(await noticesOf(orphan!.id, 'lead_returned')).toHaveLength(3);
    await sendAt(who, start + RETURN_LIMIT_MS + 60_000, 'Orfão 3');
    expect(await noticesOf(orphan!.id, 'lead_returned')).toHaveLength(6);
    expect(await returnTasksOf(orphan!.id)).toHaveLength(0);
  });

  it('five submissions at the same moment make one task and one notice', async () => {
    const who = await born();
    const responses = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => post(fale({ ...who.person, companyName: `Junto ${i}` }), who.ip)),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(await returnTasksOf(who.lead.id)).toHaveLength(1);
    expect(await noticesOf(who.lead.id, 'lead_returned')).toHaveLength(1);
    expect(await eventsOf(who.lead.id, 'lead.received.site_form')).toHaveLength(6);
  });

  it('more submissions at the same moment than the pool has connections still all answer, with one task and one notice', async () => {
    // The pool has 10 connections (`createDb`). A read through the pool inside the transaction that
    // holds the lead's lock made 10 or more of these wait on each other until the API stopped.
    const who = await born();
    const sends = 12;
    const answered = Promise.all(
      Array.from({ length: sends }, (_, i) =>
        post(fale({ ...who.person, companyName: `Pool ${i}` }), `10.3.0.${i + 1}`),
      ),
    );
    const timeout = new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), 20_000));
    const responses = await Promise.race([answered, timeout]);
    expect(responses).not.toBe('stuck');
    expect((responses as { statusCode: number }[]).map((r) => r.statusCode)).toEqual(
      Array(sends).fill(200),
    );
    expect(await returnTasksOf(who.lead.id)).toHaveLength(1);
    expect(await noticesOf(who.lead.id, 'lead_returned')).toHaveLength(1);
    expect(await eventsOf(who.lead.id, 'lead.received.site_form')).toHaveLength(sends + 1);
  }, 40_000);

  it('a lead marked as a robot gets the answer on the timeline but no task and no notice; clearing the mark brings them back', async () => {
    const who = await born();
    await db
      .update(leads)
      .set({ suspectAt: new Date(), suspectReasons: ['robot_email', 'burst'] })
      .where(eq(leads.id, who.lead.id));
    await post(fale({ ...who.person, companyName: 'Robô 1' }), who.ip);
    expect(await returnTasksOf(who.lead.id)).toHaveLength(0);
    expect(await noticesOf(who.lead.id, 'lead_returned')).toHaveLength(0);
    expect(await eventsOf(who.lead.id, 'lead.received.site_form')).toHaveLength(2);

    await db.update(leads).set({ suspectClearedAt: new Date() }).where(eq(leads.id, who.lead.id));
    await post(fale({ ...who.person, companyName: 'Não é robô' }), who.ip);
    expect(await returnTasksOf(who.lead.id)).toHaveLength(1);
    expect(await noticesOf(who.lead.id, 'lead_returned')).toHaveLength(1);
  });

  it('"não me contate" on every channel, registered on the lead\'s e-mail while the form came by phone: no task, the owner is told once', async () => {
    const who = await born();
    // The block is under the e-mail the lead had; the new submission types another e-mail.
    await recordContactOptOut(db, {
      channels: ['all'],
      email: who.person.email as string,
      origin: 'crm',
      reason: null,
      createdBy: null,
    });
    const other = { ...who, person: { ...who.person, email: `outro.${n}@example.com` } };
    await post(fale({ ...other.person, companyName: 'Bloqueado 1' }), who.ip);
    await post(fale({ ...other.person, companyName: 'Bloqueado 2' }), who.ip);
    expect(await returnTasksOf(who.lead.id)).toHaveLength(0);
    const notices = await noticesOf(who.lead.id, 'lead_returned');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ recipientEmployeeId: seller.id, emailState: 'none' });
    expect(notices[0]!.message).toContain('pediu para não ser contatado');
    expect(notices[0]!.message).toContain('Nenhuma tarefa');
    expect(await eventsOf(who.lead.id, 'lead.received.site_form')).toHaveLength(3);
  });

  it('a block registered only on the e-mail the person typed this time still holds the task', async () => {
    const who = await born();
    const typed = `digitado.${n}@example.com`;
    await recordContactOptOut(db, {
      channels: ['all'],
      email: typed,
      origin: 'crm',
      reason: null,
      createdBy: null,
    });
    await post(fale({ ...who.person, email: typed, companyName: 'Outro e-mail' }), who.ip);
    expect(await returnTasksOf(who.lead.id)).toHaveLength(0);
    expect(await noticesOf(who.lead.id, 'lead_returned')).toHaveLength(1);
  });

  it('"não me contate" on one channel only leaves the task: the seller can still reach the person elsewhere', async () => {
    const who = await born();
    await recordContactOptOut(db, {
      channels: ['whatsapp'],
      leadId: who.lead.id,
      origin: 'crm',
      reason: null,
      createdBy: null,
    });
    await post(fale({ ...who.person, companyName: 'Só WhatsApp' }), who.ip);
    expect(await returnTasksOf(who.lead.id)).toHaveLength(1);
    const notices = await noticesOf(who.lead.id, 'lead_returned');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message).toContain('Retorno até');
  });
});
