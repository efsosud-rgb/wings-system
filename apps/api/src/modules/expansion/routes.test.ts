import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leadSourceRules } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { activeRules } from './service.js';

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
      SESSION_SECRET: randomBytes(48).toString('base64'),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'https://staging.wingssystem.online',
    }),
    db,
  });
});

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function cookiesFor(role: 'admin_master' | 'vendedor_expansao') {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { [SESSION_COOKIE]: token };
}

describe('expansion landing pages', () => {
  it('is closed to a salesperson', async () => {
    const cookies = await cookiesFor('vendedor_expansao');
    const response = await app.inject({ method: 'GET', url: '/expansion/landing-pages', cookies });
    expect(response.statusCode).toBe(403);
  });

  it('lets an Admin Master add, deactivate and remove one, and the job reads only the active', async () => {
    const cookies = await cookiesFor('admin_master');
    const put = (payload: object) =>
      app.inject({ method: 'PUT', url: '/expansion/landing-pages', cookies, payload });

    expect((await put({ identifier: 'lp-nova', brand: 'Marca Nova' })).statusCode).toBe(200);
    expect((await activeRules(db)).map((rule) => rule.identifier)).toContain('lp-nova');

    // Held back from RD deals (Eric, 01/10): still a rule, but no run makes a deal from it.
    await db
      .update(leadSourceRules)
      .set({ rdDealIntake: false })
      .where(eq(leadSourceRules.pattern, 'lp-nova'));
    expect((await activeRules(db)).map((rule) => rule.identifier)).toContain('lp-nova');
    expect(
      (await activeRules(db, { forDeals: true })).map((rule) => rule.identifier),
    ).not.toContain('lp-nova');
    await db
      .update(leadSourceRules)
      .set({ rdDealIntake: true })
      .where(eq(leadSourceRules.pattern, 'lp-nova'));

    await put({ identifier: 'lp-nova', brand: 'Marca Nova', active: false });
    expect((await activeRules(db)).map((rule) => rule.identifier)).not.toContain('lp-nova');

    const list = await app.inject({ method: 'GET', url: '/expansion/landing-pages', cookies });
    expect(list.json().landingPages).toContainEqual({
      identifier: 'lp-nova',
      brand: 'Marca Nova',
      active: false,
    });

    const del = await app.inject({
      method: 'DELETE',
      url: '/expansion/landing-pages/lp-nova',
      cookies,
    });
    expect(del.statusCode).toBe(204);
  });

  it('refuses a blank identifier', async () => {
    const cookies = await cookiesFor('admin_master');
    const response = await app.inject({
      method: 'PUT',
      url: '/expansion/landing-pages',
      cookies,
      payload: { identifier: ' ', brand: 'X' },
    });
    expect(response.statusCode).toBe(400);
  });
});
