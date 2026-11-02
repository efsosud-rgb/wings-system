import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adApprovalRequests,
  adCampaigns,
  adChangeRequests,
  adExecutions,
  adGuardrailEvents,
  budgetPeriods,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { decideApproval, gateChange } from './approvals.js';
import {
  applyReportedSpend,
  engageKillSwitch,
  exposureOf,
  getPeriodState,
  openPeriod,
  remainingDays,
  reserveChange,
} from './budget-guard.js';
import { executeApprovedChange } from './executor.js';
import { periodMonthOf } from './reconcile.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';

/**
 * Execution is where money finally moves, so these tests are mostly about
 * refusals: every earlier guarantee must still hold at the instant of the
 * write, or nothing happens.
 */

// The executor reads the clock itself (freshness of the month it runs in), so
// the test's month is the real one: a fixed September date broke it the day
// the month turned.
const NOW = new Date();
const PERIOD = periodMonthOf(NOW);
const CAP = 400_000;

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

/** A live-looking client: the executor refuses anything that is not live. */
function liveFake(options: ConstructorParameters<typeof FakeMetaClient>[0] = {}) {
  const client = new FakeMetaClient(options);
  Object.defineProperty(client, 'isLive', { value: true });
  return client;
}

interface Scenario {
  accountId: string;
  campaignId: string;
  externalCampaignId: string;
  changeRequestId: string;
  approvalId: string;
}

async function scenario(
  options: { fromBudget?: number; toBudget?: number; client?: FakeMetaClient } = {},
): Promise<Scenario & { client: FakeMetaClient }> {
  const externalCampaignId = `c_${randomBytes(4).toString('hex')}`;
  const externalAccountId = `act_${randomBytes(4).toString('hex')}`;
  const fromBudget = options.fromBudget ?? 2000;
  const toBudget = options.toBudget ?? 3000;

  const client =
    options.client ??
    liveFake({
      accountId: externalAccountId,
      campaigns: [
        {
          id: externalCampaignId,
          name: 'Institucional',
          status: 'ACTIVE',
          dailyBudgetCents: fromBudget,
        },
      ],
    });

  const [account] = await db
    .insert(adAccounts)
    .values({
      platform: 'meta',
      externalId: options.client?.accountExternalId ?? externalAccountId,
      name: 'Wings Matriz',
    })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed');

  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: PERIOD,
    capCents: CAP,
    usablePercent: 70,
  });
  // The executor only writes to an account whose spend is freshly known.
  await db
    .update(budgetPeriods)
    .set({ lastReconciledAt: new Date() })
    .where(eq(budgetPeriods.adAccountId, account.id));

  const [campaign] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: account.id,
      externalId: externalCampaignId,
      name: 'Institucional',
      status: 'ACTIVE',
      dailyBudgetCents: fromBudget,
      budgetLevel: 'campaign',
    })
    .returning({ id: adCampaigns.id });
  if (!campaign) throw new Error('failed');

  const reserved = await reserveChange(db, {
    adAccountId: account.id,
    campaignId: campaign.id,
    kind: 'set_daily_budget',
    toDailyBudgetCents: toBudget,
    now: NOW,
  });
  if (!reserved.ok) throw new Error(`reservation refused: ${reserved.reason}`);

  const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId, now: NOW });

  return {
    accountId: account.id,
    campaignId: campaign.id,
    externalCampaignId,
    changeRequestId: reserved.value.changeRequestId,
    approvalId: gate.approvalId ?? '',
    client,
  };
}

async function approve(approvalId: string): Promise<void> {
  const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
  const decision = await decideApproval(db, {
    approvalId,
    approverEmployeeId: admin.id,
    decision: 'approved',
    now: NOW,
  });
  if (!decision.ok) throw new Error(`approval failed: ${decision.reason}`);
}

describe('nothing executes without approval', () => {
  it('refuses a change that is merely pending', async () => {
    const s = await scenario();
    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });

    expect(result).toMatchObject({ outcome: 'refused', reason: 'not_approved' });
    expect(s.client.calls.some((call) => call.method === 'setDailyBudget')).toBe(false);
  });

  it('refuses a rejected change', async () => {
    const s = await scenario();
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    await decideApproval(db, {
      approvalId: s.approvalId,
      approverEmployeeId: admin.id,
      decision: 'rejected',
      reason: 'não agora',
      now: NOW,
    });

    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'not_approved' });
  });

  it('refuses when the change drifted after approval', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    await db
      .update(adChangeRequests)
      .set({ payloadHash: 'tampered' })
      .where(eq(adChangeRequests.id, s.changeRequestId));

    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'payload_changed' });
  });
});

describe('writes are off unless explicitly enabled', () => {
  it('refuses when writes are not allowed', async () => {
    const s = await scenario();
    await approve(s.approvalId);

    const result = await executeApprovedChange(db, s.client, s.changeRequestId);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'writes_disabled' });
    expect(s.client.calls.some((call) => call.method === 'setDailyBudget')).toBe(false);
  });
});

describe('the guardrails still apply at the moment of writing', () => {
  it('refuses while the kill switch is engaged', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    await engageKillSwitch(db, s.accountId, 'teste');

    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'kill_switch_engaged' });
  });

  it('refuses when the account never reconciled — the dead-man switch, seen from the write path', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    await db
      .update(budgetPeriods)
      .set({ lastReconciledAt: null })
      .where(eq(budgetPeriods.adAccountId, s.accountId));

    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'reconciliation_stale' });
    expect(s.client.calls.filter((call) => call.method === 'setDailyBudget')).toHaveLength(0);
  });

  it('refuses when the last reconciliation is older than the window', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    await db
      .update(budgetPeriods)
      .set({ lastReconciledAt: new Date(Date.now() - 121 * 60_000) })
      .where(eq(budgetPeriods.adAccountId, s.accountId));

    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'reconciliation_stale' });

    // A refusal is evidence, and it is reversible: nothing was frozen, the
    // change is still approved, and a fresh reconciliation lets it through.
    const events = await db.query.adGuardrailEvents.findMany({
      where: eq(adGuardrailEvents.adAccountId, s.accountId),
    });
    expect(events.some((event) => event.kind === 'reconciliation_stale')).toBe(true);

    await db
      .update(budgetPeriods)
      .set({ lastReconciledAt: new Date() })
      .where(eq(budgetPeriods.adAccountId, s.accountId));
    const retry = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });
    expect(retry).toMatchObject({ outcome: 'applied' });
  });

  it('refuses a client bound to a different account', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    const stranger = liveFake({
      accountId: 'act_someone_else',
      campaigns: [{ id: s.externalCampaignId, name: 'Institucional', dailyBudgetCents: 2000 }],
    });

    const result = await executeApprovedChange(db, stranger, s.changeRequestId, {
      allowWrites: true,
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'wrong_account' });
    expect(stranger.calls.filter((call) => call.method === 'setDailyBudget')).toHaveLength(0);
  });

  it('refuses once reported spend has eaten the month', async () => {
    const s = await scenario();
    await approve(s.approvalId);

    // Spend arrives after approval and consumes the month. Recording it trims
    // the commitment and engages the kill switch, which is what then blocks
    // the execution — the database constraint makes any other outcome
    // impossible.
    const state = await getPeriodState(db, s.accountId, PERIOD);
    const applied = await applyReportedSpend(db, {
      periodId: state?.id ?? '',
      spentCents: CAP - 100,
      now: NOW,
    });
    expect(applied.killSwitchEngaged).toBe(true);

    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });
    expect(result).toMatchObject({ outcome: 'refused' });
    expect(s.client.calls.some((call) => call.method === 'setDailyBudget')).toBe(false);
  });

  it('refuses when the campaign changed on the platform since approval', async () => {
    const s = await scenario({ fromBudget: 2000 });
    await approve(s.approvalId);

    // Someone edited the budget in Ads Manager in the meantime.
    await s.client.setDailyBudget(s.externalCampaignId, 9000);

    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'platform_drift' });

    // The reservation is handed back, and the drift is recorded. What stays
    // committed is the campaign as mirrored: it is still running.
    const state = await getPeriodState(db, s.accountId, PERIOD);
    expect(state?.committedCents).toBe(exposureOf(2000, remainingDays(NOW)));
    const events = await db.query.adGuardrailEvents.findMany({
      where: eq(adGuardrailEvents.adAccountId, s.accountId),
    });
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('a successful execution', () => {
  it('applies the change and records it', async () => {
    const s = await scenario({ fromBudget: 2000, toBudget: 3000 });
    await approve(s.approvalId);

    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });

    expect(result).toMatchObject({ ok: true, outcome: 'applied' });
    // The platform really changed.
    expect((await s.client.getCampaign(s.externalCampaignId))?.dailyBudgetCents).toBe(3000);
    // Our mirror matches.
    const campaign = await db.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, s.campaignId),
    });
    expect(campaign?.dailyBudgetCents).toBe(3000);

    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, s.changeRequestId),
    });
    expect(change?.status).toBe('executed');
    expect(change?.executedAt).toBeTruthy();
  });

  it('refuses to execute the same change twice', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    await executeApprovedChange(db, s.client, s.changeRequestId, { allowWrites: true });

    const second = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });
    expect(second).toMatchObject({ outcome: 'refused', reason: 'already_executed' });
  });
});

describe('a platform rejection', () => {
  it('gives the budget back and marks the change failed', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    s.client.injectFailure({ kind: 'reject', code: '1487079', message: 'budget below minimum' });

    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });

    expect(result).toMatchObject({ outcome: 'rejected', code: '1487079' });
    // The increase leaves the commitment; the campaign as it runs stays.
    const state = await getPeriodState(db, s.accountId, PERIOD);
    expect(state?.committedCents).toBe(exposureOf(2000, remainingDays(NOW)));
  });
});

describe('an unknown outcome — the dangerous case', () => {
  it('freezes the account instead of retrying', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    // The change lands on the platform, then the response is lost.
    s.client.injectFailure({ kind: 'timeout_after_apply' });

    const result = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });

    expect(result).toMatchObject({ outcome: 'unknown' });

    // The budget is NOT released: the money may well be committed.
    const state = await getPeriodState(db, s.accountId, PERIOD);
    expect(state?.committedCents).toBeGreaterThan(0);

    // The account is frozen until a human or reconciliation resolves it.
    const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, s.accountId) });
    expect(account?.killSwitchEngaged).toBe(true);

    const events = await db.query.adGuardrailEvents.findMany({
      where: eq(adGuardrailEvents.adAccountId, s.accountId),
    });
    expect(events.some((e) => e.kind === 'unknown_execution_outcome')).toBe(true);
  });

  it('refuses a retry while the outcome is still unknown', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    s.client.injectFailure({ kind: 'timeout_after_apply' });
    await executeApprovedChange(db, s.client, s.changeRequestId, { allowWrites: true });

    // Even with the kill switch lifted, the unresolved attempt blocks a retry.
    await db
      .update(adAccounts)
      .set({ killSwitchEngaged: false })
      .where(eq(adAccounts.id, s.accountId));
    await db
      .update(adChangeRequests)
      .set({ status: 'approved' })
      .where(eq(adChangeRequests.id, s.changeRequestId));

    const retry = await executeApprovedChange(db, s.client, s.changeRequestId, {
      allowWrites: true,
    });
    expect(retry).toMatchObject({ outcome: 'refused', reason: 'already_executed' });
  });
});

describe('evidence', () => {
  it('records an execution row before the call, so an interrupted process leaves a trace', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    await executeApprovedChange(db, s.client, s.changeRequestId, { allowWrites: true });

    const executions = await db.query.adExecutions.findMany({
      where: eq(adExecutions.changeRequestId, s.changeRequestId),
    });
    expect(executions).toHaveLength(1);
    expect(executions[0]?.idempotencyKey).toBeTruthy();
    expect(executions[0]?.outcome).toBe('applied');
  });

  it('keeps everything under the single tenant', async () => {
    const s = await scenario();
    await approve(s.approvalId);
    await executeApprovedChange(db, s.client, s.changeRequestId, { allowWrites: true });

    const execution = await db.query.adExecutions.findFirst({
      where: eq(adExecutions.changeRequestId, s.changeRequestId),
    });
    const approval = await db.query.adApprovalRequests.findFirst({
      where: eq(adApprovalRequests.changeRequestId, s.changeRequestId),
    });
    expect(execution?.tenantId).toBe('00000000-0000-0000-0000-000000000001');
    expect(approval?.tenantId).toBe('00000000-0000-0000-0000-000000000001');
  });
});
