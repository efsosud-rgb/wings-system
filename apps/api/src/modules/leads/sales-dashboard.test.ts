import { cityKey, SESSION_COOKIE, type SalesDashboard } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adMetricsDaily,
  crmStages,
  leadActivities,
  leadStageHistory,
  leadTasks,
  leads,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { salesDashboardOf } from './sales-dashboard.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

// Mid-October in São Paulo: the month runs 01–15/10, the previous period 01–15/09.
const NOW = new Date('2026-10-15T15:00:00Z');
const at = (iso: string) => new Date(`${iso}-03:00`);

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

const month = { pipeline: 'expansao' as const, period: 'month' as const, now: NOW };

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
  const campaign = { campaignName: 'LP Marca A', adCampaignExternalId: 'c-1' };
  const [l1, l2] = await db
    .insert(leads)
    .values([
      lead({
        stageId: first!.id,
        valueCents: 100_000,
        brand: 'Marca A',
        ownerEmployeeId: seller.id,
        createdAt: at('2026-10-05T12:00:00'),
        phone: '5511999990001',
        city: 'São Paulo',
        ...campaign,
      }),
      lead({
        stageId: proposal!.id,
        valueCents: 200_000,
        brand: 'Marca A',
        ownerEmployeeId: manager.id,
        createdAt: at('2026-10-06T12:00:00'),
        phone: '5521999990002',
        city: 'sao  paulo',
        ...campaign,
      }),
      // Open since September, no value, no owner, no phone.
      lead({ stageId: proposal!.id, brand: 'Marca B', createdAt: at('2026-09-01T12:00:00') }),
      // Won this period, from a number abroad.
      lead({
        won: true,
        valueCents: 50_000,
        closedAt: at('2026-10-14T12:00:00'),
        createdAt: at('2026-10-02T12:00:00'),
        ownerEmployeeId: seller.id,
        brand: 'Marca A',
        phone: '447700900123',
        city: 'São Paulo',
        ...campaign,
      }),
      // Won in the previous period.
      lead({
        won: true,
        valueCents: 70_000,
        closedAt: at('2026-09-10T12:00:00'),
        createdAt: at('2026-08-10T12:00:00'),
        ownerEmployeeId: manager.id,
      }),
      lead({
        won: false,
        lostReason: 'Sem capital',
        closedAt: at('2026-10-05T12:00:00'),
        createdAt: at('2026-10-03T12:00:00'),
      }),
      lead({
        won: false,
        lostReason: 'sem  Capital ',
        closedAt: at('2026-10-06T12:00:00'),
        createdAt: at('2026-10-03T12:00:00'),
      }),
      // Lost a year before.
      lead({
        won: false,
        lostReason: 'Outro',
        closedAt: at('2025-10-05T12:00:00'),
        createdAt: at('2025-09-05T12:00:00'),
      }),
      // Another funnel counts only under "todos".
      lead({
        pipeline: 'formatacao',
        won: true,
        valueCents: 999_000,
        closedAt: at('2026-10-10T12:00:00'),
        createdAt: at('2026-10-01T12:00:00'),
      }),
    ])
    .returning();
  await db.insert(leadStageHistory).values([
    { leadId: l2!.id, at: at('2026-10-06T12:00:00'), toStageId: first!.id, source: 'wings' },
    {
      leadId: l2!.id,
      at: at('2026-10-08T12:00:00'),
      fromStageId: first!.id,
      toStageId: proposal!.id,
      source: 'wings',
    },
  ]);
  await db.insert(leadActivities).values({
    leadId: l1!.id,
    kind: 'call',
    at: at('2026-10-06T12:00:00'),
    actorEmployeeId: seller.id,
  });
  await db.insert(leadTasks).values([
    {
      leadId: l1!.id,
      kind: 'first_contact',
      title: 'Primeiro contato',
      dueAt: at('2026-10-14T12:00:00'),
      auto: true,
    },
    {
      leadId: l2!.id,
      kind: 'first_contact',
      title: 'Primeiro contato',
      dueAt: at('2026-10-07T12:00:00'),
      doneAt: at('2026-10-07T10:00:00'),
      auto: true,
    },
  ]);
  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId: 'act_painel', name: 'Conta painel' })
    .returning({ id: adAccounts.id });
  await db.insert(adMetricsDaily).values([
    {
      adAccountId: account!.id,
      level: 'campaign',
      entityExternalId: 'c-1',
      day: '2026-10-10',
      spendCents: 30_000,
    },
    {
      adAccountId: account!.id,
      level: 'campaign',
      entityExternalId: 'c-1',
      day: '2026-09-10',
      spendCents: 99_999,
    },
  ]);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

describe('Dashboard › Vendas v1', () => {
  it('sums what closed in the period and in the two it compares with', async () => {
    const board = await salesDashboardOf(db, { ...month, spendVisible: false });
    expect(board.ranges.current).toEqual({ from: '2026-10-01', to: '2026-10-15' });
    expect(board.results.current).toEqual({
      wonCents: 50_000,
      won: 1,
      wonWithoutValue: 0,
      ticketCents: 50_000,
      lost: 2,
      conversionRate: 1 / 3,
    });
    expect(board.results.previous).toMatchObject({ won: 1, wonCents: 70_000, lost: 0 });
    expect(board.results.previousYear).toMatchObject({ won: 0, lost: 1, conversionRate: 0 });
    expect(board.open).toEqual({
      total: 3,
      valueCents: 300_000,
      weightedCents: 110_000,
      withoutValue: 1,
    });
    // No goals, expected close dates or stage deadlines yet: nothing is estimated.
    expect(board.goalCents).toBeNull();
    expect(board.forecastCents).toBeNull();
    expect(board.actions).toEqual({
      closingSoon: null,
      stalled: null,
      firstContactOverdue: 1,
      goalsAtRisk: null,
      noOwner: 1,
    });
    expect(board.timeToClose).toEqual({ avgDays: 12, count: 1 });
  });

  it('walks the funnel: who reached each stage, the step conversion and the days spent', async () => {
    const board = await salesDashboardOf(db, { ...month, spendVisible: false });
    expect(
      board.funnel?.map((step) => [
        step.stage?.name,
        step.open.total,
        step.reached,
        step.toNext,
        step.avgDays,
      ]),
    ).toEqual([
      ['Etapa Um', 1, 3, 2 / 3, 2],
      ['Etapa Proposta', 2, 2, null, null],
    ]);
    const all = await salesDashboardOf(db, { ...month, pipeline: 'todos', spendVisible: false });
    expect(all.funnel).toBeNull();
    expect(all.results.current.wonCents).toBe(50_000 + 999_000);
    expect(all.services.map((row) => [row.pipeline, row.won, row.wonCents])).toEqual([
      ['formatacao', 1, 999_000],
      ['expansao', 1, 50_000],
    ]);
  });

  it('ranks sellers with activities and time to first contact', async () => {
    const board = await salesDashboardOf(db, { ...month, spendVisible: false });
    const bySeller = new Map(board.sellers.map((row) => [row.ownerEmployeeId, row]));
    expect(bySeller.get(seller.id)).toMatchObject({
      won: 1,
      wonCents: 50_000,
      open: 1,
      openCents: 100_000,
      activities: 1,
      firstContactHours: 24,
      firstContactCount: 1,
      goalCents: null,
    });
    expect(bySeller.get(manager.id)).toMatchObject({ open: 1, openCents: 200_000, won: 0 });
    expect(bySeller.get(null)).toMatchObject({ open: 1, openCents: 0 });
    expect(board.sellers.at(-1)?.ownerEmployeeId).toBeNull();
  });

  it('prices campaigns from the platform spend of the period, only for whoever may see spend', async () => {
    const board = await salesDashboardOf(db, { ...month, spendVisible: true });
    expect(board.campaigns[0]).toEqual({
      campaign: 'LP Marca A',
      leads: 3,
      won: 1,
      wonCents: 50_000,
      spendCents: 30_000,
      cplCents: 10_000,
      cacCents: 30_000,
      roas: 50_000 / 30_000,
    });
    expect(board.campaigns.at(-1)).toMatchObject({ campaign: null, leads: 2, spendCents: null });
    const hidden = await salesDashboardOf(db, { ...month, spendVisible: false });
    expect(hidden.spendVisible).toBe(false);
    expect(hidden.campaigns[0]).toMatchObject({ spendCents: null, cplCents: null, roas: null });
    // Spend is per campaign: filtered by seller it is not shown.
    const bySeller = await salesDashboardOf(db, { ...month, owner: seller.id, spendVisible: true });
    expect(bySeller.spendVisible).toBe(false);
  });

  it('places deals by the DDD of the phone and folds city spellings, storing nothing', async () => {
    const board = await salesDashboardOf(db, { ...month, spendVisible: false });
    expect(board.regions).toEqual([
      { kind: 'uf', uf: 'RJ', leads: 1, won: 0 },
      { kind: 'uf', uf: 'SP', leads: 1, won: 0 },
      { kind: 'none', uf: null, leads: 2, won: 0 },
      { kind: 'abroad', uf: null, leads: 1, won: 1 },
    ]);
    expect(board.cities[0]).toEqual({ city: 'São Paulo', leads: 3, won: 1 });
    expect(board.cities.at(-1)).toEqual({ city: null, leads: 2, won: 0 });
    expect(board.lostReasons).toHaveLength(1);
    expect(cityKey(board.lostReasons[0]!.reason!)).toBe('sem capital');
    expect(board.lostReasons[0]!.total).toBe(2);
  });

  it('filters by brand, source and campaign', async () => {
    const brandB = await salesDashboardOf(db, { ...month, brand: 'Marca B', spendVisible: false });
    expect(brandB.open.total).toBe(1);
    const noBrand = await salesDashboardOf(db, { ...month, brand: 'none', spendVisible: false });
    expect(noBrand.results.current.lost).toBe(2);
    const byCampaign = await salesDashboardOf(db, {
      ...month,
      campaign: 'marca a',
      spendVisible: false,
    });
    expect(byCampaign.open.total).toBe(2);
    const bySource = await salesDashboardOf(db, {
      ...month,
      source: 'manual',
      spendVisible: false,
    });
    expect(bySource.open.total).toBe(0);
  });

  it('answers the manager with the team and a seller with their own deals only', async () => {
    const all = await app.inject({
      method: 'GET',
      url: '/crm/dashboard?pipeline=expansao',
      cookies: manager.cookies,
    });
    expect(all.statusCode).toBe(200);
    const team = all.json<SalesDashboard>();
    expect(team.scope).toBe('all');
    expect(team.open.total).toBe(3);
    // gerente_comercial has no ads.read.
    expect(team.spendVisible).toBe(false);

    const own = await app.inject({
      method: 'GET',
      url: '/crm/dashboard?pipeline=expansao&period=90d',
      cookies: seller.cookies,
    });
    expect(own.statusCode).toBe(200);
    const mine = own.json<SalesDashboard>();
    expect(mine.scope).toBe('own');
    expect(mine.open).toMatchObject({ total: 1, valueCents: 100_000 });
    expect(mine.sellers).toEqual([]);
    expect(mine.campaigns).toEqual([]);
    expect(mine.regions).toEqual([]);
    const text = JSON.stringify(mine) + JSON.stringify(team);
    expect(text).not.toContain('@example.com');
    expect(text).not.toContain('99999');

    const bad = await app.inject({
      method: 'GET',
      url: '/crm/dashboard?period=custom&from=2026-10-10',
      cookies: manager.cookies,
    });
    expect(bad.statusCode).toBe(400);
    const anonymous = await app.inject({ method: 'GET', url: '/crm/dashboard' });
    expect(anonymous.statusCode).toBe(401);
  });
});
