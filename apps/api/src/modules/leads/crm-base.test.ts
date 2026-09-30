import { SESSION_COOKIE, WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog, clients, leadSourceRules, leads, rdUserMap } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { resolveLandingPage, resolveMetaSource, upsertLead } from './service.js';

/** CRM phase 1, the base: rules that name a funnel and a brand, first-touch attribution, RD users. */

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

async function sessionFor(role: 'admin_master' | 'vendedor_expansao') {
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
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

describe('source rules with funnel and brand', () => {
  it('names the funnel and the brand of a brand not yet registered, filing the lead under Wings unmapped', async () => {
    await db.insert(leadSourceRules).values({
      kind: 'landing_page',
      pattern: 'lp-marca-sem-cadastro',
      pipeline: 'expansao',
      brand: 'Marca Sem Cadastro',
    });
    const resolved = await resolveLandingPage(db, { identifier: 'LP-Marca-Sem-Cadastro' });
    expect(resolved).toMatchObject({
      clientId: WINGS_CLIENT_ID,
      mapped: false,
      pipeline: 'expansao',
      brand: 'Marca Sem Cadastro',
    });
    expect(resolved.ruleId).not.toBeNull();
  });

  it('maps to a registered brand, and ignores a deactivated rule', async () => {
    const [client] = await db
      .insert(clients)
      .values({ name: 'Marca Cadastrada', slug: 'marca-cadastrada' })
      .returning();
    if (!client) throw new Error('no client');
    await db.insert(leadSourceRules).values([
      {
        kind: 'landing_page',
        pattern: 'lp-marca-cadastrada',
        clientId: client.id,
        pipeline: 'expansao',
      },
      {
        kind: 'landing_page',
        pattern: 'lp-desligada',
        clientId: client.id,
        pipeline: 'expansao',
        active: false,
      },
    ]);
    expect(await resolveLandingPage(db, { identifier: 'lp-marca-cadastrada' })).toMatchObject({
      clientId: client.id,
      mapped: true,
      pipeline: 'expansao',
      brand: 'Marca Cadastrada',
    });
    expect(await resolveLandingPage(db, { identifier: 'lp-desligada' })).toMatchObject({
      mapped: false,
      ruleId: null,
      pipeline: null,
    });
  });

  it('seeds the Formatação forms as Wings Company, funnel Formatação, and no brand', async () => {
    const resolved = await resolveLandingPage(db, { identifier: 'wings-company-form-site' });
    expect(resolved).toMatchObject({
      clientId: WINGS_CLIENT_ID,
      mapped: true,
      pipeline: 'formatacao',
      brand: null,
    });
    expect(await resolveMetaSource(db, { formId: 'sem-regra' })).toMatchObject({
      mapped: false,
      pipeline: null,
    });
  });

  it('seeds the brands landing pages as Expansão rules with the brand name', async () => {
    expect(await resolveLandingPage(db, { identifier: 'acai-da-fila' })).toMatchObject({
      pipeline: 'expansao',
      brand: 'Açaí da Fila',
    });
  });
});

describe('upsertLead: funnel, brand and first-touch attribution', () => {
  it('keeps the first touch whole and fills funnel and brand only when empty', async () => {
    const first = await upsertLead(db, {
      source: 'manual',
      name: 'Pessoa Teste',
      phone: '11 98888-0001',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      pipeline: 'expansao',
      brand: 'Açaí da Fila',
      attribution: {
        utmSource: 'instagram',
        utmMedium: 'cpc',
        utmCampaign: 'camp-1',
        fbclid: ' abc ',
      },
      event: { kind: 'lead.received.manual' },
    });
    expect(first.created).toBe(true);
    const second = await upsertLead(db, {
      source: 'manual',
      phone: '5511988880001',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      pipeline: 'formatacao',
      brand: 'Outra',
      attribution: { utmSource: 'google', gclid: 'g-1' },
      event: { kind: 'lead.received.manual' },
    });
    expect(second.created).toBe(false);
    const row = await db.query.leads.findFirst({ where: eq(leads.id, first.lead.id) });
    expect(row).toMatchObject({
      pipeline: 'expansao',
      brand: 'Açaí da Fila',
      utmSource: 'instagram',
      utmCampaign: 'camp-1',
      fbclid: 'abc',
      gclid: null,
    });
  });

  it('takes the attribution of a later arrival when the lead had none', async () => {
    const first = await upsertLead(db, {
      source: 'manual',
      email: 'sem-utm@example.com',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      event: { kind: 'lead.received.manual' },
    });
    await upsertLead(db, {
      source: 'manual',
      email: 'SEM-UTM@example.com',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      attribution: { utmSource: 'facebook', adPlatform: 'meta', adCampaignExternalId: '120' },
      event: { kind: 'lead.received.manual' },
    });
    const row = await db.query.leads.findFirst({ where: eq(leads.id, first.lead.id) });
    expect(row).toMatchObject({
      utmSource: 'facebook',
      adPlatform: 'meta',
      adCampaignExternalId: '120',
    });
  });
});

describe('RD CRM users -> employees', () => {
  it('is closed to a salesperson', async () => {
    const seller = await sessionFor('vendedor_expansao');
    const response = await app.inject({
      method: 'GET',
      url: '/leads/rd-users',
      cookies: seller.cookies,
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets an Admin Master link and unlink an RD user, with an audit entry', async () => {
    const admin = await sessionFor('admin_master');
    await db.insert(rdUserMap).values({ rdUserId: 'rd-user-1', rdName: 'Vendedor RD' });
    const linked = await app.inject({
      method: 'PUT',
      url: '/leads/rd-users/rd-user-1',
      cookies: admin.cookies,
      payload: { employeeId: admin.employeeId },
    });
    expect(linked.statusCode).toBe(200);
    const list = await app.inject({
      method: 'GET',
      url: '/leads/rd-users',
      cookies: admin.cookies,
    });
    expect(list.json().users).toEqual([
      expect.objectContaining({
        rdUserId: 'rd-user-1',
        employeeId: admin.employeeId,
        rdActive: true,
      }),
    ]);
    const unknown = await app.inject({
      method: 'PUT',
      url: '/leads/rd-users/nao-existe',
      cookies: admin.cookies,
      payload: { employeeId: null },
    });
    expect(unknown.statusCode).toBe(404);
    const audit = await db.query.auditLog.findMany({
      where: eq(auditLog.action, 'rd_user_map.saved'),
    });
    expect(audit).toHaveLength(1);
  });
});
