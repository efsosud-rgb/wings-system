import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { loadEnv } from '../../env.js';
import { seed } from '../../db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const calls: {
  method: string;
  path: string;
  body?: { deal: { deal_stage_id: string; user_id?: string } };
}[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const conversions: Record<string, { identifier: string; at: string }> = {
  u1: { identifier: 'wings-company-form-site', at: ago(5) },
  u2: { identifier: 'lp-calcadao-do-frango', at: ago(6) },
  u3: { identifier: 'fluentform_3', at: ago(7) },
  u4: { identifier: 'lp-mister-russo', at: ago(8) },
};

/** A simulated RD Marketing + RD CRM: nobody has a deal yet. */
const rdFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  calls.push({
    method,
    path: url.pathname,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  if (url.pathname === '/auth/token') return json({ access_token: 't' });
  if (url.host === 'api.rd.services') {
    if (url.pathname.endsWith('/contacts')) {
      return json({
        contacts:
          url.searchParams.get('page') === '1'
            ? Object.keys(conversions).map((uuid) => ({
                uuid,
                last_conversion_date: conversions[uuid]!.at,
              }))
            : [],
      });
    }
    const uuid = url.pathname.split('/')[3]!;
    const c = conversions[uuid]!;
    return json([
      {
        event_type: 'CONVERSION',
        event_timestamp: c.at,
        payload: {
          conversion_identifier: c.identifier,
          email: `${uuid}@example.com`,
          name: `Pessoa ${uuid}`,
        },
      },
    ]);
  }
  switch (`${method} ${url.pathname}`) {
    case 'GET /api/v1/deal_pipelines':
      return json([
        {
          id: 'p-for',
          name: 'Formatação',
          deal_stages: [
            { id: 's-for-nc', name: 'Novo Contato' },
            { id: 's-for-sc', name: 'Sem contato' },
          ],
        },
        { id: 'p-exp', name: 'Expansão', deal_stages: [{ id: 's-exp-nc', name: 'Novo Contato' }] },
      ]);
    case 'GET /api/v1/custom_fields':
      return json({ custom_fields: [{ id: 'cf1', label: 'OBS' }] });
    case 'GET /api/v1/deal_sources':
      return json({ deal_sources: [{ id: 'src1', name: 'Contato pelo Site' }] });
    case 'GET /api/v1/campaigns':
      return json({ campaigns: [] });
    case 'GET /api/v1/contacts':
      return json({ contacts: [] });
    case 'POST /api/v1/deals':
      return json({
        id: `deal-${calls.filter((x) => x.method === 'POST' && x.path === '/api/v1/deals').length}`,
      });
    case 'POST /api/v1/tasks':
      return json({ id: 'task' });
    default:
      if (method === 'GET' && url.pathname.startsWith('/api/v1/deals/')) {
        return json({ contacts: [{}], deal_source: {} });
      }
      return json({}, 404);
  }
};

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  await seed(db);
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: randomBytes(48).toString('base64'),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'https://staging.wingssystem.online',
      RD_CRM_API_TOKEN: 'crm-token',
      RD_MKT_CLIENT_ID: 'id',
      RD_MKT_CLIENT_SECRET: 'secret',
      RD_MKT_REFRESH_TOKEN: 'refresh',
      EXPANSION_OWNER_RD_USER_ID: 'owner-fernando',
    }),
    db,
    rdFetch,
  });
});

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function adminCookies() {
  const employee = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { [SESSION_COOKIE]: token };
}

async function settled(cookies: Record<string, string>) {
  for (let i = 0; i < 100; i += 1) {
    const state = (
      await app.inject({ method: 'GET', url: '/expansion/landing-recovery', cookies })
    ).json();
    if (state.state !== 'running') return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('recovery never finished');
}

const dealPosts = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/deals');

describe('landing recovery', () => {
  it('refuses a call that does not say dryRun, and a real run with no dry run behind it', async () => {
    const cookies = await adminCookies();
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/expansion/landing-recovery', cookies, payload });
    expect((await post({})).statusCode).toBe(400);
    expect(
      (
        await post({
          dryRun: false,
          planId: '11111111-1111-4111-8111-111111111111',
          expectedCreated: 2,
        })
      ).statusCode,
    ).toBe(409);
    expect(dealPosts()).toHaveLength(0);
  });

  it('dry run writes nothing; the real run needs its plan and the confirmed count, once', async () => {
    const cookies = await adminCookies();
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/expansion/landing-recovery', cookies, payload });

    expect((await post({ dryRun: true, days: 30 })).statusCode).toBe(202);
    const dry = await settled(cookies);
    expect(dry).toMatchObject({ state: 'done', mode: 'dry' });
    expect(dry.result).toMatchObject({
      wouldCreate: 2,
      created: { formatacao: 1, 'expansao:Calçadão do Frango': 1 },
      listOnly: { fluentform_3: 1 },
      createdDealIds: [],
    });
    expect(dry.result.ignored).toMatchObject({ 'lp-mister-russo': 1 });
    expect(dealPosts()).toHaveLength(0);

    // Wrong confirmed count: refused, nothing made.
    const wrong = await post({ dryRun: false, planId: dry.planId, expectedCreated: 5 });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ error: 'count_mismatch', wouldCreate: 2 });
    expect(dealPosts()).toHaveLength(0);

    // Right plan and count: creates exactly the two, in the right stage and owner.
    expect((await post({ dryRun: false, planId: dry.planId, expectedCreated: 2 })).statusCode).toBe(
      202,
    );
    const real = await settled(cookies);
    expect(real).toMatchObject({ state: 'done', mode: 'real' });
    expect(real.result.createdDealIds).toHaveLength(2);
    const posts = dealPosts();
    expect(posts.map((p) => p.body!.deal.deal_stage_id).sort()).toEqual(['s-exp-nc', 's-for-nc']);
    expect(posts.find((p) => p.body!.deal.deal_stage_id === 's-exp-nc')!.body!.deal.user_id).toBe(
      'owner-fernando',
    );
    expect(
      posts.find((p) => p.body!.deal.deal_stage_id === 's-for-nc')!.body!.deal.user_id,
    ).toBeUndefined();

    // The plan is spent.
    const again = await post({ dryRun: false, planId: dry.planId, expectedCreated: 2 });
    expect(again.statusCode).toBe(409);

    // Nothing personal in what the screen gets.
    const text = JSON.stringify(real);
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('Pessoa');
  });

  it('a second dry run after the real one finds them covered by the ledger, and would create nothing', async () => {
    const cookies = await adminCookies();
    await app.inject({
      method: 'POST',
      url: '/expansion/landing-recovery',
      cookies,
      payload: { dryRun: true },
    });
    const dry = await settled(cookies);
    expect(dry.result).toMatchObject({ wouldCreate: 0, alreadyDecided: 2 });
  });
});
