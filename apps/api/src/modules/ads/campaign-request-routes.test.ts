import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type ApprovalDetail, type PendingGroup } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { adAccounts } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { openPeriod } from './budget-guard.js';

/**
 * "Lançar campanha" over HTTP: who may ask, what is refused before it reaches
 * an approver, and that the approver then sees the whole campaign.
 */

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
  new Date(),
);

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

  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId: 'act_1234567890', name: 'Fly High' })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed');
  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: `${TODAY.slice(0, 7)}-01`,
    capCents: 400_000,
    usablePercent: 70,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function cookiesFor(role: 'admin_master' | 'marketing' | 'vendedor_expansao') {
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
  return { [SESSION_COOKIE]: token };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'meta',
    name: `Sacrifício ${randomBytes(3).toString('hex')}`,
    objective: 'lead',
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    variations: [
      { headline: 'Leve a Wings', primaryText: 'Fale com a gente.', callToAction: 'LEARN_MORE' },
      { headline: 'Seja franqueado', primaryText: 'Suporte completo.', callToAction: 'CONTACT_US' },
    ],
    startDate: TODAY,
    endDate: TODAY,
    dailyBudgetCents: 600,
    utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'x', utm_content: 'lead' },
    startPaused: true,
    ...overrides,
  };
}

describe('POST /ads/campaign-requests', () => {
  it('lets Marketing ask, and puts the whole campaign in front of the approver', async () => {
    const payload = draft();
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload,
    });
    expect(response.statusCode).toBe(201);
    const { approvalId } = response.json<{ approvalId: string }>();

    const admin = await cookiesFor('admin_master');
    const detail = await app.inject({ url: `/ads/approvals/${approvalId}`, cookies: admin });
    const approval = detail.json<{ approval: ApprovalDetail }>().approval;
    expect(approval.changeKind).toBe('create_campaign');
    expect(approval.status).toBe('pending');
    expect(approval.campaignName).toBe(payload.name);
    expect(approval.campaignExternalId).toBe('');
    expect(approval.draft?.startPaused).toBe(true);
    expect(approval.draft?.variations).toHaveLength(2);
    // The switch is off in this environment: approving cannot lead to a write.
    expect(approval.executionAvailable).toBe(false);

    const list = await app.inject({ url: '/ads/approvals', cookies: admin });
    expect(
      list.json<{ approvals: { id: string }[] }>().approvals.some((a) => a.id === approvalId),
    ).toBe(true);
    const groups = await app.inject({ url: '/ads/approvals-groups', cookies: admin });
    expect(
      groups.json<{ groups: PendingGroup[] }>().groups.some((g) => g.campaignName === payload.name),
    ).toBe(true);
  });

  it('lets Marketing ask but not approve', async () => {
    const marketing = await cookiesFor('marketing');
    const created = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: marketing,
      payload: draft(),
    });
    const { approvalId } = created.json<{ approvalId: string }>();
    const decision = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies: marketing,
      payload: { decision: 'approved' },
    });
    expect(decision.statusCode).toBe(403);
  });

  it('refuses someone without ads.request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('vendedor_expansao'),
      payload: draft(),
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses blocked copy on the server, whatever the screen did', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload: draft({
        variations: [
          { headline: 'Retorno garantido', primaryText: 'Fale.', callToAction: 'LEARN_MORE' },
          { headline: 'Seja franqueado', primaryText: 'Suporte.', callToAction: 'CONTACT_US' },
        ],
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toContain('Retorno garantido');
  });

  it('answers a guard refusal with its reason', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ads/campaign-requests',
      cookies: await cookiesFor('marketing'),
      payload: draft({ startPaused: false, dailyBudgetCents: 300_000 }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe('usable_would_be_exceeded');
  });
});
