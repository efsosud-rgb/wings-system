import { SESSION_COOKIE, WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { crmNotifications, leadTasks, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { cycleMinutesOf, runCrmCycle } from './automations-scheduler.js';
import { runCrmAlerts } from './crm-alerts.js';
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

describe('CRM deadline and deviation alerts', () => {
  it('warns the seller, the sector manager and Diretoria once, and a new due date is a new alert', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const manager = await createEmployee(db, {
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
    });
    const board = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const other = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });

    const born = await upsertLead(db, {
      source: 'site_form',
      name: 'Cicrana de Teste',
      phone: '5511922220001',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline: 'expansao',
      ownerEmployeeId: seller.id,
      skipResearch: true,
      event: { kind: 'lead.received.site_form' },
    });
    // The first-contact task is born due in one business hour; time passes.
    const now = new Date(Date.now() + 5 * 86_400_000);
    const first = await runCrmAlerts(db, { stageStuckDays: 0 }, now);
    expect(first.written).toBeGreaterThanOrEqual(3);

    const rows = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.leadId, born.lead.id));
    // The arrival notice (new_lead) is covered in arrival-notices.test.ts.
    const overdue = rows.filter((r) => r.kind !== 'new_lead');
    const who = new Set(overdue.map((r) => r.recipientEmployeeId));
    expect(who.has(seller.id)).toBe(true);
    expect(who.has(manager.id)).toBe(true);
    expect(who.has(board.id)).toBe(true);
    expect(who.has(other.id)).toBe(false);
    expect(overdue.every((r) => r.kind === 'first_contact_overdue')).toBe(true);
    // The text names the problem, not the person.
    expect(rows.some((r) => /Cicrana|5511/.test(r.message))).toBe(false);

    // The next pass finds the same condition and writes nothing.
    expect((await runCrmAlerts(db, { stageStuckDays: 0 }, now)).written).toBe(0);

    // A closed task stops the alert; a new, other task that is late is a new one.
    await db.update(leadTasks).set({ doneAt: now }).where(eq(leadTasks.leadId, born.lead.id));
    await db.insert(leadTasks).values({
      leadId: born.lead.id,
      kind: 'follow_up',
      title: 'Retornar a proposta',
      dueAt: new Date(now.getTime() - 3_600_000),
      assigneeEmployeeId: seller.id,
    });
    const second = await runCrmAlerts(db, { stageStuckDays: 0 }, now);
    expect(second.written).toBe(who.size);
    const late = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.kind, 'task_overdue'));
    expect(late[0]?.message).toBe('Tarefa atrasada: Retornar a proposta');

    // A deal that wins is no longer chased.
    await db.update(leads).set({ won: true }).where(eq(leads.id, born.lead.id));
    expect(
      (await runCrmAlerts(db, { stageStuckDays: 0 }, new Date(now.getTime() + 86_400_000))).written,
    ).toBe(0);
  });

  it('warns about a deal stuck in a stage beyond its limit, once per stay', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const born = await upsertLead(db, {
      source: 'site_form',
      name: 'Parada de Teste',
      phone: '5511922220002',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline: 'expansao',
      ownerEmployeeId: seller.id,
      skipResearch: true,
      event: { kind: 'lead.received.site_form' },
    });
    // Tasks done so only the stage alert can fire.
    await db
      .update(leadTasks)
      .set({ doneAt: new Date() })
      .where(eq(leadTasks.leadId, born.lead.id));
    const eightDaysLater = new Date(Date.now() + 8 * 86_400_000);
    const result = await runCrmAlerts(db, { stageStuckDays: 7 }, eightDaysLater);
    expect(result.written).toBeGreaterThan(0);
    const rows = await db
      .select()
      .from(crmNotifications)
      .where(eq(crmNotifications.leadId, born.lead.id));
    expect(rows.filter((r) => r.kind !== 'new_lead').every((r) => r.kind === 'stage_stuck')).toBe(
      true,
    );
    expect((await runCrmAlerts(db, { stageStuckDays: 7 }, eightDaysLater)).written).toBe(0);
    // 0 turns the alert off.
    expect(
      (await runCrmAlerts(db, { stageStuckDays: 0 }, new Date(Date.now() + 30 * 86_400_000)))
        .written,
    ).toBe(0);
  });

  it('lets each person read only their notices and mark them read', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: seller.email, password: seller.password },
    });
    const cookies = {
      [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value,
    };
    await db.insert(crmNotifications).values([
      { recipientEmployeeId: seller.id, kind: 'automation', message: 'Meu aviso' },
      {
        recipientEmployeeId: (await createEmployee(db, { sector: 'comercial' })).id,
        kind: 'automation',
        message: 'Aviso de outra pessoa',
      },
    ]);
    const list = await app.inject({ method: 'GET', url: '/crm/notifications', cookies });
    const body = list.json<{ unread: number; notifications: { message: string }[] }>();
    expect(body.unread).toBe(1);
    expect(body.notifications.map((n) => n.message)).toEqual(['Meu aviso']);
    const read = await app.inject({
      method: 'POST',
      url: '/crm/notifications/read',
      cookies,
      payload: { ids: 'all' },
    });
    expect(read.json()).toEqual({ marked: 1 });
    const after = await app.inject({ method: 'GET', url: '/crm/notifications', cookies });
    expect(after.json<{ unread: number }>().unread).toBe(0);
  });

  it('runs the cycle (rules due, then alerts) and reads the cron as minutes', async () => {
    const result = await runCrmCycle({
      db,
      mail: testTransport,
      stageStuckDays: 0,
      log: () => undefined,
    });
    expect(result.ran).toBe(true);
    expect(cycleMinutesOf(undefined)).toBe(5);
    expect(cycleMinutesOf('*/10 * * * *')).toBe(10);
    expect(cycleMinutesOf('0 * * * *')).toBe(5);
  });
});
