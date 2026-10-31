import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type Client,
  type CrmRelatedLead,
  type RoleKey,
  type SectorSlug,
} from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { crmCompanies, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  clientRegister,
  createEmployee,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import { leadsOfClient } from '../leads/contacts.js';

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

async function sessionFor(role: RoleKey, sector: SectorSlug) {
  const employee = await createEmployee(db, { role, sector });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

async function company(name: string, clientId: string | null) {
  const [row] = await db
    .insert(crmCompanies)
    .values({ name, nameKey: name.toLowerCase(), clientId })
    .returning({ id: crmCompanies.id });
  return row!.id;
}

async function deal(name: string, companyId: string, ownerEmployeeId: string | null = null) {
  const [row] = await db
    .insert(leads)
    .values({ source: 'manual', name, companyId, ownerEmployeeId, stage: 'Reunião' })
    .returning({ id: leads.id });
  return row!.id;
}

describe('the client record: deals', () => {
  it('lists the deals of the companies linked to the client, to who reads both', async () => {
    const director = await sessionFor('diretoria', 'diretoria');
    const legal = await sessionFor('formatacao_juridico', 'formatacao-juridico');
    const created = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies: director.cookies,
      payload: clientRegister('Marca Teste'),
    });
    expect(created.statusCode).toBe(201);
    const client = created.json<{ client: Client }>().client;

    const linked = await company('Empresa Ligada', client.id);
    const second = await company('Empresa Ligada Filial', client.id);
    const other = await company('Empresa Solta', null);
    const first = await deal('Negociação A', linked);
    const later = await deal('Negociação B', second);
    await deal('Negociação de outra empresa', other);

    const answer = await app.inject({
      url: `/clients/${client.id}/deals`,
      cookies: director.cookies,
    });
    expect(answer.statusCode).toBe(200);
    const ids = answer.json<{ deals: CrmRelatedLead[] }>().deals.map((d) => d.id);
    expect(ids.sort()).toEqual([first, later].sort());

    // Jurídico reads the record but not the CRM: the deals stay closed to it.
    expect(
      (await app.inject({ url: `/clients/${client.id}/deals`, cookies: legal.cookies })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `/clients/${WINGS_CLIENT_ID}/deals`, cookies: director.cookies }))
        .statusCode,
    ).toBe(409);
  });

  it('keeps a seller-scoped caller to their own deals', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    const director = await sessionFor('diretoria', 'diretoria');
    const created = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies: director.cookies,
      payload: clientRegister('Marca Escopo'),
    });
    const client = created.json<{ client: Client }>().client;
    const linked = await company('Empresa Escopo', client.id);
    const mine = await deal('Minha', linked, seller.id);
    await deal('De outro', linked, director.employeeId);

    expect((await leadsOfClient(db, client.id, seller.id)).map((d) => d.id)).toEqual([mine]);
    expect(await leadsOfClient(db, client.id)).toHaveLength(2);
  });
});
