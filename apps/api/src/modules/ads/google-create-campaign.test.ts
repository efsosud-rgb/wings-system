import { randomBytes } from 'node:crypto';
import { campaignDraftSchema, type CampaignDraft } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCampaignDrafts,
  adCampaigns,
  adChangeRequests,
  adExecutions,
  budgetPeriods,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { decideApproval, gateChange } from './approvals.js';
import {
  getPeriodState,
  openPeriod,
  reserveCampaignCreation,
  reserveChange,
} from './budget-guard.js';
import { executeApprovedChange } from './executor.js';
import { fakeGoogleApi } from './platform/fake-google-api.js';
import { GoogleAdsPlatformClient, GoogleAdsWriteClient } from './platform/google-ads-client.js';
import { reconcileAccount } from './reconcile.js';

/**
 * A Google campaign travels the same road as a Meta one: asked for by a person,
 * judged by the budget guard, approved by a person, and only then executed —
 * by a client bound to the right account, against a freshly reconciled period.
 * The Google API here is scripted; nothing in this file reaches Google.
 */

const NOW = new Date();
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(NOW);
const PERIOD = `${TODAY.slice(0, 7)}-01`;
const CUSTOMER = '4268586278';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const common = () => ({
  name: `Google ${randomBytes(3).toString('hex')}`,
  objective: 'lead',
  idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
  reach: { states: ['SP'], cities: [{ name: 'Curitiba', state: 'PR' }] },
  destinationUrl: 'https://wingscompany.com.br/franquia',
  startDate: TODAY,
  endDate: TODAY,
  dailyBudgetCents: 3000,
  utms: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'x', utm_content: 'lead' },
  startPaused: true,
});

function searchDraft(overrides: Record<string, unknown> = {}): CampaignDraft {
  return campaignDraftSchema.parse({
    ...common(),
    platform: 'google_search',
    search: {
      keywords: ['franquia de alimentação', 'abrir franquia'],
      negativeKeywords: ['grátis'],
      headlines: ['Franquia Wings'],
      descriptions: ['Conheça o modelo de negócio e o suporte da Wings.'],
    },
    ...overrides,
  });
}

function youtubeDraft(): CampaignDraft {
  return campaignDraftSchema.parse({
    ...common(),
    platform: 'youtube',
    youtube: { videoUrl: 'https://youtu.be/dQw4w9WgXcQ', headline: 'Conheça a Wings' },
  });
}

/** A Google account with an open period, reconciled a moment ago. */
async function world(options: { externalId?: string; reconciled?: boolean } = {}) {
  // One Google customer per database row; tests that need the real id say so.
  const externalId = options.externalId ?? String(1_000_000_000 + Math.floor(Math.random() * 8e9));
  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'google', externalId, name: 'Wings Company — Google Ads' })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed');
  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: PERIOD,
    capCents: 150_000,
    usablePercent: 70,
  });
  if (options.reconciled !== false) {
    await db
      .update(budgetPeriods)
      .set({ lastReconciledAt: new Date() })
      .where(eq(budgetPeriods.adAccountId, account.id));
  }
  const api = fakeGoogleApi({ customerId: externalId });
  const client = new GoogleAdsWriteClient(api.reader, { confirmWrites: true });
  return { accountId: account.id, externalId, api, client };
}

async function request(accountId: string, draft: CampaignDraft) {
  const requester = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
  return reserveCampaignCreation(db, { adAccountId: accountId, draft, requestedBy: requester.id });
}

async function requestAndApprove(accountId: string, draft: CampaignDraft) {
  const reserved = await request(accountId, draft);
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
  return reserved.value;
}

describe('asking for a Google campaign', () => {
  it('reserves nothing — it is born paused — and sends nothing to Google', async () => {
    const { accountId, api } = await world();
    const reserved = await request(accountId, searchDraft());

    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.value.exposureDeltaCents).toBe(0);
    expect((await getPeriodState(db, accountId, PERIOD))?.committedCents).toBe(0);
    expect(api.calls).toHaveLength(0);
  });

  it('is refused by the internal ceiling, judged as if the campaign were running', async () => {
    const { accountId } = await world();
    // A one-day campaign, so the single-day check decides: R$ 1.050 usable, and
    // R$ 600/day at Google's 2x is R$ 1.200 for that day.
    const reserved = await request(accountId, searchDraft({ dailyBudgetCents: 60_000 }));

    expect(reserved).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
    expect(
      await db.query.adCampaignDrafts.findMany({
        where: eq(adCampaignDrafts.adAccountId, accountId),
      }),
    ).toHaveLength(0);
  });

  it('is refused by the platform ceiling: the prepaid balance', async () => {
    const { accountId } = await world();
    // R$ 40 left on the prepaid account; one day of R$ 30 at 2x needs R$ 60.
    await db
      .update(budgetPeriods)
      .set({ platformRemainingCents: 4000, platformLimitSource: 'google.account_budget' })
      .where(eq(budgetPeriods.adAccountId, accountId));

    const reserved = await request(accountId, searchDraft());
    expect(reserved).toMatchObject({ ok: false, reason: 'platform_limit_would_be_exceeded' });

    // With the balance topped up, the same request fits.
    await db
      .update(budgetPeriods)
      .set({ platformRemainingCents: 50_000 })
      .where(eq(budgetPeriods.adAccountId, accountId));
    expect((await request(accountId, searchDraft())).ok).toBe(true);
  });

  it('is refused while the kill switch is engaged', async () => {
    const { accountId } = await world();
    await db
      .update(adAccounts)
      .set({ killSwitchEngaged: true, killSwitchReason: 'teste' })
      .where(eq(adAccounts.id, accountId));
    expect(await request(accountId, searchDraft())).toMatchObject({
      ok: false,
      reason: 'kill_switch_engaged',
    });
  });

  it('is refused on an account of another platform', async () => {
    const [meta] = await db
      .insert(adAccounts)
      .values({
        platform: 'meta',
        externalId: `act_${randomBytes(4).toString('hex')}`,
        name: 'Meta',
      })
      .returning({ id: adAccounts.id });
    if (!meta) throw new Error('failed');
    await openPeriod(db, {
      adAccountId: meta.id,
      periodMonth: PERIOD,
      capCents: 400_000,
      usablePercent: 70,
    });

    expect(await request(meta.id, searchDraft())).toMatchObject({
      ok: false,
      reason: 'platform_mismatch',
    });
  });

  it('never accepts a request about a Google campaign that already exists', async () => {
    const { accountId } = await world();
    const [campaign] = await db
      .insert(adCampaigns)
      .values({
        adAccountId: accountId,
        externalId: '111',
        name: 'Search - Wings - Geral',
        status: 'ACTIVE',
        dailyBudgetCents: 3000,
        budgetLevel: 'campaign',
      })
      .returning({ id: adCampaigns.id });
    if (!campaign) throw new Error('failed');

    const reserved = await reserveChange(db, {
      adAccountId: accountId,
      campaignId: campaign.id,
      kind: 'pause_campaign',
    });
    expect(reserved).toMatchObject({ ok: false, reason: 'not_supported_on_platform' });
  });
});

describe('the approval gate', () => {
  it('sends nothing to Google for a request nobody approved', async () => {
    const { accountId, api, client } = await world();
    const reserved = await request(accountId, searchDraft());
    if (!reserved.ok) throw new Error(reserved.message);
    await gateChange(db, { changeRequestId: reserved.value.changeRequestId });

    const result = await executeApprovedChange(db, client, reserved.value.changeRequestId, {
      allowWrites: true,
    });
    expect(result).toMatchObject({ ok: false, outcome: 'refused', reason: 'not_approved' });
    expect(api.calls).toHaveLength(0);
  });

  it('sends nothing with the write switch off, even when approved', async () => {
    const { accountId, api, client } = await world();
    const { changeRequestId } = await requestAndApprove(accountId, searchDraft());

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: false });
    expect(result).toMatchObject({ ok: false, outcome: 'refused', reason: 'writes_disabled' });
    expect(api.calls).toHaveLength(0);
  });
});

describe('executing an approved Google campaign', () => {
  it('creates a paused Search campaign and mirrors it as a google campaign', async () => {
    const { accountId, api, client } = await world();
    const draft = searchDraft();
    const { changeRequestId, draftId } = await requestAndApprove(accountId, draft);

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result).toMatchObject({ ok: true, outcome: 'applied' });
    expect(api.mutateCalls()).toHaveLength(1);

    const mirrored = await db.query.adCampaigns.findMany({
      where: eq(adCampaigns.adAccountId, accountId),
    });
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatchObject({
      name: draft.name,
      status: 'PAUSED',
      dailyBudgetCents: 3000,
    });
    const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, accountId) });
    expect(account?.platform).toBe('google');

    const stored = await db.query.adCampaignDrafts.findFirst({
      where: eq(adCampaignDrafts.id, draftId),
    });
    expect(stored?.campaignId).toBe(mirrored[0]?.id);
    // The keywords stay with the approved draft, for the ad group to come.
    expect((stored?.payload as CampaignDraft).search?.keywords).toEqual([
      'franquia de alimentação',
      'abrir franquia',
    ]);

    const [execution] = await db
      .select()
      .from(adExecutions)
      .where(eq(adExecutions.changeRequestId, changeRequestId));
    expect(execution?.platformResponse).toMatchObject({
      status: 'applied',
      channel: 'SEARCH',
      locations: [{ asked: 'SP' }, { asked: 'Curitiba/PR' }],
    });

    // A second click never creates a twin.
    const again = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(again).toMatchObject({ ok: false, reason: 'already_executed' });
    expect(api.mutateCalls()).toHaveLength(1);
  });

  it('creates a paused Demand Gen campaign for YouTube, keeping the video in the draft', async () => {
    const { accountId, api, client } = await world();
    const { changeRequestId, draftId } = await requestAndApprove(accountId, youtubeDraft());

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result).toMatchObject({ ok: true, outcome: 'applied' });

    const operations = api.mutateCalls()[0]?.body.mutateOperations as Record<
      string,
      { create: Record<string, unknown> }
    >[];
    expect(operations).toHaveLength(2);
    expect(operations[1]?.campaignOperation?.create).toMatchObject({
      advertisingChannelType: 'DEMAND_GEN',
      status: 'PAUSED',
    });
    const stored = await db.query.adCampaignDrafts.findFirst({
      where: eq(adCampaignDrafts.id, draftId),
    });
    expect((stored?.payload as CampaignDraft).youtube?.videoUrl).toBe(
      'https://youtu.be/dQw4w9WgXcQ',
    );
  });

  it('refuses a client bound to another Google customer', async () => {
    const { accountId } = await world();
    const { changeRequestId } = await requestAndApprove(accountId, searchDraft());

    const other = fakeGoogleApi({ customerId: '1112223334' });
    const wrongClient = new GoogleAdsWriteClient(other.reader, { confirmWrites: true });
    const result = await executeApprovedChange(db, wrongClient, changeRequestId, {
      allowWrites: true,
    });

    expect(result).toMatchObject({ ok: false, outcome: 'refused', reason: 'wrong_account' });
    expect(other.calls).toHaveLength(0);
  });

  it('refuses an account that was never reconciled, then accepts after a reconciliation', async () => {
    const { accountId, api, client } = await world({ reconciled: false });
    const { changeRequestId } = await requestAndApprove(accountId, searchDraft());

    const stale = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(stale).toMatchObject({ ok: false, outcome: 'refused', reason: 'reconciliation_stale' });
    expect(api.mutateCalls()).toHaveLength(0);

    // Reconciling a Google account is a real thing now: a reader is enough.
    await reconcileAccount(db, new GoogleAdsPlatformClient(api.reader), accountId);
    const fresh = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(fresh).toMatchObject({ ok: true, outcome: 'applied' });
  });

  it('refuses when a campaign of that name already exists in Google', async () => {
    const { accountId, api, client } = await world();
    const draft = searchDraft();
    const { changeRequestId } = await requestAndApprove(accountId, draft);
    api.campaigns.push({ id: '777', name: draft.name, status: 'PAUSED', amountMicros: '1000000' });

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result).toMatchObject({ ok: false, reason: 'platform_drift' });
    expect(api.mutateCalls()).toHaveLength(0);
  });

  it('gives the reservation back when Google says no', async () => {
    const { accountId, api, client } = await world();
    const { changeRequestId } = await requestAndApprove(accountId, searchDraft());
    api.state.mutate = 'reject';

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result).toMatchObject({
      ok: false,
      outcome: 'rejected',
      code: 'MONEY_AMOUNT_TOO_SMALL',
    });
    expect(
      await db.query.adCampaigns.findMany({ where: eq(adCampaigns.adAccountId, accountId) }),
    ).toHaveLength(0);
  });

  it('freezes the account when Google does not say what happened', async () => {
    const { accountId, api, client } = await world();
    const { changeRequestId } = await requestAndApprove(accountId, searchDraft());
    api.state.mutate = 'server_error';

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: true });
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' });

    const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, accountId) });
    expect(account?.killSwitchEngaged).toBe(true);
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeRequestId),
    });
    expect(change?.status).toBe('unknown');
  });
});

/**
 * Google makes two promises: up to 2x the budget on ONE day, and no more than
 * the budget itself over the period (30.4 x daily in a month). The month is
 * sized by the second; the first only decides a run of a single day. Dates are
 * fixed here so the number of days left never depends on when the suite runs.
 */
describe('Google exposure: 1.0x over the period, 2.0x for a single day', () => {
  const MARCH = '2026-03-01';
  // 12 March, midday in São Paulo: 20 days left in the month, counting today.
  const MID_MONTH = new Date('2026-03-12T15:00:00Z');
  const LAST_DAY = new Date('2026-03-31T15:00:00Z');

  async function marchWorld() {
    const externalId = String(1_000_000_000 + Math.floor(Math.random() * 8e9));
    const [account] = await db
      .insert(adAccounts)
      .values({ platform: 'google', externalId, name: 'Wings Company — Google Ads' })
      .returning({ id: adAccounts.id });
    if (!account) throw new Error('failed');
    // R$ 1.500 cap, R$ 1.050 usable — the production figures.
    await openPeriod(db, {
      adAccountId: account.id,
      periodMonth: MARCH,
      capCents: 150_000,
      usablePercent: 70,
    });
    return { accountId: account.id, externalId };
  }

  async function requestAt(accountId: string, draft: CampaignDraft, now: Date) {
    const requester = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
    return reserveCampaignCreation(db, {
      adAccountId: accountId,
      draft,
      requestedBy: requester.id,
      now,
    });
  }

  it('judges a new request at budget x days x 1.0', async () => {
    const { accountId } = await marchWorld();
    // R$ 50 x 20 days = R$ 1.000, inside R$ 1.050. At 2x it would be R$ 2.000.
    const fits = await requestAt(
      accountId,
      searchDraft({ startDate: '2026-03-12', endDate: '2026-03-31', dailyBudgetCents: 5000 }),
      MID_MONTH,
    );
    expect(fits.ok).toBe(true);

    // R$ 55 x 20 days = R$ 1.100: over the usable slice even at 1.0.
    const tooMuch = await requestAt(
      accountId,
      searchDraft({ startDate: '2026-03-12', endDate: '2026-03-31', dailyBudgetCents: 5500 }),
      MID_MONTH,
    );
    expect(tooMuch).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
  });

  it('holds the prepaid balance to the same 1.0', async () => {
    const { accountId } = await marchWorld();
    await db
      .update(budgetPeriods)
      .set({ platformRemainingCents: 46_988, platformLimitSource: 'google.account_budget' })
      .where(eq(budgetPeriods.adAccountId, accountId));
    const week = { startDate: '2026-03-12', endDate: '2026-03-18' };

    // R$ 60 x 7 days = R$ 420 fits R$ 469,88; at 2x (R$ 840) it would not.
    expect(
      (await requestAt(accountId, searchDraft({ ...week, dailyBudgetCents: 6000 }), MID_MONTH)).ok,
    ).toBe(true);
    // R$ 70 x 7 days = R$ 490 does not.
    expect(
      await requestAt(accountId, searchDraft({ ...week, dailyBudgetCents: 7000 }), MID_MONTH),
    ).toMatchObject({ ok: false, reason: 'platform_limit_would_be_exceeded' });
  });

  it('keeps 2.0x when a single day of the campaign falls in the month', async () => {
    const { accountId } = await marchWorld();
    const intoApril = { startDate: '2026-03-31', endDate: '2026-04-05' };

    // One day left: R$ 550 can become R$ 1.100 today, over R$ 1.050 usable.
    expect(
      await requestAt(accountId, searchDraft({ ...intoApril, dailyBudgetCents: 55_000 }), LAST_DAY),
    ).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
    // R$ 500 can become R$ 1.000, which fits.
    expect(
      (
        await requestAt(
          accountId,
          searchDraft({ ...intoApril, dailyBudgetCents: 50_000 }),
          LAST_DAY,
        )
      ).ok,
    ).toBe(true);
  });

  it('never lets two days cost less than one worst day', async () => {
    const { accountId } = await marchWorld();
    // Two days at 1.0 and one day at 2.0 are the same R$ 1.100: still refused.
    expect(
      await requestAt(
        accountId,
        searchDraft({ startDate: '2026-03-30', endDate: '2026-03-31', dailyBudgetCents: 55_000 }),
        new Date('2026-03-30T15:00:00Z'),
      ),
    ).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
  });

  it('reconciles committed at budget x days left x 1.0, without freezing', async () => {
    const { accountId, externalId } = await marchWorld();
    const api = fakeGoogleApi({
      customerId: externalId,
      campaigns: [
        { id: '111', name: 'Search - Geral', status: 'ENABLED', amountMicros: '50000000' },
      ],
    });

    const result = await reconcileAccount(
      db,
      new GoogleAdsPlatformClient(api.reader),
      accountId,
      MID_MONTH,
    );

    // R$ 50 x 20 days = R$ 1.000. The old 2x read R$ 2.000 here, clipped it to
    // the usable slice and froze an account that was inside its plan.
    expect((await getPeriodState(db, accountId, MARCH))?.committedCents).toBe(100_000);
    expect(result.outOfBandChangeDetected).toBe(false);
    expect(result.killSwitchEngaged).toBe(false);
  });
});

describe('reconciling a Google account', () => {
  it('counts an active campaign at 1x over the period and does not freeze over a low prepaid balance', async () => {
    const { accountId, externalId } = await world({ externalId: CUSTOMER, reconciled: false });
    const api = fakeGoogleApi({
      customerId: externalId,
      campaigns: [
        { id: '111', name: 'Search - Wings - Geral', status: 'ENABLED', amountMicros: '10000000' },
        { id: '222', name: 'SEARCH | Geral', status: 'PAUSED', amountMicros: '50000000' },
      ],
      // R$ 5 left: far below the month's exposure, which is normal when prepaid.
      accountBudget: { limitMicros: '1000000000', servedMicros: '995000000' },
    });

    const result = await reconcileAccount(db, new GoogleAdsPlatformClient(api.reader), accountId);

    expect(result.campaignsSynced).toBe(2);
    expect(result.killSwitchEngaged).toBe(false);
    const period = await getPeriodState(db, accountId, PERIOD);
    expect(period?.platformRemainingCents).toBe(500);
    expect(period?.platformLimitSource).toBe('google.account_budget');
    // R$ 10/day for the days left in the month, at Google's PERIOD factor of
    // 1.0 — the 2x is a one-day promise and never sizes the month.
    const daysLeft =
      new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)), 0)).getUTCDate() -
      Number(TODAY.slice(8, 10)) +
      1;
    expect(period?.committedCents).toBe(1000 * daysLeft);
  });

  it('still freezes when budgets in Google exceed the internal plan', async () => {
    const { accountId, externalId } = await world({ reconciled: false });
    const api = fakeGoogleApi({
      customerId: externalId,
      campaigns: [{ id: '1', name: 'Cara', status: 'ENABLED', amountMicros: '900000000' }],
    });
    const result = await reconcileAccount(db, new GoogleAdsPlatformClient(api.reader), accountId);
    expect(result.killSwitchEngaged).toBe(true);
  });
});
