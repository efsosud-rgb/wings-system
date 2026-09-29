import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAdsRequestSchema, type AddAdsRequest } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAds,
  adCampaigns,
  adChangeRequests,
  adSets,
  adVideoUploads,
  budgetPeriods,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { stepsOfExecution } from './ad-tree.js';
import { decideApproval, gateChange } from './approvals.js';
import { openPeriod, reserveAddAds } from './budget-guard.js';
import { companionsOf, executeApprovedChange } from './executor.js';
import { fakeMetaApi, type FakeMetaApiOptions } from './platform/fake-meta-api.js';
import { MetaWriteClient } from './platform/meta-write-client.js';

/**
 * New ads in a campaign that runs (`add_ads`): asked for by a person,
 * approved by a person, executed by a click. Each ad is validated first, born
 * paused, in the ad set the campaign already has, with utm_content resuming
 * after the ads already there. Nothing about the campaign or its ad set moves.
 */

const NOW = new Date();
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(NOW);
const PERIOD = `${TODAY.slice(0, 7)}-01`;

let harness: TestDatabase;
let db: Database;
let videoDir: string;
let videoIds: string[];

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  videoDir = await mkdtemp(join(tmpdir(), 'wings-add-ads-'));
  videoIds = [];
  for (const seed of ['a', 'b', 'c']) {
    await writeFile(join(videoDir, `${seed}.mp4`), Buffer.alloc(1_000, seed.charCodeAt(0)));
    const [row] = await db
      .insert(adVideoUploads)
      .values({ mimeType: 'video/mp4', byteSize: 1_000, sha256: seed.repeat(64), storageKey: `${seed}.mp4` })
      .returning({ id: adVideoUploads.id });
    videoIds.push(row!.id);
  }
}, 60_000);

afterAll(async () => {
  await harness?.drop();
  await rm(videoDir, { recursive: true, force: true });
});

const CAMPAIGN = '120252260012720076';
const AD_SET = '120252260021860076';

async function world(options: FakeMetaApiOptions = {}) {
  const accountId = `act_${Math.floor(1e9 + Math.random() * 9e9)}`;
  const api = fakeMetaApi({
    existingAdSets: [{ id: AD_SET, campaign_id: CAMPAIGN, name: '28Set — conjunto', status: 'ACTIVE' }],
    ...options,
    accountId,
  });
  const client = new MetaWriteClient({
    accessToken: 'token',
    adAccountId: accountId,
    confirmWrites: true,
    fetchImpl: api.impl,
    videoPollIntervalMs: 1,
    videoProcessingTimeoutMs: 200,
  });
  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId: accountId, name: 'Fly High' })
    .returning({ id: adAccounts.id });
  await openPeriod(db, { adAccountId: account!.id, periodMonth: PERIOD, capCents: 250_000, usablePercent: 70 });
  await db.update(budgetPeriods).set({ lastReconciledAt: new Date() }).where(eq(budgetPeriods.adAccountId, account!.id));
  const [campaign] = await db
    .insert(adCampaigns)
    .values({ adAccountId: account!.id, externalId: CAMPAIGN, name: 'META | 28Set', status: 'ACTIVE', dailyBudgetCents: 12_000 })
    .returning({ id: adCampaigns.id });
  const [adSet] = await db
    .insert(adSets)
    .values({ campaignId: campaign!.id, externalId: AD_SET, name: '28Set — conjunto', status: 'ACTIVE' })
    .returning({ id: adSets.id });
  // The two ads the ad set already has: the new ones continue from video-3.
  for (const n of [1, 2]) {
    await db.insert(adAds).values({
      adAccountId: account!.id,
      adSetId: adSet!.id,
      campaignId: campaign!.id,
      externalId: `ad-${n}-${accountId}`,
      name: `v${n}`,
      status: 'ACTIVE',
    });
  }
  return { accountDbId: account!.id, campaignDbId: campaign!.id, api, client };
}

const requestOf = (count: number): AddAdsRequest =>
  addAdsRequestSchema.parse({
    campaignExternalId: CAMPAIGN,
    identity: { pageId: '104567890123456', instagramActorId: '17841400000000000' },
    destinationUrl: 'https://wingscompany.com.br/contato/',
    utms: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'formatacao_28set', utm_content: '' },
    variations: videoIds.slice(0, count).map((videoId, index) => ({
      creativeType: 'video',
      videoId,
      headline: `Sua marca pronta para franquear ${index + 1}`,
      primaryText: 'Para negócios que já vendem e querem estruturar para franquear.',
      callToAction: 'SIGN_UP',
    })),
  });

async function askAndApprove(accountDbId: string, request: AddAdsRequest) {
  const requester = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
  const reserved = await reserveAddAds(db, { adAccountId: accountDbId, request, requestedBy: requester.id });
  if (!reserved.ok) throw new Error(reserved.message);
  const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId });
  if (!gate.approvalId) throw new Error('an add_ads request always needs a person');
  const admin = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
  const decision = await decideApproval(db, { approvalId: gate.approvalId, approverEmployeeId: admin.id, decision: 'approved' });
  if (!decision.ok) throw new Error(decision.message);
  return reserved.value;
}

const run = (client: MetaWriteClient, id: string) =>
  executeApprovedChange(db, client, id, { allowWrites: true, videoDir });

describe('asking for new ads', () => {
  it('needs a person to approve, reserves no money and numbers the new ads after the existing ones', async () => {
    const { accountDbId, api, client } = await world();
    const requester = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
    const reserved = await reserveAddAds(db, { adAccountId: accountDbId, request: requestOf(3), requestedBy: requester.id });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.value.payload).toMatchObject({ adSetExternalId: AD_SET, firstPosition: 3, campaignName: 'META | 28Set' });
    const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId });
    expect(gate.status).toBe('pending_approval');
    const row = await db.query.adChangeRequests.findFirst({ where: eq(adChangeRequests.id, reserved.value.changeRequestId) });
    expect(row).toMatchObject({ kind: 'add_ads', exposureDeltaCents: 0 });
    // Unapproved: nothing goes out.
    expect(await run(client, reserved.value.changeRequestId)).toMatchObject({ outcome: 'refused', reason: 'not_approved' });
    expect(api.writes()).toHaveLength(0);
  });

  it('refuses a campaign the system does not know', async () => {
    const { accountDbId } = await world();
    const result = await reserveAddAds(db, { adAccountId: accountDbId, request: { ...requestOf(1), campaignExternalId: '99999999' } });
    expect(result).toMatchObject({ ok: false, reason: 'campaign_not_found' });
  });
});

describe('executing it', () => {
  it('uploads the videos, validates and creates one paused ad each in the existing ad set, with video-3, video-4, video-5', async () => {
    const { accountDbId, campaignDbId, api, client } = await world();
    const { changeRequestId } = await askAndApprove(accountDbId, requestOf(3));

    const result = await run(client, changeRequestId);
    expect(result).toMatchObject({ ok: true, outcome: 'applied' });

    const edges = api.writes().map((call) => call.path.split('/')[1]);
    // No campaign and no ad set is written: only media, then validate + creative + ad per creative.
    expect(edges).not.toContain('campaigns');
    expect(edges).not.toContain('adsets');
    expect(edges.filter((edge) => edge === 'adcreatives')).toHaveLength(3);
    for (const call of api.writes('ads')) {
      expect(call.fields.adset_id).toBe(AD_SET);
      if (!call.fields.execution_options) expect(call.fields.status).toBe('PAUSED');
    }
    const links = api
      .writes('adcreatives')
      .map((call) => JSON.parse(call.fields.object_story_spec ?? '{}').video_data.call_to_action.value.link as string);
    expect(links.map((link) => new URL(link).searchParams.get('utm_content'))).toEqual(['video-3', 'video-4', 'video-5']);

    // A resume would switch these on too: they are this system's.
    const companions = await companionsOf(db, campaignDbId);
    expect(companions.adIds).toHaveLength(3);

    const change = await db.query.adChangeRequests.findFirst({ where: eq(adChangeRequests.id, changeRequestId) });
    expect(change?.status).toBe('executed');
    expect(await run(client, changeRequestId)).toMatchObject({ outcome: 'refused', reason: 'already_executed' });
  });

  it('refuses when the ad set no longer belongs to the campaign on Meta, sending nothing', async () => {
    const { accountDbId, api, client } = await world({
      existingAdSets: [{ id: AD_SET, campaign_id: '111111111', name: 'outra', status: 'ACTIVE' }],
    });
    const { changeRequestId } = await askAndApprove(accountDbId, requestOf(1));
    expect(await run(client, changeRequestId)).toMatchObject({ outcome: 'refused', reason: 'platform_drift' });
    expect(api.writes()).toHaveLength(0);
  });

  it('refuses a payload edited after the approval', async () => {
    const { accountDbId, api, client } = await world();
    const { changeRequestId, payload } = await askAndApprove(accountDbId, requestOf(1));
    await db
      .update(adChangeRequests)
      .set({ payload: { ...payload, destinationUrl: 'https://outro.com.br/' } })
      .where(eq(adChangeRequests.id, changeRequestId));
    expect(await run(client, changeRequestId)).toMatchObject({ outcome: 'refused', reason: 'payload_changed' });
    expect(api.writes()).toHaveLength(0);
  });

  it('stops at the first refused ad, records what exists and freezes the account', async () => {
    const { accountDbId, client } = await world({ failOn: { edge: 'adcreatives', mode: 'reject' } });
    const { changeRequestId } = await askAndApprove(accountDbId, requestOf(2));
    const result = await run(client, changeRequestId);
    // Both videos were uploaded before the first creative failed: something exists.
    expect(result).toMatchObject({ outcome: 'unknown' });
    const steps = await stepsOfExecution(db, (result as { executionId: string }).executionId);
    expect(steps.map((step) => `${step.kind}:${step.status}`)).toEqual([
      'video:created',
      'video:created',
      'creative:failed',
    ]);
    const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, accountDbId) });
    expect(account?.killSwitchEngaged).toBe(true);
  });
});
