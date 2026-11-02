import { randomBytes } from 'node:crypto';
import { campaignDraftSchema, type CampaignDraft } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCampaignDrafts,
  adCampaigns,
  adChangeRequests,
  budgetPeriods,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { decideApproval, gateChange } from './approvals.js';
import { getPeriodState, openPeriod, reserveCampaignCreation } from './budget-guard.js';
import { executeApprovedChange } from './executor.js';
import { releaseKillSwitchOnRecord, resolveUnknownExecution } from './ops.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';

/**
 * The sacrifice-campaign path, rehearsed against the fake client: a campaign
 * the system creates itself, born paused, so the first real write never has to
 * touch a campaign that is running. Asking creates nothing; only an approved
 * request, executed by a person with writes enabled, reaches the platform.
 */

const NOW = new Date();
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(NOW);
const PERIOD = `${TODAY.slice(0, 7)}-01`;

let harness: TestDatabase;
let db: Database;

// Today and this month are read once, at load, and the code reads its own clock: stopped at that
// instant, a midnight or a month turning during the run cannot set the two apart.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});

afterAll(() => {
  vi.useRealTimers();
});

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

/**
 * A draft as they were approved before ad sets existed: no page, no placements,
 * no age range. Those still execute as what they were approved to be — the
 * campaign shell alone — and that path is what this file rehearses. The full
 * tree has its own file, `meta-ad-tree.test.ts`.
 */
function draftOf(overrides: Partial<CampaignDraft> = {}): CampaignDraft {
  const shell = { ...fullDraftOf(overrides) };
  delete shell.identity;
  delete shell.placements;
  delete shell.ageMin;
  delete shell.ageMax;
  return shell;
}

function fullDraftOf(overrides: Partial<CampaignDraft> = {}): CampaignDraft {
  return campaignDraftSchema.parse({
    platform: 'meta',
    name: `Sacrifício ${randomBytes(3).toString('hex')}`,
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP'], cities: [{ name: 'Curitiba', state: 'PR' }] },
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    variations: [
      {
        creativeId: '11111111-1111-4111-8111-111111111111',
        headline: 'Leve a Wings',
        primaryText: 'Fale com a gente.',
        callToAction: 'LEARN_MORE',
      },
      {
        creativeId: '22222222-2222-4222-8222-222222222222',
        headline: 'Seja franqueado',
        primaryText: 'Suporte completo.',
        callToAction: 'CONTACT_US',
      },
    ],
    startDate: TODAY,
    endDate: TODAY,
    dailyBudgetCents: 600,
    utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'x', utm_content: 'lead' },
    ageMin: 25,
    ageMax: 65,
    placements: { mode: 'automatic' },
    identity: { pageId: '104567890123456' },
    startPaused: true,
    ...overrides,
  });
}

async function world() {
  const accountExternalId = `act_${randomBytes(4).toString('hex')}`;
  const client = new FakeMetaClient({ accountId: accountExternalId });
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
  await db
    .update(budgetPeriods)
    .set({ lastReconciledAt: new Date() })
    .where(eq(budgetPeriods.adAccountId, account.id));
  return { accountId: account.id, accountExternalId, client };
}

async function requestAndApprove(accountId: string, draft: CampaignDraft) {
  const requester = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
  const reserved = await reserveCampaignCreation(db, {
    adAccountId: accountId,
    draft,
    requestedBy: requester.id,
  });
  if (!reserved.ok) throw new Error(reserved.message);
  const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId });
  if (!gate.approvalId) throw new Error('expected an approval');

  const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
  const decision = await decideApproval(db, {
    approvalId: gate.approvalId,
    approverEmployeeId: admin.id,
    decision: 'approved',
  });
  if (!decision.ok) throw new Error(decision.message);
  return { changeRequestId: reserved.value.changeRequestId, draftId: reserved.value.draftId };
}

describe('asking for a campaign', () => {
  it('stores the draft, reserves nothing for a paused campaign, and touches no platform', async () => {
    const { accountId, client } = await world();
    const draft = draftOf();
    const reserved = await reserveCampaignCreation(db, { adAccountId: accountId, draft });

    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.value.exposureDeltaCents).toBe(0);
    expect((await getPeriodState(db, accountId, PERIOD))?.committedCents).toBe(0);

    const stored = await db.query.adCampaignDrafts.findFirst({
      where: eq(adCampaignDrafts.id, reserved.value.draftId),
    });
    expect(stored?.payload).toEqual(draft);
    expect(stored?.campaignId).toBeNull();
    expect(client.calls).toEqual([]);
  });

  it('always needs a human decision, and is never attributed to an agent', async () => {
    const { accountId } = await world();
    const reserved = await reserveCampaignCreation(db, {
      adAccountId: accountId,
      draft: draftOf(),
    });
    if (!reserved.ok) throw new Error(reserved.message);
    const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId });
    expect(gate.status).toBe('pending_approval');

    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, reserved.value.changeRequestId),
    });
    expect(change?.kind).toBe('create_campaign');
    expect(change?.campaignId).toBeNull();
    expect(change?.requestedByAgent).toBe(false);
    expect(change?.autoApproved).toBe(false);
  });

  it('judges a paused campaign as if it were running, and still reserves nothing', async () => {
    const { accountId } = await world();
    const reserved = await reserveCampaignCreation(db, {
      adAccountId: accountId,
      draft: draftOf({ dailyBudgetCents: 2_000 }),
    });
    // One day (today) × R$ 20 × 1.25 fits under R$ 2.800: accepted, nothing held.
    expect(reserved.ok && reserved.value.exposureDeltaCents).toBe(0);
    expect((await getPeriodState(db, accountId, PERIOD))?.committedCents).toBe(0);
  });

  it('refuses a campaign that would not fit under the ceiling once switched on', async () => {
    const { accountId } = await world();
    const reserved = await reserveCampaignCreation(db, {
      adAccountId: accountId,
      draft: draftOf({ dailyBudgetCents: 300_000 }),
    });
    expect(reserved.ok).toBe(false);
    expect(!reserved.ok && reserved.reason).toBe('usable_would_be_exceeded');
    expect(
      await db.query.adCampaignDrafts.findMany({
        where: eq(adCampaignDrafts.adAccountId, accountId),
      }),
    ).toEqual([]);
  });

  it('refuses under the kill switch, a start in the past and a name already taken', async () => {
    const { accountId } = await world();
    const past = await reserveCampaignCreation(db, {
      adAccountId: accountId,
      draft: draftOf({ startDate: '2020-01-01', endDate: TODAY }),
    });
    expect(!past.ok && past.reason).toBe('start_in_past');

    const draft = draftOf();
    expect((await reserveCampaignCreation(db, { adAccountId: accountId, draft })).ok).toBe(true);
    const twin = await reserveCampaignCreation(db, { adAccountId: accountId, draft });
    expect(!twin.ok && twin.reason).toBe('duplicate_name');

    await db
      .update(adAccounts)
      .set({ killSwitchEngaged: true })
      .where(eq(adAccounts.id, accountId));
    const frozen = await reserveCampaignCreation(db, { adAccountId: accountId, draft: draftOf() });
    expect(!frozen.ok && frozen.reason).toBe('kill_switch_engaged');
  });
});

describe('executing an approved creation', () => {
  it('creates the campaign PAUSED, mirrors it, and refuses a second click', async () => {
    const { accountId, client } = await world();
    const draft = draftOf();
    const { changeRequestId, draftId } = await requestAndApprove(accountId, draft);

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result.outcome).toBe('applied');

    const creates = client.calls.filter((call) => call.method === 'createCampaign');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args[0]).toEqual({
      name: draft.name,
      objective: 'OUTCOME_LEADS',
      status: 'PAUSED',
      dailyBudgetCents: 600,
    });

    const [onPlatform] = await client.listCampaigns();
    expect(onPlatform?.status).toBe('PAUSED');

    const mirrored = await db.query.adCampaigns.findFirst({
      where: eq(adCampaigns.externalId, onPlatform?.id ?? ''),
    });
    expect(mirrored?.status).toBe('PAUSED');
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeRequestId),
    });
    expect(change?.status).toBe('executed');
    expect(change?.campaignId).toBe(mirrored?.id);
    const stored = await db.query.adCampaignDrafts.findFirst({
      where: eq(adCampaignDrafts.id, draftId),
    });
    expect(stored?.campaignId).toBe(mirrored?.id);

    const again = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(again.outcome === 'refused' && again.reason).toBe('already_executed');
    expect(client.calls.filter((call) => call.method === 'createCampaign')).toHaveLength(1);
  });

  it('leaves the platform untouched while writes are disabled', async () => {
    const { accountId, client } = await world();
    const { changeRequestId } = await requestAndApprove(accountId, draftOf());

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: false });
    expect(result.outcome === 'refused' && result.reason).toBe('writes_disabled');
    expect(client.calls).toEqual([]);
  });

  it('refuses without an approval', async () => {
    const { accountId, client } = await world();
    const reserved = await reserveCampaignCreation(db, {
      adAccountId: accountId,
      draft: draftOf(),
    });
    if (!reserved.ok) throw new Error(reserved.message);
    await gateChange(db, { changeRequestId: reserved.value.changeRequestId });

    const result = await executeApprovedChange(db, client, reserved.value.changeRequestId, {
      allowWrites: true,
    });
    expect(result.outcome === 'refused' && result.reason).toBe('not_approved');
    expect(client.calls).toEqual([]);
  });

  it('refuses when the stored draft is not the one that was approved', async () => {
    const { accountId, client } = await world();
    const { changeRequestId, draftId } = await requestAndApprove(accountId, draftOf());
    await db
      .update(adCampaignDrafts)
      .set({ payload: draftOf({ dailyBudgetCents: 999 }) })
      .where(eq(adCampaignDrafts.id, draftId));

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result.outcome === 'refused' && result.reason).toBe('payload_changed');
    expect(client.calls.some((call) => call.method === 'createCampaign')).toBe(false);
  });

  it('refuses to create a twin of a campaign that appeared on the platform', async () => {
    const { accountId, client } = await world();
    const draft = draftOf();
    const { changeRequestId } = await requestAndApprove(accountId, draft);
    await client.createCampaign({
      name: draft.name,
      objective: 'OUTCOME_LEADS',
      status: 'PAUSED',
      dailyBudgetCents: 600,
    });

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result.outcome === 'refused' && result.reason).toBe('platform_drift');
    expect(await client.listCampaigns()).toHaveLength(1);
  });

  it('gives the reservation back when the platform says no', async () => {
    const { accountId, client } = await world();
    const { changeRequestId } = await requestAndApprove(
      accountId,
      draftOf({ dailyBudgetCents: 2_000 }),
    );
    client.injectFailure({ kind: 'reject', code: '1487079', message: 'Budget below the minimum' });

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result.outcome).toBe('rejected');
    expect((await getPeriodState(db, accountId, PERIOD))?.committedCents).toBe(0);
    expect(await client.listCampaigns()).toEqual([]);
  });
});

describe('a creation whose outcome the platform never confirmed', () => {
  it('freezes the account, then settles as created by finding the campaign by name', async () => {
    const { accountId, accountExternalId, client } = await world();
    const draft = draftOf();
    const { changeRequestId } = await requestAndApprove(accountId, draft);
    client.injectFailure({ kind: 'timeout_after_apply' });

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result.outcome).toBe('unknown');
    const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, accountId) });
    expect(account?.killSwitchEngaged).toBe(true);

    // No blind retry, and no release while the doubt stands.
    const retry = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(retry.outcome === 'refused' && retry.reason).toBe('already_executed');
    const early = await releaseKillSwitchOnRecord(db, { accountExternalId, reason: 'cedo demais' });
    expect(early.ok).toBe(false);

    const resolved = await resolveUnknownExecution(db, client, changeRequestId);
    expect(resolved.ok && resolved.value.resolution).toBe('applied');
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeRequestId),
    });
    expect(change?.status).toBe('executed');
    expect(change?.campaignId).not.toBeNull();
    expect(await client.listCampaigns()).toHaveLength(1);
  });

  it('settles as not created when the platform has nothing, and never retries', async () => {
    const { accountId, client } = await world();
    const { changeRequestId } = await requestAndApprove(accountId, draftOf());
    client.injectFailure({ kind: 'transient' });

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result.outcome).toBe('unknown');

    const resolved = await resolveUnknownExecution(db, client, changeRequestId);
    expect(resolved.ok && resolved.value.resolution).toBe('not_applied');
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeRequestId),
    });
    expect(change?.status).toBe('failed');
    expect(await client.listCampaigns()).toEqual([]);
  });
});
