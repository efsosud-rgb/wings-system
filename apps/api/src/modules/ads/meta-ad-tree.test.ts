import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campaignDraftSchema, META_URL_TAGS, type CampaignDraft } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adCampaigns,
  adChangeRequests,
  adCreativeUploads,
  adExecutions,
  adVideoUploads,
  budgetPeriods,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { stepsOfExecution } from './ad-tree.js';
import { decideApproval, gateChange } from './approvals.js';
import { openPeriod, reserveCampaignCreation, reserveChange } from './budget-guard.js';
import { executeApprovedChange } from './executor.js';
import { fakeMetaApi, type FakeMetaApiOptions } from './platform/fake-meta-api.js';
import { MetaReadOnlyClient } from './platform/meta-client.js';
import { MetaWriteClient } from './platform/meta-write-client.js';

/**
 * A Meta campaign with everything under it — media, one ad set, one ad per
 * variation — against a scripted Graph API. Asked for by a person, approved by
 * a person, executed by a click; born paused from top to bottom; and when a
 * write fails in the middle, what exists is on record and nothing is retried.
 */

const NOW = new Date();
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(NOW);
const PERIOD = `${TODAY.slice(0, 7)}-01`;
const PIXEL = '1116678872845520';

let harness: TestDatabase;
let db: Database;
let videoDir: string;
let imageIds: [string, string];
let videoId: string;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  videoDir = await mkdtemp(join(tmpdir(), 'wings-videos-'));

  const images = await db
    .insert(adCreativeUploads)
    .values(
      ['a', 'b'].map((seed) => ({
        mimeType: 'image/png',
        width: 1080,
        height: 1080,
        byteSize: 8,
        sha256: seed.repeat(64),
        data: Buffer.from(`png-${seed}`),
      })),
    )
    .returning({ id: adCreativeUploads.id });
  imageIds = [images[0]?.id as string, images[1]?.id as string];

  await writeFile(join(videoDir, 'video.mp4'), Buffer.alloc(1_500, 3));
  const [video] = await db
    .insert(adVideoUploads)
    .values({
      mimeType: 'video/mp4',
      byteSize: 1_500,
      sha256: 'c'.repeat(64),
      storageKey: 'video.mp4',
    })
    .returning({ id: adVideoUploads.id });
  videoId = video?.id as string;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
  await rm(videoDir, { recursive: true, force: true });
});

const imageVariation = (creativeId: string, headline: string) => ({
  creativeId,
  headline,
  primaryText: 'Fale com a gente.',
  callToAction: 'LEARN_MORE',
});

function draftOf(overrides: Record<string, unknown> = {}): CampaignDraft {
  return campaignDraftSchema.parse({
    platform: 'meta',
    name: `Árvore ${randomBytes(3).toString('hex')}`,
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP'], cities: [{ name: 'Curitiba', state: 'PR' }] },
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    variations: [
      imageVariation(imageIds[0], 'Leve a Wings'),
      imageVariation(imageIds[1], 'Seja franqueado'),
    ],
    ageMin: 25,
    ageMax: 65,
    placements: { mode: 'automatic' },
    identity: { pageId: '104567890123456', instagramActorId: '17841400000000000' },
    startDate: TODAY,
    endDate: TODAY,
    dailyBudgetCents: 600,
    utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'x', utm_content: 'lead' },
    startPaused: true,
    ...overrides,
  });
}

async function world(options: FakeMetaApiOptions = {}) {
  const accountId = `act_${Math.floor(1e9 + Math.random() * 9e9)}`;
  const api = fakeMetaApi({ ...options, accountId });
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
  if (!account) throw new Error('failed');
  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: PERIOD,
    capCents: 250_000,
    usablePercent: 70,
  });
  await db
    .update(budgetPeriods)
    .set({ lastReconciledAt: new Date() })
    .where(eq(budgetPeriods.adAccountId, account.id));
  return { accountDbId: account.id, api, client };
}

async function request(accountDbId: string, draft: CampaignDraft) {
  const requester = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
  const reserved = await reserveCampaignCreation(db, {
    adAccountId: accountDbId,
    draft,
    requestedBy: requester.id,
  });
  if (!reserved.ok) throw new Error(reserved.message);
  const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId });
  if (!gate.approvalId) throw new Error('expected an approval');
  return { ...reserved.value, approvalId: gate.approvalId };
}

async function requestAndApprove(accountDbId: string, draft: CampaignDraft) {
  const asked = await request(accountDbId, draft);
  const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
  const decision = await decideApproval(db, {
    approvalId: asked.approvalId,
    approverEmployeeId: admin.id,
    decision: 'approved',
  });
  if (!decision.ok) throw new Error(decision.message);
  return asked;
}

const run = (client: MetaWriteClient, changeRequestId: string) =>
  executeApprovedChange(db, client, changeRequestId, {
    allowWrites: true,
    metaPixelId: PIXEL,
    videoDir,
  });

const executionIdOf = (result: Awaited<ReturnType<typeof run>>) =>
  'executionId' in result ? result.executionId : '';

describe('the approval gate', () => {
  it('sends nothing to Meta for a request nobody approved', async () => {
    const { accountDbId, api, client } = await world();
    const { changeRequestId } = await request(accountDbId, draftOf());

    expect(await run(client, changeRequestId)).toMatchObject({
      outcome: 'refused',
      reason: 'not_approved',
    });
    expect(api.calls).toHaveLength(0);
  });

  it('sends nothing with the write switch off, even when approved', async () => {
    const { accountDbId, api, client } = await world();
    const { changeRequestId } = await requestAndApprove(accountDbId, draftOf());

    const result = await executeApprovedChange(db, client, changeRequestId, { allowWrites: false });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'writes_disabled' });
    expect(api.writes()).toHaveLength(0);
  });

  it('refuses a client that can only read, before anything is sent', async () => {
    const { accountDbId, api } = await world();
    const { changeRequestId } = await requestAndApprove(accountDbId, draftOf());
    const reader = new MetaReadOnlyClient({
      accessToken: 'token',
      adAccountId: api.accountId,
      fetchImpl: api.impl,
    });

    const result = await executeApprovedChange(db, reader, changeRequestId, { allowWrites: true });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'writes_disabled' });
    expect(api.writes()).toHaveLength(0);
  });
});

describe('image ads, automatic placements', () => {
  it('writes campaign, media, ad set, then a creative and an ad per variation — all paused', async () => {
    const { accountDbId, api, client } = await world();
    const draft = draftOf();
    const { changeRequestId } = await requestAndApprove(accountDbId, draft);

    const result = await run(client, changeRequestId);
    expect(result).toMatchObject({ ok: true, outcome: 'applied' });

    // Before each creative, Meta validates the ad with the creative inline and
    // creates nothing; then the creative and the ad are written.
    expect(api.writes().map((call) => call.path.split('/')[1])).toEqual([
      'campaigns',
      'adimages',
      'adimages',
      'adsets',
      'ads',
      'adcreatives',
      'ads',
      'ads',
      'adcreatives',
      'ads',
    ]);
    const validations = api.writes('ads').filter((call) => call.fields.execution_options);
    expect(validations).toHaveLength(2);
    expect(validations[0]?.fields.execution_options).toBe('["validate_only"]');
    expect(JSON.parse(validations[0]?.fields.creative ?? '{}')).toHaveProperty(
      'object_story_spec.page_id',
    );
    for (const edge of ['campaigns', 'adsets', 'ads'] as const) {
      for (const call of api.writes(edge)) expect(call.fields.status).toBe('PAUSED');
    }

    const adSet = api.writes('adsets')[0]?.fields ?? {};
    expect(adSet.campaign_id).toBe(api.state.campaigns[0]?.id);
    expect(JSON.parse(adSet.promoted_object ?? '{}')).toEqual({
      pixel_id: PIXEL,
      custom_event_type: 'LEAD',
    });
    const targeting = JSON.parse(adSet.targeting ?? '{}');
    expect(targeting.geo_locations).toMatchObject({
      regions: [{ key: '460' }],
      cities: [{ key: '268478' }],
    });
    expect(targeting).toMatchObject({ age_min: 25, age_max: 65, locales: [31] });
    expect(targeting).not.toHaveProperty('publisher_platforms');

    // The link carries no UTM; the standard url_tags do, on every ad.
    const creatives = api.writes('adcreatives');
    const links = creatives.map(
      (call) => JSON.parse(call.fields.object_story_spec ?? '{}').link_data.link as string,
    );
    expect(links.every((link) => !link.includes('utm_'))).toBe(true);
    expect(creatives.map((call) => call.fields.url_tags)).toEqual([META_URL_TAGS, META_URL_TAGS]);

    const steps = await stepsOfExecution(db, executionIdOf(result));
    expect(steps.map((step) => [step.seq, step.kind, step.status])).toEqual([
      [1, 'campaign', 'created'],
      [2, 'image', 'created'],
      [3, 'image', 'created'],
      [4, 'ad_set', 'created'],
      [5, 'creative', 'created'],
      [6, 'ad', 'created'],
      [7, 'creative', 'created'],
      [8, 'ad', 'created'],
    ]);
    expect(steps.every((step) => step.externalId)).toBe(true);

    // A second click creates nothing.
    expect(await run(client, changeRequestId)).toMatchObject({ reason: 'already_executed' });
    expect(api.writes('campaigns')).toHaveLength(1);
  });

  it('uploads an image once however many ads use it', async () => {
    const { accountDbId, api, client } = await world();
    const draft = draftOf({
      variations: [imageVariation(imageIds[0], 'Um'), imageVariation(imageIds[0], 'Dois')],
    });
    const { changeRequestId } = await requestAndApprove(accountDbId, draft);

    await run(client, changeRequestId);
    expect(api.writes('adimages')).toHaveLength(1);
    expect(api.writes('ads').filter((call) => !call.fields.execution_options)).toHaveLength(2);
  });

  it('a creative Meta would refuse: validate_only says so, nothing more is created, the error is kept whole', async () => {
    const { accountDbId, api, client } = await world({ failOn: { edge: 'ads', mode: 'reject' } });
    const { changeRequestId } = await requestAndApprove(accountDbId, draftOf());

    const result = await run(client, changeRequestId);
    expect(result).toMatchObject({ ok: false, outcome: 'unknown' });
    // The validation went out; no creative and no real ad did.
    expect(api.writes('adcreatives')).toHaveLength(0);
    expect(api.writes('ads')).toHaveLength(1);
    expect(api.writes('ads')[0]?.fields.execution_options).toBe('["validate_only"]');

    const steps = await stepsOfExecution(db, executionIdOf(result));
    expect(steps.map((step) => [step.kind, step.status])).toEqual([
      ['campaign', 'created'],
      ['image', 'created'],
      ['image', 'created'],
      ['ad_set', 'created'],
      ['creative', 'failed'],
    ]);
    // Everything Meta said, not just "100: Invalid parameter".
    expect(steps.at(-1)?.message).toBe(
      '100: validate_only: Invalid parameter on ads [subcode 1815857]',
    );
  });
});

describe('manual placements, traffic objective', () => {
  it('names the chosen placements and optimises for landing-page views', async () => {
    const { accountDbId, api, client } = await world();
    const draft = draftOf({
      objective: 'traffic',
      placements: { mode: 'manual', facebook: ['feed'], instagram: ['stories', 'reels'] },
    });
    const { changeRequestId } = await requestAndApprove(accountDbId, draft);

    expect(await run(client, changeRequestId)).toMatchObject({ outcome: 'applied' });
    const adSet = api.writes('adsets')[0]?.fields ?? {};
    expect(adSet.optimization_goal).toBe('LANDING_PAGE_VIEWS');
    expect(adSet).not.toHaveProperty('promoted_object');
    expect(JSON.parse(adSet.targeting ?? '{}')).toMatchObject({
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['feed'],
      instagram_positions: ['story', 'reels'],
    });
  });
});

describe('video and carousel', () => {
  it('uploads the video, waits for it, and builds a video ad and a mixed carousel', async () => {
    const { accountDbId, api, client } = await world({ videoStatuses: ['processing', 'ready'] });
    const card = (extra: Record<string, unknown>) => ({
      headline: 'Cartão',
      description: 'Suporte completo.',
      link: 'https://wingscompany.com.br/franquia',
      ...extra,
    });
    const draft = draftOf({
      variations: [
        {
          creativeType: 'video',
          videoId,
          headline: 'Veja a Wings',
          primaryText: 'Um minuto sobre o modelo.',
          callToAction: 'LEARN_MORE',
        },
        {
          creativeType: 'carousel',
          cards: [card({ creativeId: imageIds[0] }), card({ mediaType: 'video', videoId })],
          headline: 'Conheça a Wings',
          primaryText: 'Deslize para ver.',
          callToAction: 'CONTACT_US',
        },
      ],
    });
    const { changeRequestId } = await requestAndApprove(accountDbId, draft);

    const result = await run(client, changeRequestId);
    expect(result).toMatchObject({ outcome: 'applied' });

    // One image, one video (used twice) and the video's still as an ad image.
    expect(api.writes('adimages')).toHaveLength(2);
    expect(api.writes('adimages')[1]?.fields.name).toMatch(/-capa\.jpg$/);
    expect(
      api.writes('advideos').filter((call) => call.fields.upload_phase === 'start'),
    ).toHaveLength(1);

    const [videoStory, carouselStory] = api
      .writes('adcreatives')
      .map((call) => JSON.parse(call.fields.object_story_spec ?? '{}'));
    // The still went up as an ad image: the creative carries its hash, never the CDN address.
    expect(videoStory.video_data).toMatchObject({ title: 'Veja a Wings' });
    expect(videoStory.video_data.image_hash).toMatch(/^hash-/);
    expect(videoStory.video_data).not.toHaveProperty('image_url');
    expect(videoStory.video_data.video_id).toMatch(/^\d+$/);
    expect(carouselStory.link_data.child_attachments).toHaveLength(2);
    expect(carouselStory.link_data.child_attachments[0]).toHaveProperty('image_hash');
    expect(carouselStory.link_data.child_attachments[1]).toMatchObject({
      video_id: videoStory.video_data.video_id,
      image_hash: videoStory.video_data.image_hash,
    });
    expect(carouselStory.link_data.call_to_action.type).toBe('CONTACT_US');

    const kinds = (await stepsOfExecution(db, executionIdOf(result))).map((step) => step.kind);
    expect(kinds).toEqual([
      'campaign',
      'image',
      'video',
      'ad_set',
      'creative',
      'ad',
      'creative',
      'ad',
    ]);
  });
});

describe('what is checked by reading, before the first write', () => {
  it('a city Meta cannot place: refused, nothing sent', async () => {
    const { accountDbId, api, client } = await world();
    const draft = draftOf({ reach: { states: [], cities: [{ name: 'Atlântida', state: 'SP' }] } });
    const { changeRequestId } = await requestAndApprove(accountDbId, draft);

    expect(await run(client, changeRequestId)).toMatchObject({
      outcome: 'refused',
      reason: 'targeting_unresolved',
    });
    expect(api.writes()).toHaveLength(0);
    // Still approved: fix the place with a new request, or try again if Meta was wrong.
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeRequestId),
    });
    expect(change?.status).toBe('approved');
  });

  it('a video that is not on the volume: refused, nothing sent', async () => {
    const { accountDbId, api, client } = await world();
    const draft = draftOf({
      variations: [
        imageVariation(imageIds[0], 'Um'),
        {
          creativeType: 'video',
          videoId,
          headline: 'V',
          primaryText: 'Texto.',
          callToAction: 'LEARN_MORE',
        },
      ],
    });
    const { changeRequestId } = await requestAndApprove(accountDbId, draft);

    const result = await executeApprovedChange(db, client, changeRequestId, {
      allowWrites: true,
      metaPixelId: PIXEL,
      videoDir: join(videoDir, 'somewhere-else'),
    });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'media_missing' });
    expect(api.writes()).toHaveLength(0);
  });
});

describe('a video already in the account', () => {
  it('is used again by a later request on the same account, never uploaded twice', async () => {
    const { accountDbId, api, client } = await world();
    const videoDraft = (name: string) =>
      draftOf({
        name,
        variations: [
          {
            creativeType: 'video',
            videoId,
            headline: 'Veja a Wings',
            primaryText: 'Fale com a gente.',
            callToAction: 'CONTACT_US',
          },
          imageVariation(imageIds[0], 'Dois'),
        ],
      });

    const first = await requestAndApprove(
      accountDbId,
      videoDraft(`Vídeo A ${randomBytes(2).toString('hex')}`),
    );
    const firstResult = await run(client, first.changeRequestId);
    expect(firstResult).toMatchObject({ outcome: 'applied' });
    const uploadsAfterFirst = api
      .writes('advideos')
      .filter((call) => call.fields.upload_phase === 'start').length;
    expect(uploadsAfterFirst).toBe(1);

    const second = await requestAndApprove(
      accountDbId,
      videoDraft(`Vídeo B ${randomBytes(2).toString('hex')}`),
    );
    const result = await run(client, second.changeRequestId);
    expect(result).toMatchObject({ outcome: 'applied' });
    // No new upload: the earlier Meta video was found by the local id kept on its step.
    expect(
      api.writes('advideos').filter((call) => call.fields.upload_phase === 'start'),
    ).toHaveLength(uploadsAfterFirst);

    const steps = await stepsOfExecution(db, executionIdOf(result));
    const video = steps.find((step) => step.kind === 'video');
    expect(video?.label).toMatch(/reaproveitado/);
    expect(video?.message).toBe(`video:${videoId}`);
    const firstSteps = await stepsOfExecution(db, executionIdOf(firstResult));
    expect(video?.externalId).toBe(firstSteps.find((step) => step.kind === 'video')?.externalId);
    // The still is made again for the creative (same bytes, same hash).
    const stills = api
      .writes('adimages')
      .filter((call) => /-capa\.jpg$/.test(call.fields.name ?? ''));
    expect(stills).toHaveLength(2);
  });
});

describe('a failure in the middle', () => {
  it.each([
    ['reject', 'failed'],
    ['server_error', 'unknown'],
  ] as const)(
    'ad set %s: records what exists, marks the outcome unknown, freezes, and stops',
    async (mode, stepStatus) => {
      const { accountDbId, api, client } = await world({ failOn: { edge: 'adsets', mode } });
      const { changeRequestId } = await requestAndApprove(accountDbId, draftOf());

      const result = await run(client, changeRequestId);
      expect(result).toMatchObject({ ok: false, outcome: 'unknown' });
      expect(result.outcome === 'unknown' && result.reason).toMatch(
        /interrompida depois da campanha/,
      );

      // Nothing after the failed step was attempted.
      expect(api.writes('adcreatives')).toHaveLength(0);
      expect(api.writes('ads')).toHaveLength(0);

      const steps = await stepsOfExecution(db, executionIdOf(result));
      expect(steps.map((step) => [step.kind, step.status])).toEqual([
        ['campaign', 'created'],
        ['image', 'created'],
        ['image', 'created'],
        ['ad_set', stepStatus],
      ]);
      expect(steps.at(-1)?.message).toBeTruthy();

      const account = await db.query.adAccounts.findFirst({
        where: eq(adAccounts.id, accountDbId),
      });
      expect(account?.killSwitchEngaged).toBe(true);
      const change = await db.query.adChangeRequests.findFirst({
        where: eq(adChangeRequests.id, changeRequestId),
      });
      expect(change?.status).toBe('unknown');
      // The campaign that does exist is mirrored, so a person can find it.
      expect(
        await db.query.adCampaigns.findMany({ where: eq(adCampaigns.adAccountId, accountDbId) }),
      ).toHaveLength(1);

      // Never retried: a second click is refused and sends nothing more.
      const writesSoFar = api.writes().length;
      expect(await run(client, changeRequestId)).toMatchObject({ outcome: 'refused' });
      expect(api.writes()).toHaveLength(writesSoFar);
    },
  );

  it('second ad fails: the first ad stays on record', async () => {
    const { accountDbId, api } = await world();
    const { changeRequestId } = await requestAndApprove(accountDbId, draftOf());
    // Let the first creative through, then make Meta refuse the next one.
    const original = api.impl;
    let creatives = 0;
    const flaky = ((url: unknown, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/adcreatives')) {
        creatives += 1;
        if (creatives === 2) api.state.failOn = { edge: 'adcreatives', mode: 'reject' };
      }
      return original(url as string, init);
    }) as typeof fetch;
    const flakyClient = new MetaWriteClient({
      accessToken: 'token',
      adAccountId: api.accountId,
      confirmWrites: true,
      fetchImpl: flaky,
    });
    const result = await run(flakyClient, changeRequestId);
    expect(result).toMatchObject({ outcome: 'unknown' });
    const steps = await stepsOfExecution(db, executionIdOf(result));
    expect(steps.map((step) => [step.kind, step.status]).slice(-3)).toEqual([
      ['creative', 'created'],
      ['ad', 'created'],
      ['creative', 'failed'],
    ]);
  });

  it('campaign itself refused: nothing exists, so it is a plain rejection', async () => {
    const { accountDbId, api, client } = await world({
      failOn: { edge: 'campaigns', mode: 'reject' },
    });
    const { changeRequestId } = await requestAndApprove(accountDbId, draftOf());

    expect(await run(client, changeRequestId)).toMatchObject({ outcome: 'rejected' });
    expect(api.writes()).toHaveLength(1);
    const account = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, accountDbId) });
    expect(account?.killSwitchEngaged).toBe(false);
  });
});

describe('a draft approved before ad sets existed', () => {
  it('creates the campaign shell alone, as it was approved to', async () => {
    const { accountDbId, api, client } = await world();
    const shell = { ...draftOf() };
    delete shell.identity;
    delete shell.placements;
    delete shell.ageMin;
    delete shell.ageMax;
    const { changeRequestId } = await requestAndApprove(accountDbId, shell);

    expect(await run(client, changeRequestId)).toMatchObject({ outcome: 'applied' });
    expect(api.writes().map((call) => call.path.split('/')[1])).toEqual(['campaigns']);
  });
});

describe('resuming a campaign the system created', () => {
  async function createdAndResumeApproved(
    api: ReturnType<typeof fakeMetaApi>,
    client: MetaWriteClient,
    accountDbId: string,
  ) {
    const { changeRequestId } = await requestAndApprove(accountDbId, draftOf());
    expect(await run(client, changeRequestId)).toMatchObject({ ok: true, outcome: 'applied' });
    const mirrored = await db.query.adCampaigns.findFirst({
      where: eq(adCampaigns.adAccountId, accountDbId),
    });
    if (!mirrored) throw new Error('expected the campaign mirrored');
    const resume = await reserveChange(db, {
      adAccountId: accountDbId,
      campaignId: mirrored.id,
      kind: 'resume_campaign',
    });
    if (!resume.ok) throw new Error(resume.message);
    const gate = await gateChange(db, { changeRequestId: resume.value.changeRequestId });
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    await decideApproval(db, {
      approvalId: gate.approvalId!,
      approverEmployeeId: admin.id,
      decision: 'approved',
    });
    const campaignId = api.state.campaigns[0]!.id;
    const adSets = [...api.state.objects]
      .filter(([, object]) => object.edge === 'adsets')
      .map(([id]) => id);
    const ads = [...api.state.objects]
      .filter(([, object]) => object.edge === 'ads')
      .map(([id]) => id);
    return {
      resumeId: resume.value.changeRequestId,
      campaignId,
      adSets,
      ads,
      mirroredId: mirrored.id,
    };
  }

  it('switches on the ads, then the ad set, then the campaign, and keeps what Meta reports after', async () => {
    const { accountDbId, api, client } = await world();
    const { resumeId, campaignId, adSets, ads, mirroredId } = await createdAndResumeApproved(
      api,
      client,
      accountDbId,
    );
    expect(adSets).toHaveLength(1);
    expect(ads).toHaveLength(2);
    const before = api.writes().length;

    const resumed = await run(client, resumeId);
    expect(resumed).toMatchObject({ ok: true, outcome: 'applied' });

    const statusWrites = api.writes().slice(before);
    // The campaign is the last switch: until it is on, nothing delivers.
    expect(statusWrites.map((call) => call.path)).toEqual([...ads, ...adSets, campaignId]);
    for (const call of statusWrites) expect(call.fields).toEqual({ status: 'ACTIVE' });
    expect(api.state.campaigns[0]?.status).toBe('ACTIVE');
    for (const id of [...adSets, ...ads]) expect(api.state.objects.get(id)?.status).toBe('ACTIVE');

    const [execution] = await db
      .select()
      .from(adExecutions)
      .where(eq(adExecutions.changeRequestId, resumeId));
    expect(execution?.platformResponse).toMatchObject({
      statusesAfter: Object.fromEntries([
        ...ads.map((id) => [`ad:${id}`, 'ACTIVE']),
        ...adSets.map((id) => [`adSet:${id}`, 'ACTIVE']),
      ]),
    });
    expect(
      await db.query.adCampaigns.findFirst({ where: eq(adCampaigns.id, mirroredId) }),
    ).toMatchObject({ status: 'ACTIVE' });
  });

  it('an ad set Meta refuses to switch on stops before the campaign, which stays paused', async () => {
    const { accountDbId, api, client } = await world();
    const { resumeId, adSets, ads } = await createdAndResumeApproved(api, client, accountDbId);
    api.state.refuseStatusOn = adSets[0];

    const result = await run(client, resumeId);
    expect(result).toMatchObject({ ok: false, outcome: 'rejected' });
    expect(api.state.campaigns[0]?.status).toBe('PAUSED');
    // The ads went on first, under a paused campaign: nothing delivers.
    for (const id of ads) expect(api.state.objects.get(id)?.status).toBe('ACTIVE');
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, resumeId),
    });
    expect(change?.status).toBe('failed');
  });
});
