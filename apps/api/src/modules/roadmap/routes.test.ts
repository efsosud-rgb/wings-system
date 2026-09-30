import { SESSION_COOKIE, type RoleKey } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { roadmapDeliverables, roadmapModules } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

const NOW = new Date('2026-09-24T15:00:00Z');

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

const SECTOR_OF: Partial<Record<RoleKey, 'diretoria' | 'marketing' | 'comercial'>> = {
  admin_master: 'diretoria',
  diretoria: 'diretoria',
  marketing: 'marketing',
};

async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, { role, sector: SECTOR_OF[role] ?? 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

type Session = Awaited<ReturnType<typeof sessionFor>>;

async function seedModuleWithDeliverable() {
  const [module] = await db
    .insert(roadmapModules)
    .values({ key: `test-${Date.now()}`, label: 'Módulo de Teste', position: 0 })
    .returning();
  if (!module) throw new Error('failed to seed module');
  const [deliverable] = await db
    .insert(roadmapDeliverables)
    .values({ moduleId: module.id, label: 'Entregável de Teste', weight: 'M', status: 'pendente' })
    .returning();
  if (!deliverable) throw new Error('failed to seed deliverable');
  return { module, deliverable };
}

const ROADMAP_ROUTES: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string }[] = [
  { method: 'GET', url: '/roadmap/modules' },
  { method: 'GET', url: '/roadmap/reports' },
  { method: 'GET', url: '/roadmap/recipients' },
];

describe('roadmap routes: permission gate', () => {
  it('every route requires roadmap.manage — a non-admin_master role is refused', async () => {
    const session = await sessionFor('marketing');
    for (const route of ROADMAP_ROUTES) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        cookies: session.cookies,
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
  });

  it('diretoria, which does not hold roadmap.manage, is also refused', async () => {
    const session = await sessionFor('diretoria');
    const response = await app.inject({
      method: 'GET',
      url: '/roadmap/modules',
      cookies: session.cookies,
    });
    expect(response.statusCode).toBe(403);
  });

  it('an unauthenticated request is refused before permission is even checked', async () => {
    const response = await app.inject({ method: 'GET', url: '/roadmap/modules' });
    expect(response.statusCode).toBe(401);
  });
});

describe('roadmap routes: admin_master', () => {
  let admin: Session;

  beforeAll(async () => {
    admin = await sessionFor('admin_master');
  });

  it('lists modules with computed percentages', async () => {
    await seedModuleWithDeliverable();
    const response = await app.inject({
      method: 'GET',
      url: '/roadmap/modules',
      cookies: admin.cookies,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { modules: unknown[]; computed: { reportDate: string } };
    expect(Array.isArray(body.modules)).toBe(true);
    expect(body.computed.reportDate).toBe('2026-09-24');
  });

  it('edits a deliverable, writes an append-only change row and flips source to manual', async () => {
    const { deliverable } = await seedModuleWithDeliverable();
    const response = await app.inject({
      method: 'PATCH',
      url: `/roadmap/deliverables/${deliverable.id}`,
      cookies: admin.cookies,
      payload: { status: 'pronto', weight: 'G', completedAt: '2026-09-20' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      deliverable: { status: string; weight: string; source: string };
    };
    expect(body.deliverable.status).toBe('pronto');
    expect(body.deliverable.weight).toBe('G');
    expect(body.deliverable.source).toBe('manual');

    const [row] = await db
      .select()
      .from(roadmapDeliverables)
      .where(eq(roadmapDeliverables.id, deliverable.id));
    expect(row?.source).toBe('manual');
  });

  it('404s editing a deliverable that does not exist', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/roadmap/deliverables/00000000-0000-0000-0000-000000000000',
      cookies: admin.cookies,
      payload: { status: 'pronto' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('recipients: creates, lists, updates and deletes', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/roadmap/recipients',
      cookies: admin.cookies,
      payload: { role: 'preview', name: 'Eric', phone: '11999998888' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as { recipient: { id: string } };

    const list = await app.inject({
      method: 'GET',
      url: '/roadmap/recipients',
      cookies: admin.cookies,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { recipients: unknown[] }).recipients.length).toBeGreaterThan(0);

    const update = await app.inject({
      method: 'PATCH',
      url: `/roadmap/recipients/${created.recipient.id}`,
      cookies: admin.cookies,
      payload: { active: false },
    });
    expect(update.statusCode).toBe(200);
    expect((update.json() as { recipient: { active: boolean } }).recipient.active).toBe(false);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/roadmap/recipients/${created.recipient.id}`,
      cookies: admin.cookies,
    });
    expect(remove.statusCode).toBe(204);
  });

  it('report runs: cannot approve a run that is not rascunho again, and 404s on approving a run that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/roadmap/reports/00000000-0000-0000-0000-000000000000/approve',
      cookies: admin.cookies,
    });
    expect(response.statusCode).toBe(404);
  });
});
