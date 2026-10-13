import { SESSION_COOKIE, WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq, ne } from 'drizzle-orm';
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
    // The seller hears of the first step; the manager and Diretoria of the second (long past the end of that day).
    const kindOf = (id: string) => overdue.find((r) => r.recipientEmployeeId === id)?.kind;
    expect(kindOf(seller.id)).toBe('first_contact_overdue');
    expect(kindOf(manager.id)).toBe('first_contact_escalated');
    expect(kindOf(board.id)).toBe('first_contact_escalated');
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

  describe('the first contact climbs in two steps', () => {
    // São Paulo is UTC-3 all year since 2019 (no DST).
    const sp = (iso: string) => new Date(`${iso}-03:00`);
    let phoneSeq = 0;
    const arrive = (ownerEmployeeId: string, pipeline: 'expansao' | 'formatacao' = 'expansao') => {
      phoneSeq += 1;
      return upsertLead(db, {
        source: 'meta_lead_ads',
        name: 'Beltrana de Teste',
        phone: `5511933${String(phoneSeq).padStart(6, '0')}`,
        clientId: WINGS_CLIENT_ID,
        clientMapped: true,
        pipeline,
        ownerEmployeeId,
        skipResearch: true,
        event: { kind: 'lead.received.meta_lead_ads' },
      });
    };
    const dueAt = (leadId: string, due: Date) =>
      db
        .update(leadTasks)
        .set({ dueAt: due })
        .where(and(eq(leadTasks.leadId, leadId), eq(leadTasks.kind, 'first_contact')));
    const firstContactNotices = (leadId: string) =>
      db
        .select()
        .from(crmNotifications)
        .where(and(eq(crmNotifications.leadId, leadId), ne(crmNotifications.kind, 'new_lead')));

    it('tells the seller when the hour passes and the managers only at the end of the business day, once', async () => {
      const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
      const manager = await createEmployee(db, {
        role: 'gerente_comercial',
        sector: 'comercial',
        isSectorManager: true,
      });
      const board = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
      const bystander = await createEmployee(db, {
        role: 'vendedor_expansao',
        sector: 'comercial',
      });
      const born = await arrive(seller.id);
      await dueAt(born.lead.id, sp('2026-10-13T10:00:00'));

      // 11h: the hour has passed. Only the seller is told.
      await runCrmAlerts(db, { stageStuckDays: 0 }, sp('2026-10-13T11:00:00'));
      const step1 = await firstContactNotices(born.lead.id);
      expect(step1.map((n) => [n.kind, n.recipientEmployeeId])).toEqual([
        ['first_contact_overdue', seller.id],
      ]);
      expect(step1[0]?.message).toBe('Primeiro contato atrasado: passou da 1 hora útil.');
      expect(step1[0]?.emailState).toBe('pending');

      // Still before the 18h close: nobody else.
      await runCrmAlerts(db, { stageStuckDays: 0 }, sp('2026-10-13T17:59:00'));
      expect(await firstContactNotices(born.lead.id)).toHaveLength(1);

      // 18h and still no contact: the sector's manager and Diretoria, in a notice of their own.
      const result = await runCrmAlerts(db, { stageStuckDays: 0 }, sp('2026-10-13T18:00:00'));
      expect(result.firstContact.escalated).toBeGreaterThanOrEqual(2);
      const step2 = (await firstContactNotices(born.lead.id)).filter(
        (n) => n.kind === 'first_contact_escalated',
      );
      const who = new Set(step2.map((n) => n.recipientEmployeeId));
      expect(who.has(manager.id)).toBe(true);
      expect(who.has(board.id)).toBe(true);
      expect(who.has(seller.id)).toBe(false);
      expect(who.has(bystander.id)).toBe(false);
      expect(step2[0]?.message).toMatch(/fim do dia útil.*segue em "Novo Contato"/);
      expect(step2.some((n) => /Beltrana|5511/.test(n.message))).toBe(false);

      // No repeat, even when the deadline is moved and passes again the next day.
      expect(
        (await runCrmAlerts(db, { stageStuckDays: 0 }, sp('2026-10-13T18:30:00'))).written,
      ).toBe(0);
      await dueAt(born.lead.id, sp('2026-10-14T10:00:00'));
      await runCrmAlerts(db, { stageStuckDays: 0 }, sp('2026-10-14T19:00:00'));
      expect(await firstContactNotices(born.lead.id)).toHaveLength(1 + step2.length);
    });

    it('says nothing once contact was made: task closed, deal moved out of the entry stage, or closed', async () => {
      const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
      const closedTask = await arrive(seller.id);
      const moved = await arrive(seller.id);
      const won = await arrive(seller.id);
      const formatacao = await arrive(seller.id, 'formatacao');
      for (const born of [closedTask, moved, won, formatacao])
        await dueAt(born.lead.id, sp('2026-10-13T10:00:00'));
      await db
        .update(leadTasks)
        .set({ doneAt: sp('2026-10-13T10:30:00') })
        .where(eq(leadTasks.leadId, closedTask.lead.id));
      await db.update(leads).set({ stage: 'Tentando contato' }).where(eq(leads.id, moved.lead.id));
      await db.update(leads).set({ won: true }).where(eq(leads.id, won.lead.id));

      await runCrmAlerts(db, { stageStuckDays: 0 }, sp('2026-10-13T18:00:00'));
      for (const born of [closedTask, moved, won])
        expect(await firstContactNotices(born.lead.id)).toHaveLength(0);
      // Formatação's entry stage is "Sem contato": told the same way, and the manager's notice names it.
      const formatacaoNotices = await firstContactNotices(formatacao.lead.id);
      expect(formatacaoNotices.map((n) => n.kind)).toContain('first_contact_overdue');
      expect(
        formatacaoNotices.some(
          (n) => n.kind === 'first_contact_escalated' && /segue em "Sem contato"/.test(n.message),
        ),
      ).toBe(true);
    });

    it('does not tell again a person who already got the earlier per-task notice', async () => {
      const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
      const born = await arrive(seller.id);
      await dueAt(born.lead.id, sp('2026-10-13T10:00:00'));
      const task = await db.query.leadTasks.findFirst({
        where: and(eq(leadTasks.leadId, born.lead.id), eq(leadTasks.kind, 'first_contact')),
      });
      await db.insert(crmNotifications).values({
        recipientEmployeeId: seller.id,
        leadId: born.lead.id,
        kind: 'first_contact_overdue',
        message: 'Primeiro contato atrasado: passou da 1 hora útil.',
        dedupeKey: `first_contact_overdue:${task!.id}:2026-10-13T13:00:00.000Z:${seller.id}`,
      });
      await runCrmAlerts(db, { stageStuckDays: 0 }, sp('2026-10-13T11:00:00'));
      const rows = await firstContactNotices(born.lead.id);
      expect(rows.filter((n) => n.recipientEmployeeId === seller.id)).toHaveLength(1);
    });
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
