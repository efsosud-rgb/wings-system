import { randomBytes } from 'node:crypto';
import {
  SESSION_COOKIE,
  type AdCopyDraft,
  type AuditFinding,
  type AuditRunDetail,
  type IntelligenceOverview,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAds,
  adAlerts,
  adAuditFindings,
  adCampaigns,
  adChangeRequests,
  adCreatives,
  adExecutions,
  adMetricsDaily,
  auditLog,
  budgetPeriods,
  cplTargets,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { AgentLlm, LlmRequest, LlmTurn } from '../agent/llm.js';
import { decideApproval } from './approvals.js';
import { evaluateAudit, type AuditSnapshot } from './audit.js';
import { openPeriod } from './budget-guard.js';
import { executeApprovedChange } from './executor.js';
import { resolveUnknownExecution } from './ops.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';

/**
 * Wings Ads Intelligence end to end, against a throwaway database: an
 * account in the mirror → the audit → a finding → a request in a person's
 * name → approval → execution on a fake platform → an unknown outcome
 * reconciled by reading the platform. No test reaches Meta, Google or
 * OpenRouter: the platform is `FakeMetaClient` and the model is scripted.
 */

const NOW = new Date();
const PERIOD = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(NOW).slice(0, 7)}-01`;
const daysAgo = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
    new Date(NOW.getTime() - days * 24 * 3_600_000),
  );

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let bare: FastifyInstance;

// --- the scripted model ---------------------------------------------------------

let script: ((request: LlmRequest) => Partial<LlmTurn>)[] = [];
const scriptedLlm: AgentLlm = {
  async complete(request) {
    const step = script.shift();
    if (!step) throw new Error('the script ended');
    const turn = step(request);
    return {
      text: turn.text ?? '',
      toolCalls: turn.toolCalls ?? [],
      usage: turn.usage ?? { inputTokens: 1500, outputTokens: 600, costUsd: 0.004 },
      finishReason: 'tool_calls',
    };
  },
};

// --- the world ----------------------------------------------------------------------

interface World {
  accountId: string;
  accountExternalId: string;
  campaignExternalId: string;
  adExternalId: string;
  client: FakeMetaClient;
}

async function world(): Promise<World> {
  const tag = randomBytes(4).toString('hex');
  const accountExternalId = `act_${tag}`;
  const campaignExternalId = `c_${tag}`;
  const adExternalId = `ad_${tag}`;
  const client = new FakeMetaClient({
    accountId: accountExternalId,
    campaigns: [
      { id: campaignExternalId, name: 'Leads RJ', status: 'ACTIVE', dailyBudgetCents: 3000 },
    ],
  });
  Object.defineProperty(client, 'isLive', { value: true });

  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId: accountExternalId, name: `Fly High ${tag}` })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed');
  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: PERIOD,
    capCents: 400_000,
    usablePercent: 70,
  });
  await db
    .update(budgetPeriods)
    .set({ lastReconciledAt: NOW })
    .where(eq(budgetPeriods.adAccountId, account.id));
  const [campaign] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: account.id,
      externalId: campaignExternalId,
      name: 'Leads RJ',
      status: 'ACTIVE',
      deliveryStatus: 'ACTIVE',
      dailyBudgetCents: 3000,
      budgetLevel: 'campaign',
      objective: 'OUTCOME_LEADS',
      lastSyncedAt: NOW,
    })
    .returning({ id: adCampaigns.id });
  if (!campaign) throw new Error('failed');
  await db.insert(adCreatives).values({
    adAccountId: account.id,
    externalId: `cr_${tag}`,
    title: 'Sua franquia',
    body: 'Retorno garantido no primeiro ano.',
    format: 'image',
  });
  const [ad] = await db
    .insert(adAds)
    .values({
      adAccountId: account.id,
      campaignId: campaign.id,
      externalId: adExternalId,
      name: 'Anúncio 1',
      status: 'ACTIVE',
      creativeExternalId: `cr_${tag}`,
    })
    .returning({ id: adAds.id });
  // Ten days of spend with no lead; the ads report a third of what the campaign does.
  for (let day = 1; day <= 10; day += 1) {
    await db.insert(adMetricsDaily).values([
      {
        adAccountId: account.id,
        level: 'campaign',
        entityExternalId: campaignExternalId,
        campaignId: campaign.id,
        day: daysAgo(day),
        spendCents: 3000,
        impressions: 1000,
        clicks: 12,
        reach: 900,
        conversions: 0,
        dailyBudgetCents: 3000,
      },
      {
        adAccountId: account.id,
        level: 'ad',
        entityExternalId: adExternalId,
        campaignId: campaign.id,
        adId: ad?.id,
        day: daysAgo(day),
        spendCents: 1000,
        impressions: 300,
        clicks: 4,
        reach: 250,
      },
    ]);
  }
  await db.insert(adAlerts).values({
    adAccountId: account.id,
    kind: 'ad_rejected',
    severity: 'warning',
    entityLevel: 'ad',
    entityExternalId: adExternalId,
    title: 'Anúncio 1 reprovado',
  });
  return { accountId: account.id, accountExternalId, campaignExternalId, adExternalId, client };
}

async function login(
  role: Parameters<typeof createEmployee>[1] extends infer O
    ? O extends { role?: infer R }
      ? R
      : never
    : never,
) {
  const employee = await createEmployee(db, { role, sector: 'diretoria' });
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

async function audit(
  cookies: Record<string, string>,
  body: Record<string, unknown> = { scope: 'meta', days: 14 },
): Promise<AuditRunDetail> {
  const response = await app.inject({
    method: 'POST',
    url: '/ads/intelligence/audits',
    cookies,
    payload: body,
  });
  expect(response.statusCode).toBe(201);
  return response.json<AuditRunDetail>();
}

const findingOf = (detail: AuditRunDetail, check: string, externalId?: string) =>
  detail.findings.find(
    (finding) =>
      finding.check === check && (!externalId || finding.entity?.externalId === externalId),
  );

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const env = (extra: Record<string, string> = {}) =>
    loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: randomBytes(48).toString('base64'),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      ...extra,
    });
  app = await buildApp({ env: env({ AGENT_DAILY_USD: '0.01' }), db, agentLlm: scriptedLlm });
  bare = await buildApp({ env: env(), db });
  await db
    .insert(cplTargets)
    .values({ objectiveKind: 'leads', targetCents: 3000, confirmedAt: NOW });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await bare?.close();
  await harness?.drop();
});

describe('authorization', () => {
  it('needs ads.read to see or run, and ads.request to act', async () => {
    const seller = await login('vendedor_expansao');
    for (const [method, url] of [
      ['GET', '/ads/intelligence/overview'],
      ['GET', '/ads/intelligence/audits'],
      ['POST', '/ads/intelligence/audits'],
      ['POST', `/ads/intelligence/findings/${crypto.randomUUID()}/request`],
      ['POST', `/ads/intelligence/findings/${crypto.randomUUID()}/dismiss`],
      ['POST', '/ads/intelligence/copy-drafts'],
    ] as const) {
      const response = await app.inject({ method, url, cookies: seller.cookies, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    const anonymous = await app.inject({ method: 'GET', url: '/ads/intelligence/overview' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('the audit', () => {
  it('finds what the mirror shows, ranked, and stores the run', async () => {
    const w = await world();
    const marketing = await login('marketing');
    const detail = await audit(marketing.cookies);

    expect(detail.run).toMatchObject({ scope: 'meta', days: 14, status: 'completed' });
    const priorities = detail.findings.map((finding) => finding.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);

    const performance = findingOf(detail, 'campaign_performance', w.campaignExternalId);
    expect(performance).toMatchObject({
      status: 'fail',
      requestable: true,
      state: 'open',
      action: { kind: 'pause_campaign', campaignExternalId: w.campaignExternalId },
    });
    expect(findingOf(detail, 'data_consistency', w.campaignExternalId)).toMatchObject({
      status: 'warn',
    });
    expect(findingOf(detail, 'copy_compliance', w.adExternalId)).toMatchObject({ status: 'warn' });
    expect(findingOf(detail, 'ad_policy', w.adExternalId)).toMatchObject({ status: 'fail' });
    // Meta's main recommendation for the account, off by default.
    expect(findingOf(detail, 'conversions_api')).toMatchObject({
      status: 'fail',
      impact: 'high',
      platform: 'meta',
    });
    // A Google audit never reads the Meta account, and says when there is nothing to read.
    const google = await audit(marketing.cookies, { scope: 'google', days: 7 });
    expect(google.findings.every((finding) => finding.platform !== 'meta')).toBe(true);
    expect(google.findings[0]).toMatchObject({ check: 'data_freshness', status: 'unknown' });

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'ads.audit_run'), eq(auditLog.entityId, detail.run.id)));
    expect(entry?.actorEmployeeId).toBe(marketing.employeeId);

    const listed = await app.inject({
      method: 'GET',
      url: `/ads/intelligence/audits/${detail.run.id}`,
      cookies: marketing.cookies,
    });
    expect(listed.json<AuditRunDetail>().findings).toHaveLength(detail.findings.length);
  });

  it('refuses a window the dashboard does not have', async () => {
    const marketing = await login('marketing');
    const response = await app.inject({
      method: 'POST',
      url: '/ads/intelligence/audits',
      cookies: marketing.cookies,
      payload: { scope: 'meta', days: 3 },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('from a finding to a request', () => {
  it('makes one request in the person’s name, waiting for approval, and nothing runs', async () => {
    const w = await world();
    const marketing = await login('marketing');
    const finding = findingOf(
      await audit(marketing.cookies),
      'campaign_performance',
      w.campaignExternalId,
    );
    if (!finding) throw new Error('no finding');

    // Two clicks at once, as two API instances would see them: exactly one request.
    const [a, b] = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: 'POST',
          url: `/ads/intelligence/findings/${finding.id}/request`,
          cookies: marketing.cookies,
        }),
      ),
    );
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([201, 409]);

    const changes = await db
      .select()
      .from(adChangeRequests)
      .where(eq(adChangeRequests.adAccountId, w.accountId));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'pause_campaign',
      status: 'pending_approval',
      requestedBy: marketing.employeeId,
      requestedByAgent: false,
      suggestedByAgent: true,
    });
    const stored = await db.query.adAuditFindings.findFirst({
      where: eq(adAuditFindings.id, finding.id),
    });
    expect(stored).toMatchObject({ state: 'requested', changeRequestId: changes[0]?.id });
    expect(await db.select().from(adExecutions)).toHaveLength(0);
    expect(w.client.calls.filter((call) => call.method === 'pauseCampaign')).toHaveLength(0);

    const again = await app.inject({
      method: 'POST',
      url: `/ads/intelligence/findings/${finding.id}/request`,
      cookies: marketing.cookies,
    });
    expect(again.statusCode).toBe(409);
  });

  it('a locked account refuses through the guard, and the finding says so', async () => {
    const w = await world();
    const marketing = await login('marketing');
    const finding = findingOf(
      await audit(marketing.cookies),
      'campaign_performance',
      w.campaignExternalId,
    );
    await db
      .update(adAccounts)
      .set({ killSwitchEngaged: true, killSwitchReason: 'teste' })
      .where(eq(adAccounts.id, w.accountId));

    const response = await app.inject({
      method: 'POST',
      url: `/ads/intelligence/findings/${finding?.id}/request`,
      cookies: marketing.cookies,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'kill_switch_engaged' });
    const stored = await db.query.adAuditFindings.findFirst({
      where: eq(adAuditFindings.id, finding!.id),
    });
    expect(stored?.state).toBe('refused');
    expect(
      await db.select().from(adChangeRequests).where(eq(adChangeRequests.adAccountId, w.accountId)),
    ).toHaveLength(0);
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'audit_finding.refused_by_guard'),
          eq(auditLog.entityId, finding!.id),
        ),
      );
    expect(entry?.metadata).toMatchObject({ reason: 'kill_switch_engaged' });
  });

  it('a finding without a change offers no request; one can be set aside once', async () => {
    const w = await world();
    const marketing = await login('marketing');
    const detail = await audit(marketing.cookies);
    const manual = findingOf(detail, 'copy_compliance', w.adExternalId) as AuditFinding;
    expect(manual.requestable).toBe(false);
    const refused = await app.inject({
      method: 'POST',
      url: `/ads/intelligence/findings/${manual.id}/request`,
      cookies: marketing.cookies,
    });
    expect(refused.json()).toMatchObject({ error: 'not_requestable' });

    const dismiss = () =>
      app.inject({
        method: 'POST',
        url: `/ads/intelligence/findings/${manual.id}/dismiss`,
        cookies: marketing.cookies,
      });
    expect((await dismiss()).statusCode).toBe(200);
    expect((await dismiss()).statusCode).toBe(409);
  });
});

describe('connection → audit → recommendation → approval → execution → reconciliation', () => {
  it('runs once, freezes on an unknown outcome, and settles by reading the platform', async () => {
    const w = await world();
    const marketing = await login('marketing');
    const overviewBefore = await app.inject({
      method: 'GET',
      url: '/ads/intelligence/overview',
      cookies: marketing.cookies,
    });
    const overview = overviewBefore.json<IntelligenceOverview>();
    // No token in this environment: the screen shows "conexão pendente", never invented data.
    expect(overview.credentials).toEqual({ meta: false, google: false });
    expect(overview.accounts.some((account) => account.externalId === w.accountExternalId)).toBe(
      true,
    );
    expect(overview.conversionsApi.enabled).toBe(false);

    const finding = findingOf(
      await audit(marketing.cookies),
      'campaign_performance',
      w.campaignExternalId,
    );
    const requested = await app.inject({
      method: 'POST',
      url: `/ads/intelligence/findings/${finding?.id}/request`,
      cookies: marketing.cookies,
    });
    expect(requested.statusCode).toBe(201);
    const { changeRequestId, approvalId } = requested.json<{
      changeRequestId: string;
      approvalId: string;
    }>();
    expect(approvalId).toBeTruthy();

    // Marketing asks; it cannot approve.
    const selfApprove = await decideApproval(db, {
      approvalId,
      approverEmployeeId: marketing.employeeId,
      decision: 'approved',
      reason: 'eu mesmo',
    });
    expect(selfApprove.ok).toBe(false);

    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const decision = await decideApproval(db, {
      approvalId,
      approverEmployeeId: admin.id,
      decision: 'approved',
      reason: 'auditoria conferida',
    });
    expect(decision.ok).toBe(true);
    // Approved is not executed.
    expect((await w.client.getCampaign(w.campaignExternalId))?.status).toBe('ACTIVE');

    // The platform applies the pause and the answer is lost: the outcome is unknown.
    w.client.injectFailure({ kind: 'timeout_after_apply' });
    const executed = await executeApprovedChange(db, w.client, changeRequestId, {
      allowWrites: true,
      actorEmployeeId: admin.id,
    });
    expect(executed).toMatchObject({ outcome: 'unknown' });
    // Nothing repeats it: a second press is refused.
    const again = await executeApprovedChange(db, w.client, changeRequestId, { allowWrites: true });
    expect(again).toMatchObject({ outcome: 'refused' });
    expect(w.client.calls.filter((call) => call.method === 'pauseCampaign')).toHaveLength(1);

    // The next audit sees the frozen account and the unknown outcome.
    const frozen = await audit(marketing.cookies);
    const ownPending = frozen.findings.find(
      (item) =>
        item.check === 'pending_operations' && item.title.includes(w.accountExternalId.slice(4)),
    );
    expect(ownPending?.status).toBe('fail');

    const resolved = await resolveUnknownExecution(db, w.client, changeRequestId);
    expect(resolved).toMatchObject({ ok: true, value: { resolution: 'applied' } });
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeRequestId),
    });
    expect(change?.status).toBe('executed');
    expect((await w.client.getCampaign(w.campaignExternalId))?.status).toBe('PAUSED');
    expect(w.client.calls.filter((call) => call.method === 'pauseCampaign')).toHaveLength(1);

    const history = (
      await app.inject({
        method: 'GET',
        url: '/ads/intelligence/overview',
        cookies: marketing.cookies,
      })
    ).json<IntelligenceOverview>();
    expect(history.operations.find((op) => op.id === changeRequestId)).toMatchObject({
      status: 'executed',
      suggestedByAgent: true,
    });
  });
});

describe('evaluateAudit (no database)', () => {
  const empty: AuditSnapshot = {
    now: NOW,
    scope: 'all',
    days: 14,
    accounts: [],
    campaigns: [],
    health: [],
    alerts: [],
    unknownChanges: new Map(),
    staleApprovals: new Map(),
    activeAds: [],
    consistency: [],
    capi: {
      enabled: true,
      pixelId: '1',
      last7Days: { sent: 4, skipped: 0, failed: 0, pending: 0 },
      lastSentAt: null,
      lastError: null,
    },
    comparison: [],
  };

  it('says "not connected" per platform instead of a pass', () => {
    const drafts = evaluateAudit(empty);
    expect(drafts.filter((draft) => draft.check === 'data_freshness')).toHaveLength(2);
    expect(drafts.find((draft) => draft.check === 'conversions_api')?.status).toBe('pass');
  });

  it('a stale mirror fails, a late reconciliation warns, and money figures come from the period', () => {
    const account = (lastSyncedAt: Date | null, reconciled: Date | null) => ({
      id: crypto.randomUUID(),
      platform: 'meta' as const,
      name: 'Conta',
      externalId: 'act_1',
      killSwitchEngaged: false,
      killSwitchReason: null,
      lastSyncedAt,
      period: {
        id: 'p',
        capCents: 100_000,
        usableCents: 70_000,
        committedCents: 66_000,
        spentCents: 10_000,
        platformRemainingCents: null,
        platformLimitSource: null,
        platformLimitSyncedAt: null,
        platformLimitNote: null,
        lastReconciledAt: reconciled,
        availableCents: 4_000,
      },
    });
    const old = new Date(NOW.getTime() - 30 * 3_600_000);
    const late = new Date(NOW.getTime() - 200 * 60_000);
    const drafts = evaluateAudit({
      ...empty,
      scope: 'meta',
      accounts: [account(old, NOW), account(NOW, late)],
    });
    const freshness = drafts.filter((draft) => draft.check === 'data_freshness');
    expect(freshness.map((draft) => draft.status)).toEqual(['fail', 'warn']);
    const headroom = drafts.find((draft) => draft.check === 'budget_headroom');
    expect(headroom).toMatchObject({ status: 'warn' });
    expect(headroom?.detail).toMatch(/R\$\s660,00/);
  });
});

describe('AI ad packages', () => {
  const variation = (overrides: Record<string, unknown> = {}) => ({
    headline: 'Sua marca em outras cidades',
    primaryText: 'A Wings estrutura sua franquia com método e suporte.',
    callToAction: 'LEARN_MORE',
    angle: 'benefício',
    ...overrides,
  });

  it('answers 503 without the model key, never an invented ad', async () => {
    const employee = await createEmployee(db, { role: 'marketing', sector: 'diretoria' });
    const response = await bare.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: employee.email, password: employee.password },
    });
    const token = response.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
    const generate = await bare.inject({
      method: 'POST',
      url: '/ads/intelligence/copy-drafts',
      cookies: { [SESSION_COOKIE]: token },
      payload: { platform: 'meta', objective: 'leads', product: 'Formatação de franquias' },
    });
    expect(generate.statusCode).toBe(503);
  });

  it('keeps only what passes the rules, stores it for its author, and holds the daily ceiling', async () => {
    const marketing = await login('marketing');
    let seen: LlmRequest | null = null;
    script = [
      (request) => {
        seen = request;
        return {
          toolCalls: [
            {
              id: 'c1',
              name: 'registrar_pacote',
              arguments: JSON.stringify({
                variations: [
                  variation(),
                  variation({ headline: 'Lucro garantido', angle: 'promessa' }),
                  variation({
                    primaryText: 'Fature R$ 50 mil por mês com a sua marca.',
                    angle: 'número',
                  }),
                  variation({ primaryText: 'Mais de 300 marcas formatadas.', angle: 'autoridade' }),
                ],
                creativeBrief: 'Dono de loja em frente ao negócio; vídeo vertical de 15 segundos.',
                videoScript: [
                  { seconds: 3, visual: 'Fachada da loja', text: 'Sua marca pode crescer' },
                  { seconds: 4, visual: 'Mapa', text: '120 unidades em 2 anos' },
                ],
              }),
            },
          ],
        };
      },
    ];
    const response = await app.inject({
      method: 'POST',
      url: '/ads/intelligence/copy-drafts',
      cookies: marketing.cookies,
      payload: {
        platform: 'meta',
        objective: 'leads',
        product: 'Formatação de franquias',
        facts: 'Mais de 300 marcas formatadas. Contato: fulano@example.com',
        variations: 4,
      },
    });
    expect(response.statusCode).toBe(201);
    const { draft } = response.json<{ draft: AdCopyDraft }>();
    expect(draft.package?.variations.map((item) => item.angle)).toEqual([
      'benefício',
      'autoridade',
    ]);
    expect(draft.refused).toHaveLength(2);
    expect(draft.refused.find((item) => item.headline === 'Lucro garantido')).toBeTruthy();
    expect(draft.package?.videoScript).toHaveLength(1);
    // What reached the model had the e-mail scrubbed, and the forced tool.
    expect(JSON.stringify(seen!.messages)).not.toContain('fulano@example.com');
    expect(seen!.toolChoice).toBe('registrar_pacote');

    const other = await login('marketing');
    const theirs = await app.inject({
      method: 'GET',
      url: '/ads/intelligence/copy-drafts',
      cookies: other.cookies,
    });
    expect(theirs.json<{ drafts: AdCopyDraft[] }>().drafts).toEqual([]);

    // US$ 0.004 + US$ 0.008 against a US$ 0.01 ceiling: the third is refused before the model is called.
    script = [
      () => ({ toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.008 } }),
    ];
    await app.inject({
      method: 'POST',
      url: '/ads/intelligence/copy-drafts',
      cookies: marketing.cookies,
      payload: {
        platform: 'google_search',
        objective: 'leads',
        product: 'Formatação de franquias',
      },
    });
    const capped = await app.inject({
      method: 'POST',
      url: '/ads/intelligence/copy-drafts',
      cookies: marketing.cookies,
      payload: {
        platform: 'google_search',
        objective: 'leads',
        product: 'Formatação de franquias',
      },
    });
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toMatchObject({ error: 'daily_limit' });
  });
});
