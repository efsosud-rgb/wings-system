import { SESSION_COOKIE, type OfficeSnapshot, type RoleKey } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { employees, leadStageHistory, leadTasks, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

// 15:00 UTC = 12:00 in Rio.
const NOW = new Date('2026-10-06T15:00:00Z');

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
    now: () => NOW,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function sessionFor(role: RoleKey, sector: 'diretoria' | 'comercial' = 'diretoria') {
  const employee = await createEmployee(db, { role, sector });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, email: employee.email, cookies: { [SESSION_COOKIE]: token } };
}

describe('GET /office', () => {
  it('needs a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/office' });
    expect(response.statusCode).toBe(401);
  });

  it.each(['diretoria', 'gerente_comercial', 'vendedor_formatacao'] as RoleKey[])(
    'refuses %s: only the Admin Master sees the office while it is a prototype',
    async (role) => {
      const session = await sessionFor(role, role === 'diretoria' ? 'diretoria' : 'comercial');
      const response = await app.inject({
        method: 'GET',
        url: '/office',
        cookies: session.cookies,
      });
      expect(response.statusCode).toBe(403);
    },
  );

  it('shows active people by first name, their next task, the feed and no personal data', async () => {
    const admin = await sessionFor('admin_master');
    const seller = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    await db
      .update(employees)
      .set({ fullName: 'Daniela Exemplo Silva' })
      .where(eq(employees.id, seller.id));
    const away = await createEmployee(db, { role: 'vendedor_expansao', status: 'inactive' });

    const [deal] = await db
      .insert(leads)
      .values({
        source: 'site',
        name: 'Lead Nome Secreto',
        email: 'lead.secreto@example.com',
        phone: '21988887777',
        ownerEmployeeId: seller.id,
        pipeline: 'formatacao',
        stage: 'Sem contato',
        createdAt: new Date('2026-10-06T13:00:00Z'),
      })
      .returning({ id: leads.id });
    const [task] = await db
      .insert(leadTasks)
      .values({
        leadId: deal!.id,
        kind: 'call',
        title: 'Ligar para Lead Nome Secreto',
        dueAt: new Date('2026-10-06T14:00:00Z'),
        assigneeEmployeeId: seller.id,
      })
      .returning({ id: leadTasks.id });
    await db.insert(leadStageHistory).values({
      leadId: deal!.id,
      at: new Date('2026-10-06T14:30:00Z'),
      fromStage: 'Sem contato',
      toStage: 'Contato feito',
      source: 'wings',
      actorEmployeeId: seller.id,
    });

    const response = await app.inject({ method: 'GET', url: '/office', cookies: admin.cookies });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<OfficeSnapshot>();

    expect(body.hour).toBe(12);
    const person = body.people.find((p) => p.id === seller.id);
    expect(person).toMatchObject({
      displayName: 'Daniela',
      sector: 'comercial',
      zone: 'comercial',
      openDeals: 1,
      openTasks: 1,
      overdueTasks: 1,
      monitor: {
        kind: 'task',
        taskId: task!.id,
        leadId: deal!.id,
        taskKind: 'call',
        overdue: true,
      },
    });
    expect(body.people.some((p) => p.id === away.id)).toBe(false);
    // The admin's own session is live.
    expect(body.people.find((p) => p.id === admin.employeeId)?.present).toBe(true);

    expect(body.events.map((e) => e.kind)).toEqual(['stage_moved', 'lead_created']);
    expect(body.events[0]).toMatchObject({ employeeId: seller.id, detail: 'Contato feito' });
    expect(body.kpis.find((k) => k.key === 'leads_today')?.value).toBe(1);
    expect(body.kpis.find((k) => k.key === 'tasks_overdue')?.value).toBe(1);

    // No lead or employee personal data on the wire.
    const raw = response.body;
    for (const secret of [
      'Lead Nome Secreto',
      'lead.secreto@example.com',
      '21988887777',
      'Exemplo Silva',
      admin.email,
    ]) {
      expect(raw).not.toContain(secret);
    }

    expect(body.agents.map((a) => a.key)).toEqual(['sofia', 'trafego', 'edicao']);
    expect(body.agents[0]).toMatchObject({ lastActivityAt: null, reason: expect.any(String) });
  });
});
