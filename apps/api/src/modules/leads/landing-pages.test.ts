import { SESSION_COOKIE } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  clients,
  expansionIntakeLedger,
  leads,
  leadSourceRules,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { configureLandingBase, franchiseLpHosts } from './landing-base.js';
import { resolveLandingPage } from './service.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let clientId: string;

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
  const [client] = await db
    .insert(clients)
    .values({ name: 'Cenoritas', slug: 'cenoritas', number: 20 })
    .returning();
  clientId = client!.id;
}, 60_000);

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

describe('CRM Vendas → Landing pages', () => {
  it('makes the slug from the client, a second one with -2, and the rule maps conversions to client and funnel', async () => {
    const admin = await cookiesFor('admin_master');
    const first = await app.inject({
      method: 'POST',
      url: '/crm/landing-pages',
      cookies: admin,
      payload: { clientId, pipeline: 'expansao' },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().page).toMatchObject({
      pattern: 'cenoritas',
      url: 'https://franquia.wingscompany.com.br/cenoritas',
      clientName: 'Cenoritas',
      pipeline: 'expansao',
      active: true,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/crm/landing-pages',
      cookies: admin,
      payload: { clientId, pipeline: 'expansao' },
    });
    expect(second.json().page.pattern).toBe('cenoritas-2');
    expect(
      await resolveLandingPage(db, {
        url: 'https://franquia.wingscompany.com.br/cenoritas?utm_source=x',
      }),
    ).toMatchObject({
      clientId,
      pipeline: 'expansao',
      mapped: true,
    });
  });

  it('shows conversions only with their source and since when, and visits as "—" with the reason', async () => {
    await db.insert(expansionIntakeLedger).values([
      {
        conversionKey: 'u1|cenoritas|2026-09-29T10:00:00.000Z',
        target: 'expansao',
        outcome: 'created',
      },
      {
        conversionKey: 'u2|Cenoritas|2026-09-29T11:00:00.000Z',
        target: 'expansao',
        outcome: 'existing_deal',
      },
    ]);
    const admin = await cookiesFor('admin_master');
    const list = await app.inject({ method: 'GET', url: '/crm/landing-pages', cookies: admin });
    expect(list.statusCode).toBe(200);
    const page = list
      .json()
      .pages.find((item: { pattern: string }) => item.pattern === 'cenoritas');
    expect(page.performance).toMatchObject({ visits: null, conversions: 2, rate: null });
    expect(page.performance.visitsReason).toMatch(/GA4/);
    expect(page.performance.conversionsSource).toMatch(/RD Marketing/);
    expect(page.performance.conversionsSince).not.toBeNull();
  });

  it('archives (stops mapping, keeps the row), restores, and a seller cannot', async () => {
    const admin = await cookiesFor('admin_master');
    const seller = await cookiesFor('vendedor_expansao');
    const rule = await db.query.leadSourceRules.findFirst({
      where: eq(leadSourceRules.pattern, 'cenoritas'),
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/crm/landing-pages/${rule!.id}/archive`,
          cookies: seller,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/crm/landing-pages/${rule!.id}/archive`,
          cookies: admin,
        })
      ).statusCode,
    ).toBe(200);
    expect(await resolveLandingPage(db, { identifier: 'cenoritas' })).toMatchObject({
      mapped: false,
      ruleId: null,
    });
    const archived = await db.query.leadSourceRules.findFirst({
      where: eq(leadSourceRules.id, rule!.id),
    });
    expect(archived).toMatchObject({ active: false });
    expect(archived?.archivedAt).not.toBeNull();
    await app.inject({
      method: 'POST',
      url: `/crm/landing-pages/${rule!.id}/restore`,
      cookies: admin,
    });
    expect(await resolveLandingPage(db, { identifier: 'cenoritas' })).toMatchObject({
      mapped: true,
    });
  });

  it('deletes for good only a page with no lead nor conversion, typed back as confirmation, with audit', async () => {
    const admin = await cookiesFor('admin_master');
    const withHistory = await db.query.leadSourceRules.findFirst({
      where: eq(leadSourceRules.pattern, 'cenoritas'),
    });
    const refused = await app.inject({
      method: 'DELETE',
      url: `/crm/landing-pages/${withHistory!.id}?confirm=cenoritas`,
      cookies: admin,
    });
    expect(refused.statusCode).toBe(409);

    const empty = await db.query.leadSourceRules.findFirst({
      where: eq(leadSourceRules.pattern, 'cenoritas-2'),
    });
    await db.insert(leads).values({
      source: 'rd_station',
      landingPage: 'franquia.wingscompany.com.br/outra',
      phone: '5511900000001',
    });
    const wrong = await app.inject({
      method: 'DELETE',
      url: `/crm/landing-pages/${empty!.id}?confirm=outra-coisa`,
      cookies: admin,
    });
    expect(wrong.statusCode).toBe(400);
    const done = await app.inject({
      method: 'DELETE',
      url: `/crm/landing-pages/${empty!.id}?confirm=cenoritas-2`,
      cookies: admin,
    });
    expect(done.statusCode).toBe(204);
    expect(
      await db.query.leadSourceRules.findFirst({ where: eq(leadSourceRules.id, empty!.id) }),
    ).toBeUndefined();
    const audit = await db.query.auditLog.findMany({
      where: eq(auditLog.action, 'landing_page.deleted'),
    });
    expect(audit).toHaveLength(1);
  });

  it('counts the Funil leads that came through a page', async () => {
    await db.insert(leads).values({
      source: 'rd_station',
      landingPage: 'https://franquia.wingscompany.com.br/cenoritas',
      phone: '5511900000002',
    });
    const admin = await cookiesFor('admin_master');
    const list = await app.inject({ method: 'GET', url: '/crm/landing-pages', cookies: admin });
    const countOf = (body: { pages: { pattern: string; leads: number }[] }) =>
      body.pages.find((item) => item.pattern === 'cenoritas')?.leads;
    expect(countOf(list.json())).toBe(1);
    // Landing pages is not a seller's screen (Eric, 14/10): every client's page would show.
    const seller = await cookiesFor('vendedor_expansao');
    const mine = await app.inject({ method: 'GET', url: '/crm/landing-pages', cookies: seller });
    expect(mine.statusCode).toBe(403);
  });
});

describe('LANDING_PAGE_BASE_URL', () => {
  it('new pages take the configured base, old ones keep theirs, and both hosts map the slug', async () => {
    const moved = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: harness.url,
        SESSION_SECRET: 'x'.repeat(48),
        CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
        CPF_INDEX_KEY: TEST_INDEX_KEY,
        LANDING_PAGE_BASE_URL: 'https://LPFranquias.wingscompany.com.br/',
      }),
      db,
    });
    try {
      expect(franchiseLpHosts()).toEqual([
        'franquia.wingscompany.com.br',
        'lpfranquias.wingscompany.com.br',
      ]);
      const employee = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
      const login = await moved.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: employee.email, password: employee.password },
      });
      const admin = {
        [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value,
      };
      const made = await moved.inject({
        method: 'POST',
        url: '/crm/landing-pages',
        cookies: admin,
        payload: { clientId, pipeline: 'expansao', slug: 'cenoritas-nova' },
      });
      expect(made.statusCode).toBe(201);
      expect(made.json().page.url).toBe('https://lpfranquias.wingscompany.com.br/cenoritas-nova');
      const list = await moved.inject({ method: 'GET', url: '/crm/landing-pages', cookies: admin });
      expect(list.json().baseUrl).toBe('https://lpfranquias.wingscompany.com.br');
      const old = list
        .json()
        .pages.find((item: { pattern: string }) => item.pattern === 'cenoritas');
      expect(old.url).toBe('https://franquia.wingscompany.com.br/cenoritas');

      for (const host of ['lpfranquias.wingscompany.com.br', 'franquia.wingscompany.com.br']) {
        expect(
          await resolveLandingPage(db, { url: `https://${host}/cenoritas-nova?utm_source=x` }),
        ).toMatchObject({ clientId, mapped: true });
      }
    } finally {
      await moved.close();
      configureLandingBase(undefined);
    }
    // Back to the default: the new host is not ours any more.
    expect(
      await resolveLandingPage(db, {
        url: 'https://lpfranquias.wingscompany.com.br/cenoritas-nova',
      }),
    ).toMatchObject({ mapped: false });
  });
});
