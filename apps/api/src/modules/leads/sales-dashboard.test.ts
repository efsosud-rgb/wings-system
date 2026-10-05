import { SESSION_COOKIE, type SalesDashboard } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { crmStages, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { saoPauloMonthStart, salesDashboardOf } from './sales-dashboard.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

const NOW = new Date('2026-10-15T15:00:00Z');
const DAY = 86_400_000;

async function login(role: 'gerente_comercial' | 'vendedor_expansao') {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const answer = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = answer.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

let manager: { id: string; cookies: Record<string, string> };
let seller: { id: string; cookies: Record<string, string> };

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
  manager = await login('gerente_comercial');
  seller = await login('vendedor_expansao');
  const [first, proposal] = await db
    .insert(crmStages)
    .values([
      { pipeline: 'expansao', name: 'Etapa Um', position: 1, probability: 10 },
      { pipeline: 'expansao', name: 'Etapa Proposta', position: 2, probability: 50 },
    ])
    .returning();
  let n = 0;
  const lead = (fields: Partial<typeof leads.$inferInsert>) => ({
    source: 'rd_station' as const,
    email: `painel${(n += 1)}@example.com`,
    pipeline: 'expansao',
    ...fields,
  });
  await db.insert(leads).values([
    lead({ stageId: first!.id, valueCents: 100_000, brand: 'Marca A', ownerEmployeeId: seller.id }),
    lead({
      stageId: proposal!.id,
      valueCents: 200_000,
      brand: 'Marca A',
      ownerEmployeeId: manager.id,
    }),
    lead({ stageId: proposal!.id, brand: 'Marca B' }),
    // Won this month, won last month (counts in conversion only), lost 10 days ago, lost long ago.
    lead({
      won: true,
      valueCents: 50_000,
      closedAt: new Date(NOW.getTime() - DAY),
      ownerEmployeeId: seller.id,
    }),
    lead({
      won: true,
      valueCents: 70_000,
      closedAt: new Date('2026-09-20T12:00:00Z'),
      ownerEmployeeId: manager.id,
    }),
    lead({ won: false, closedAt: new Date(NOW.getTime() - 10 * DAY) }),
    lead({ won: false, closedAt: new Date(NOW.getTime() - 200 * DAY) }),
    // Another funnel never counts.
    lead({ pipeline: 'formatacao', valueCents: 999_000 }),
  ]);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

describe('Dashboard › Vendas aggregates', () => {
  it('starts the month at midnight in São Paulo', () => {
    expect(saoPauloMonthStart(new Date('2026-11-01T02:00:00Z')).toISOString()).toBe(
      '2026-10-01T03:00:00.000Z',
    );
    expect(saoPauloMonthStart(NOW).toISOString()).toBe('2026-10-01T03:00:00.000Z');
  });

  it('sums open deals by stage, brand and owner, weighted by the stage probability', async () => {
    const board = await salesDashboardOf(db, { pipeline: 'expansao', now: NOW });
    expect(
      board.stages.map((row) => [row.stage?.name, row.total, row.valueCents, row.weightedCents]),
    ).toEqual([
      ['Etapa Um', 1, 100_000, 10_000],
      ['Etapa Proposta', 2, 200_000, 100_000],
    ]);
    expect(board.open).toEqual({ total: 3, valueCents: 300_000, weightedCents: 110_000 });
    expect(board.openWithoutValue).toBe(1);
    expect(board.brands).toEqual([
      { brand: 'Marca A', total: 2, valueCents: 300_000, weightedCents: 110_000 },
      { brand: 'Marca B', total: 1, valueCents: 0, weightedCents: 0 },
    ]);
    const bySeller = new Map(board.sellers.map((row) => [row.ownerEmployeeId, row]));
    expect(bySeller.get(seller.id)).toMatchObject({
      total: 1,
      valueCents: 100_000,
      wonMonth: 1,
      wonMonthCents: 50_000,
    });
    expect(bySeller.get(manager.id)).toMatchObject({
      total: 1,
      weightedCents: 100_000,
      wonMonth: 0,
    });
    expect(bySeller.get(null)).toMatchObject({ total: 1, valueCents: 0 });
    expect(board.wonMonth).toEqual({ total: 1, valueCents: 50_000 });
    // Two won and one lost in the last 90 days; the old loss is out.
    expect(board.conversion).toEqual({ won: 2, lost: 1, rate: 2 / 3, days: 90 });
  });

  it('answers the manager with the whole funnel and a seller with their own deals only', async () => {
    const all = await app.inject({
      method: 'GET',
      url: '/crm/dashboard?pipeline=expansao',
      cookies: manager.cookies,
    });
    expect(all.statusCode).toBe(200);
    expect(all.json<SalesDashboard>().open.total).toBe(3);

    const own = await app.inject({
      method: 'GET',
      url: '/crm/dashboard?pipeline=expansao',
      cookies: seller.cookies,
    });
    expect(own.statusCode).toBe(200);
    const mine = own.json<SalesDashboard>();
    expect(mine.open).toMatchObject({ total: 1, valueCents: 100_000 });
    expect(mine.sellers.map((row) => row.ownerEmployeeId)).toEqual([seller.id]);
    expect(JSON.stringify(mine)).not.toContain('@example.com');

    const bad = await app.inject({
      method: 'GET',
      url: '/crm/dashboard',
      cookies: manager.cookies,
    });
    expect(bad.statusCode).toBe(400);
    const anonymous = await app.inject({ method: 'GET', url: '/crm/dashboard?pipeline=expansao' });
    expect(anonymous.statusCode).toBe(401);
  });
});
