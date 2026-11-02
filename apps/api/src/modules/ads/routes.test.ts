import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type ChangeSimulation, type PendingGroup } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adApprovalRequests,
  adCampaigns,
  budgetPeriods,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { gateChange } from './approvals.js';
import { openPeriod, reserveChange } from './budget-guard.js';
import { periodMonthOf } from './reconcile.js';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const PERIOD = '2026-09-01';

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
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function sessionFor(role: 'admin_master' | 'diretoria' | 'marketing' | 'vendedor_expansao') {
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
  return { employee, cookies: { [SESSION_COOKIE]: token } };
}

/** A real pending approval, produced through the guard and the gate. */
async function pendingApproval(): Promise<{ approvalId: string; accountId: string }> {
  const [account] = await db
    .insert(adAccounts)
    .values({
      platform: 'meta',
      externalId: `act_${randomBytes(4).toString('hex')}`,
      name: 'Wings Matriz',
    })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed');

  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: PERIOD,
    capCents: 400_000,
    usablePercent: 70,
  });

  const [campaign] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: account.id,
      externalId: `c_${randomBytes(4).toString('hex')}`,
      name: 'Institucional',
      status: 'ACTIVE',
      dailyBudgetCents: 0,
      budgetLevel: 'campaign',
    })
    .returning({ id: adCampaigns.id });
  if (!campaign) throw new Error('failed');

  const reserved = await reserveChange(db, {
    adAccountId: account.id,
    campaignId: campaign.id,
    kind: 'set_daily_budget',
    toDailyBudgetCents: 2000,
    now: NOW,
  });
  if (!reserved.ok) throw new Error(`reservation refused: ${reserved.reason}`);

  const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId, now: NOW });
  return { approvalId: gate.approvalId ?? '', accountId: account.id };
}

describe('GET /ads/approvals', () => {
  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/ads/approvals' })).statusCode).toBe(401);
  });

  it('refuses someone without ads.read', async () => {
    const { cookies } = await sessionFor('vendedor_expansao');
    const res = await app.inject({ method: 'GET', url: '/ads/approvals', cookies });
    expect(res.statusCode).toBe(403);
  });

  it('lists pending requests before decided ones', async () => {
    await pendingApproval();
    const { cookies } = await sessionFor('admin_master');

    const res = await app.inject({ method: 'GET', url: '/ads/approvals', cookies });
    expect(res.statusCode).toBe(200);

    const approvals = res.json().approvals as { status: string }[];
    expect(approvals.length).toBeGreaterThan(0);
    const firstDecided = approvals.findIndex(
      (a) => a.status === 'approved' || a.status === 'rejected',
    );
    const lastOpen = approvals.map((a) => a.status).lastIndexOf('pending');
    if (firstDecided !== -1 && lastOpen !== -1) expect(lastOpen).toBeLessThan(firstDecided);
  });
});

describe('GET /ads/approvals/:id', () => {
  it('returns everything needed to decide without leaving the system', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('admin_master');

    const res = await app.inject({ method: 'GET', url: `/ads/approvals/${approvalId}`, cookies });
    expect(res.statusCode).toBe(200);

    const approval = res.json().approval;
    expect(approval).toMatchObject({
      status: 'pending',
      trigger: 'policy_always',
      changeKind: 'set_daily_budget',
      platform: 'meta',
      budgetLevel: 'campaign',
    });
    expect(approval.campaignName).toBe('Institucional');
    expect(approval.periodCapCents).toBe(400_000);
    expect(approval.periodUsableCents).toBe(280_000);
    expect(approval.toValueCents).toBe(2000);
    // The audit trail of this request travels with it.
    expect(
      approval.auditTrail.some((e: { action: string }) => e.action === 'ads.approval_requested'),
    ).toBe(true);
  });

  it('404s for an unknown id', async () => {
    const { cookies } = await sessionFor('admin_master');
    const res = await app.inject({
      method: 'GET',
      url: '/ads/approvals/11111111-2222-3333-4444-555555555555',
      cookies,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /ads/approvals/:id/decision', () => {
  it('lets Admin Master approve without a reason', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('admin_master');

    const res = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies,
      payload: { decision: 'approved' },
    });

    expect(res.statusCode).toBe(200);
    const stored = await db.query.adApprovalRequests.findFirst({
      where: eq(adApprovalRequests.id, approvalId),
    });
    expect(stored?.status).toBe('approved');
  });

  it('lets Diretoria decide too', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('diretoria');
    const res = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies,
      payload: { decision: 'approved' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('requires a reason to reject', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('admin_master');

    const withoutReason = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies,
      payload: { decision: 'rejected' },
    });
    expect(withoutReason.statusCode).toBe(400);
    expect(withoutReason.json().message).toMatch(/motivo/i);

    const withReason = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies,
      payload: { decision: 'rejected', reason: 'fora do plano do mês' },
    });
    expect(withReason.statusCode).toBe(200);
  });

  it('refuses an approver without ads.approve, even with ads.read', async () => {
    const { approvalId } = await pendingApproval();
    // Marketing can see paid traffic but must not decide on money.
    const { cookies } = await sessionFor('marketing');

    const res = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies,
      payload: { decision: 'approved' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a second decision', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('admin_master');
    const payload = { decision: 'approved' as const };

    await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies,
      payload,
    });

    expect(second.statusCode).toBe(409);
  });

  it('answers 409 and leaves it pending when the month no longer holds the increase', async () => {
    // The route decides on the real clock, so the period is this month's; the
    // assertion does not depend on how many days are left in it.
    const now = new Date();
    const [account] = await db
      .insert(adAccounts)
      .values({ platform: 'meta', externalId: `act_${randomBytes(4).toString('hex')}`, name: 'X' })
      .returning({ id: adAccounts.id });
    if (!account) throw new Error('failed');
    await openPeriod(db, {
      adAccountId: account.id,
      periodMonth: periodMonthOf(now),
      capCents: 400_000,
      usablePercent: 70,
    });
    const [campaign] = await db
      .insert(adCampaigns)
      .values({
        adAccountId: account.id,
        externalId: `c_${randomBytes(4).toString('hex')}`,
        name: 'Institucional',
        status: 'ACTIVE',
        dailyBudgetCents: 0,
        budgetLevel: 'campaign',
      })
      .returning({ id: adCampaigns.id });
    if (!campaign) throw new Error('failed');
    const reserved = await reserveChange(db, {
      adAccountId: account.id,
      campaignId: campaign.id,
      kind: 'set_daily_budget',
      toDailyBudgetCents: 2000,
      now,
    });
    if (!reserved.ok) throw new Error(`reservation refused: ${reserved.reason}`);
    const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId, now });
    // Read since the request: the platform now allows one cent.
    await db
      .update(budgetPeriods)
      .set({ platformRemainingCents: 1 })
      .where(eq(budgetPeriods.adAccountId, account.id));
    const { cookies } = await sessionFor('admin_master');

    const res = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${gate.approvalId}/decision`,
      cookies,
      payload: { decision: 'approved' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('platform_limit_would_be_exceeded');
    const approval = await db.query.adApprovalRequests.findFirst({
      where: eq(adApprovalRequests.id, gate.approvalId ?? ''),
    });
    expect(approval?.status).toBe('pending');
  });
});

describe('POST /ads/approvals/:id/execute', () => {
  it('refuses while writes are switched off, without touching the platform', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('admin_master');
    await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies,
      payload: { decision: 'approved' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/execute`,
      cookies,
    });

    // No write credentials in the test environment: the honest answer is 409,
    // never a pretend success.
    expect(res.statusCode).toBe(409);
    expect(['no_credentials', 'writes_disabled']).toContain(res.json().error);
  });

  it('refuses someone without ads.approve', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('marketing');
    const res = await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/execute`,
      cookies,
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires a session', async () => {
    const { approvalId } = await pendingApproval();
    const res = await app.inject({ method: 'POST', url: `/ads/approvals/${approvalId}/execute` });
    expect(res.statusCode).toBe(401);
  });

  it('reports the change state so the UI knows whether to offer execution', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('admin_master');

    const before = await app.inject({
      method: 'GET',
      url: `/ads/approvals/${approvalId}`,
      cookies,
    });
    expect(before.json().approval.changeStatus).toBe('pending_approval');
    expect(before.json().approval.executionAvailable).toBe(false);

    await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies,
      payload: { decision: 'approved' },
    });

    const after = await app.inject({ method: 'GET', url: `/ads/approvals/${approvalId}`, cookies });
    expect(after.json().approval.changeStatus).toBe('approved');
    expect(after.json().approval.lastExecutionOutcome).toBeNull();
  });
});

describe('GET /ads/approvals/:id/simulation', () => {
  it('requires ads.read', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('vendedor_expansao');
    const res = await app.inject({
      method: 'GET',
      url: `/ads/approvals/${approvalId}/simulation`,
      cookies,
    });
    expect(res.statusCode).toBe(403);
  });

  it('projects the requested change against the month', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('marketing');

    const res = await app.inject({
      method: 'GET',
      url: `/ads/approvals/${approvalId}/simulation`,
      cookies,
    });
    expect(res.statusCode).toBe(200);

    const { simulation } = res.json() as { simulation: ChangeSimulation };
    expect(simulation.requested.dailyBudgetCents).toBe(2000);
    expect(simulation.requested.campaignExposureCents).toBeGreaterThan(0);
    expect(simulation.period.capCents).toBe(400_000);
    expect(simulation.period.usableCents).toBe(280_000);
    // The reservation is already held, so these two must differ by its size.
    expect(
      simulation.period.committedWithRequestCents - simulation.period.committedWithoutRequestCents,
    ).toBe(simulation.requested.campaignExposureCents);
  });

  it('answers a what-if without changing the request', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('marketing');

    const res = await app.inject({
      method: 'GET',
      url: `/ads/approvals/${approvalId}/simulation?dailyBudgetCents=500`,
      cookies,
    });
    const { simulation } = res.json() as { simulation: ChangeSimulation };
    expect(simulation.simulated?.dailyBudgetCents).toBe(500);

    // The request itself is untouched: still pending, still asking for R$20,00.
    const detail = await app.inject({
      method: 'GET',
      url: `/ads/approvals/${approvalId}`,
      cookies,
    });
    expect(detail.json().approval.status).toBe('pending');
    expect(detail.json().approval.toValueCents).toBe(2000);
  });

  it('refuses a nonsense what-if value', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('marketing');
    const res = await app.inject({
      method: 'GET',
      url: `/ads/approvals/${approvalId}/simulation?dailyBudgetCents=-5`,
      cookies,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /ads/approvals-groups', () => {
  it('requires ads.read', async () => {
    const { cookies } = await sessionFor('vendedor_expansao');
    const res = await app.inject({ method: 'GET', url: '/ads/approvals-groups', cookies });
    expect(res.statusCode).toBe(403);
  });

  it('groups what is waiting, and offers no way to decide it in bulk', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('marketing');

    const res = await app.inject({ method: 'GET', url: '/ads/approvals-groups', cookies });
    expect(res.statusCode).toBe(200);

    const { groups } = res.json() as { groups: PendingGroup[] };
    const group = groups.find((entry) => entry.items.some((i) => i.approvalId === approvalId));
    expect(group?.items).toHaveLength(1);
    expect(group?.campaignName).toBe('Institucional');
    expect(group?.totalAmountCents).toBeGreaterThan(0);

    // There is deliberately no endpoint that decides a whole group at once.
    const bulk = await app.inject({
      method: 'POST',
      url: '/ads/approvals-groups/decision',
      cookies,
      payload: { decision: 'approved' },
    });
    expect(bulk.statusCode).toBe(404);
  });

  it('drops a request out of the group once it is decided', async () => {
    const { approvalId } = await pendingApproval();
    const { cookies } = await sessionFor('admin_master');

    await app.inject({
      method: 'POST',
      url: `/ads/approvals/${approvalId}/decision`,
      cookies,
      payload: { decision: 'rejected', reason: 'fora do plano do mês' },
    });

    const res = await app.inject({ method: 'GET', url: '/ads/approvals-groups', cookies });
    const { groups } = res.json() as { groups: PendingGroup[] };
    expect(groups.some((g) => g.items.some((i) => i.approvalId === approvalId))).toBe(false);
  });
});
