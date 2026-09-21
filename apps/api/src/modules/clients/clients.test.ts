import { SESSION_COOKIE, WINGS_CLIENT_ID, type Client } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { seed } from '../../db/seed.js';
import { auditLog, clients } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

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

async function sessionFor(role: 'admin_master' | 'marketing' | 'vendedor_expansao') {
  const employee = await createEmployee(db, {
    role,
    sector:
      role === 'vendedor_expansao' ? 'comercial' : role === 'marketing' ? 'marketing' : 'diretoria',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

describe('the clients register', () => {
  it('starts with Wings Company, from the migration, and the seed can run again', async () => {
    await seed(db);
    const rows = await db.select().from(clients);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: WINGS_CLIENT_ID,
      name: 'Wings Company',
      slug: 'wings-company',
      active: true,
    });
  });

  it('registers, renames and deactivates a client, on the audit trail, without ever touching Wings Company', async () => {
    const { cookies, employeeId } = await sessionFor('marketing');
    const created = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies,
      payload: { name: '  Padaria Aurora ' },
    });
    expect(created.statusCode).toBe(201);
    const client = created.json<{ client: Client }>().client;
    expect(client).toMatchObject({ name: 'Padaria Aurora', slug: 'padaria-aurora', active: true });

    // The same name, however it is written, is the same client.
    const again = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies,
      payload: { name: 'PADARIA  AURÓRA' },
    });
    expect(again.statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: '/clients', cookies, payload: { name: '!' } }))
        .statusCode,
    ).toBe(400);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/clients/${client.id}`,
      cookies,
      payload: { name: 'Aurora Pães', active: false },
    });
    expect(renamed.json<{ client: Client }>().client).toMatchObject({
      name: 'Aurora Pães',
      slug: 'aurora-paes',
      active: false,
    });

    const fixed = await app.inject({
      method: 'PATCH',
      url: `/clients/${WINGS_CLIENT_ID}`,
      cookies,
      payload: { active: false },
    });
    expect(fixed.statusCode).toBe(409);
    expect(fixed.json()).toMatchObject({ error: 'client_fixed' });

    // Wings Company first, then the rest.
    const listed = await app.inject({ url: '/clients', cookies });
    expect(listed.json<{ clients: Client[] }>().clients.map((item) => item.name)).toEqual([
      'Wings Company',
      'Aurora Pães',
    ]);

    const trail = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.actorEmployeeId, employeeId), eq(auditLog.entity, 'client')));
    expect(trail.map((row) => row.action).sort()).toEqual(['client.created', 'client.updated']);
  });

  it('is closed to who neither keeps it nor files media under it', async () => {
    const seller = await sessionFor('vendedor_expansao');
    expect((await app.inject({ url: '/clients' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/clients', cookies: seller.cookies })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/clients',
          cookies: seller.cookies,
          payload: { name: 'Outro Cliente' },
        })
      ).statusCode,
    ).toBe(403);
  });
});
