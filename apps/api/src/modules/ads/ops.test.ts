import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAds,
  adAlerts,
  adCampaigns,
  adChangeRequests,
  auditLog,
  budgetPeriods,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { decideApproval } from './approvals.js';
import { engageKillSwitch, getPeriodState, openPeriod } from './budget-guard.js';
import { executeApprovedChange } from './executor.js';
import {
  accountsStatus,
  openAlerts,
  releaseKillSwitchOnRecord,
  renderAlertsSheet,
  requestCampaignChange,
  resolveUnknownExecution,
} from './ops.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';

/**
 * The operator's side of a supervised write: asking, looking, and clearing an
 * emergency. The last describe walks the whole first-write path end to end,
 * the way docs/ads/primeira-escrita.md tells a person to.
 */

const PERIOD_NOW = new Date();
const PERIOD = `${new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
})
  .format(PERIOD_NOW)
  .slice(0, 7)}-01`;

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

interface World {
  accountId: string;
  accountExternalId: string;
  campaignExternalId: string;
  client: FakeMetaClient;
}

async function world(): Promise<World> {
  const accountExternalId = `act_${randomBytes(4).toString('hex')}`;
  const campaignExternalId = `c_${randomBytes(4).toString('hex')}`;
  const client = new FakeMetaClient({
    accountId: accountExternalId,
    campaigns: [
      { id: campaignExternalId, name: 'Institucional', status: 'ACTIVE', dailyBudgetCents: 2000 },
    ],
  });
  Object.defineProperty(client, 'isLive', { value: true });

  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId: accountExternalId, name: 'Fly High' })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed');
  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: PERIOD,
    capCents: 400_000,
    usablePercent: 70,
  });
  await db.insert(adCampaigns).values({
    adAccountId: account.id,
    externalId: campaignExternalId,
    name: 'Institucional',
    status: 'ACTIVE',
    dailyBudgetCents: 2000,
    budgetLevel: 'campaign',
  });
  await db
    .update(budgetPeriods)
    .set({ lastReconciledAt: new Date() })
    .where(eq(budgetPeriods.adAccountId, account.id));

  return { accountId: account.id, accountExternalId, campaignExternalId, client };
}

async function approve(approvalId: string): Promise<string> {
  const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
  const decision = await decideApproval(db, {
    approvalId,
    approverEmployeeId: admin.id,
    decision: 'approved',
    reason: 'primeira escrita supervisionada',
  });
  if (!decision.ok) throw new Error(decision.message);
  return admin.id;
}

describe('asking for a change', () => {
  it('always lands in front of an approver, and sends nothing to the platform', async () => {
    const w = await world();
    const result = await requestCampaignChange(db, {
      accountExternalId: w.accountExternalId,
      campaignExternalId: w.campaignExternalId,
      kind: 'pause_campaign',
      reason: 'frequência 11,3 — pausa combinada com o gestor',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending_approval');
    expect(result.value.approvalId).toBeTruthy();
    // A pause can only lower exposure.
    expect(result.value.exposureDeltaCents).toBeLessThanOrEqual(0);
    expect(w.client.calls.filter((call) => call.method === 'pauseCampaign')).toHaveLength(0);
  });

  it('refuses a campaign of another account', async () => {
    const mine = await world();
    const theirs = await world();
    const result = await requestCampaignChange(db, {
      accountExternalId: mine.accountExternalId,
      campaignExternalId: theirs.campaignExternalId,
      kind: 'pause_campaign',
      reason: 'teste',
    });
    expect(result).toMatchObject({ ok: false, reason: 'campaign_not_found' });
  });

  it('is refused while the kill switch is engaged', async () => {
    const w = await world();
    await engageKillSwitch(db, w.accountId, 'teste');
    const result = await requestCampaignChange(db, {
      accountExternalId: w.accountExternalId,
      campaignExternalId: w.campaignExternalId,
      kind: 'pause_campaign',
      reason: 'teste',
    });
    expect(result).toMatchObject({ ok: false, reason: 'reservation_refused' });
  });
});

describe('releasing the kill switch', () => {
  it('releases on the record', async () => {
    const w = await world();
    await engageKillSwitch(db, w.accountId, 'Reconciliação parada há 300 min');

    const result = await releaseKillSwitchOnRecord(db, {
      accountExternalId: w.accountExternalId,
      reason: 'ingestão voltou; gasto conferido no Gerenciador',
    });
    expect(result).toMatchObject({ ok: true });

    const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, w.accountId) });
    expect(account?.killSwitchEngaged).toBe(false);
    const audit = await db.query.auditLog.findMany({ where: eq(auditLog.entityId, w.accountId) });
    expect(audit.some((entry) => entry.action === 'ads.kill_switch_released')).toBe(true);
  });

  it('refuses when there is nothing to release', async () => {
    const w = await world();
    const result = await releaseKillSwitchOnRecord(db, {
      accountExternalId: w.accountExternalId,
      reason: 'teste',
    });
    expect(result).toMatchObject({ ok: false, reason: 'kill_switch_not_engaged' });
  });
});

describe('the first write, end to end', () => {
  it('request → approve → execute → the platform shows the pause', async () => {
    const w = await world();

    const requested = await requestCampaignChange(db, {
      accountExternalId: w.accountExternalId,
      campaignExternalId: w.campaignExternalId,
      kind: 'pause_campaign',
      reason: 'primeira escrita supervisionada',
    });
    if (!requested.ok || !requested.value.approvalId) throw new Error('request failed');
    const committedBefore = (await getPeriodState(db, w.accountId, PERIOD))?.committedCents;

    // Approved is not executed: nothing has moved yet.
    const adminId = await approve(requested.value.approvalId);
    expect((await w.client.getCampaign(w.campaignExternalId))?.status).toBe('ACTIVE');

    const executed = await executeApprovedChange(db, w.client, requested.value.changeRequestId, {
      allowWrites: true,
      actorEmployeeId: adminId,
    });
    expect(executed).toMatchObject({ outcome: 'applied' });
    expect((await w.client.getCampaign(w.campaignExternalId))?.status).toBe('PAUSED');

    const mirrored = await db.query.adCampaigns.findFirst({
      where: eq(adCampaigns.externalId, w.campaignExternalId),
    });
    expect(mirrored?.status).toBe('PAUSED');
    expect((await getPeriodState(db, w.accountId, PERIOD))?.committedCents).toBe(committedBefore);

    // A second press does nothing.
    const again = await executeApprovedChange(db, w.client, requested.value.changeRequestId, {
      allowWrites: true,
    });
    expect(again).toMatchObject({ outcome: 'refused', reason: 'already_executed' });
    expect(w.client.calls.filter((call) => call.method === 'pauseCampaign')).toHaveLength(1);
  });

  it('with writes off, the same press is refused and the platform is untouched', async () => {
    const w = await world();
    const requested = await requestCampaignChange(db, {
      accountExternalId: w.accountExternalId,
      campaignExternalId: w.campaignExternalId,
      kind: 'pause_campaign',
      reason: 'teste',
    });
    if (!requested.ok || !requested.value.approvalId) throw new Error('request failed');
    await approve(requested.value.approvalId);

    const result = await executeApprovedChange(db, w.client, requested.value.changeRequestId, {
      allowWrites: false,
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'writes_disabled' });
    expect((await w.client.getCampaign(w.campaignExternalId))?.status).toBe('ACTIVE');
  });

  it('a timeout freezes the account, and the freeze cannot be lifted before the truth is read', async () => {
    const w = await world();
    const requested = await requestCampaignChange(db, {
      accountExternalId: w.accountExternalId,
      campaignExternalId: w.campaignExternalId,
      kind: 'pause_campaign',
      reason: 'teste',
    });
    if (!requested.ok || !requested.value.approvalId) throw new Error('request failed');
    await approve(requested.value.approvalId);

    // The platform applies the pause, then the answer is lost.
    w.client.injectFailure({ kind: 'timeout_after_apply' });
    const executed = await executeApprovedChange(db, w.client, requested.value.changeRequestId, {
      allowWrites: true,
    });
    expect(executed).toMatchObject({ outcome: 'unknown' });

    const [status] = (await accountsStatus(db)).filter(
      (entry) => entry.externalId === w.accountExternalId,
    );
    expect(status).toMatchObject({ killSwitchEngaged: true, changes: { unknown: 1 } });

    const early = await releaseKillSwitchOnRecord(db, {
      accountExternalId: w.accountExternalId,
      reason: 'pressa',
    });
    expect(early).toMatchObject({ ok: false, reason: 'unresolved_execution' });

    const resolved = await resolveUnknownExecution(db, w.client, requested.value.changeRequestId);
    expect(resolved).toMatchObject({ ok: true, value: { resolution: 'applied' } });
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, requested.value.changeRequestId),
    });
    expect(change?.status).toBe('executed');

    // Resolving does not lift the freeze; that stays a separate, deliberate act.
    const stillFrozen = await db.query.adAccounts.findFirst({
      where: eq(adAccounts.id, w.accountId),
    });
    expect(stillFrozen?.killSwitchEngaged).toBe(true);

    const released = await releaseKillSwitchOnRecord(db, {
      accountExternalId: w.accountExternalId,
      reason: 'pausa confirmada no Gerenciador',
    });
    expect(released).toMatchObject({ ok: true });
  });

  it('a lost request that never landed hands its reservation back', async () => {
    const w = await world();
    const requested = await requestCampaignChange(db, {
      accountExternalId: w.accountExternalId,
      campaignExternalId: w.campaignExternalId,
      kind: 'pause_campaign',
      reason: 'teste',
    });
    if (!requested.ok || !requested.value.approvalId) throw new Error('request failed');
    await approve(requested.value.approvalId);

    w.client.injectFailure({ kind: 'transient' });
    const executed = await executeApprovedChange(db, w.client, requested.value.changeRequestId, {
      allowWrites: true,
    });
    expect(executed).toMatchObject({ outcome: 'unknown' });

    const resolved = await resolveUnknownExecution(db, w.client, requested.value.changeRequestId);
    expect(resolved).toMatchObject({ ok: true, value: { resolution: 'not_applied' } });

    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, requested.value.changeRequestId),
    });
    expect(change).toMatchObject({ status: 'failed', reservationActive: false });
    // Never retried: the same change stays refused, a new request is required.
    const retry = await executeApprovedChange(db, w.client, requested.value.changeRequestId, {
      allowWrites: true,
    });
    expect(retry.outcome).toBe('refused');
  });
});

describe('the alerts sheet', () => {
  it('names the ad, its campaign and the frequency, worst first', async () => {
    const w = await world();
    const campaign = await db.query.adCampaigns.findFirst({
      where: eq(adCampaigns.externalId, w.campaignExternalId),
    });
    await db.insert(adAds).values({
      adAccountId: w.accountId,
      campaignId: campaign?.id,
      externalId: 'ad_tired',
      name: 'Vídeo depoimento 02',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
    });
    const fatigue = (externalId: string, frequencyMilli: number) => ({
      adAccountId: w.accountId,
      kind: 'creative_fatigue' as const,
      severity: 'warning' as const,
      entityLevel: 'ad' as const,
      entityExternalId: externalId,
      title: `Criativo desgastado (frequência ${(frequencyMilli / 1000).toFixed(1)})`,
      detail: {
        frequencyMilli,
        thresholdMilli: 3000,
        maxDailyFrequencyMilli: 1400,
        impressions: 9000,
        maxDailyReach: 800,
        spendCents: 12345,
        lookbackDays: 7,
        estimate: 'impressões ÷ maior alcance diário (limite superior)',
      },
    });
    await db.insert(adAlerts).values([fatigue('ad_mild', 3000), fatigue('ad_tired', 11_300)]);

    const alerts = (await openAlerts(db)).filter((alert) => alert.accountName === 'Fly High');
    const mine = alerts.filter((alert) =>
      ['ad_mild', 'ad_tired'].includes(alert.entityExternalId ?? ''),
    );
    expect(mine.map((alert) => alert.entityExternalId)).toEqual(['ad_tired', 'ad_mild']);
    expect(mine[0]).toMatchObject({
      adName: 'Vídeo depoimento 02',
      campaignName: 'Institucional',
      campaignExternalId: w.campaignExternalId,
    });

    const sheet = renderAlertsSheet(mine);
    expect(sheet).toContain('11.3');
    expect(sheet).toContain('Vídeo depoimento 02');
    expect(sheet).toContain('R$ 123,45');
    expect(sheet).toContain('☐ verdadeiro ☐ falso ☐ depende');
  });
});
