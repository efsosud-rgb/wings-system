import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeMetaApi, type FakeMetaApiOptions } from './fake-meta-api.js';
import { BRAZIL_STATES } from '@wings/shared';
import {
  BRAZIL_STATE_REGIONS,
  MetaReadOnlyClient,
  TargetingResolutionError,
} from './meta-client.js';
import { MetaWriteClient } from './meta-write-client.js';
import type { AdSetSpec, CreativeSpec } from './types.js';

/**
 * The Meta write client against a scripted Graph API. No test here or anywhere
 * writes to Meta; these are what the person at the first real click relies on.
 */

let directory: string;
let videoPath: string;
const VIDEO_BYTES = 2_500;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wings-video-'));
  videoPath = join(directory, 'video.mp4');
  await writeFile(videoPath, Buffer.alloc(VIDEO_BYTES, 7));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function writer(options: FakeMetaApiOptions = {}) {
  const api = fakeMetaApi(options);
  const client = new MetaWriteClient({
    accessToken: 'token',
    adAccountId: api.accountId,
    confirmWrites: true,
    fetchImpl: api.impl,
    videoPollIntervalMs: 1,
    videoProcessingTimeoutMs: 200,
  });
  return { api, client };
}

const adSetSpec: AdSetSpec = {
  campaignId: '120210000000001',
  name: 'Campanha — conjunto',
  startDate: '2026-09-21',
  endDate: '2026-09-30',
  optimization: { goal: 'OFFSITE_CONVERSIONS', pixelId: '1116678872845520', event: 'LEAD' },
  targeting: {
    regions: [{ key: '460', name: 'São Paulo' }],
    cities: [{ key: '268478', name: 'Curitiba', region: 'Paraná' }],
    localeKey: 31,
  },
  customLocations: [{ latitude: -23.5, longitude: -46.6, radiusKm: 15 }],
  ageMin: 25,
  ageMax: 65,
  placements: null,
};

const creativeBase: Omit<CreativeSpec, 'body'> = {
  name: 'Campanha — v1',
  pageId: '104567890123456',
  instagramUserId: '17841400000000000',
  message: 'Fale com a gente.',
  headline: 'Leve a Wings',
  callToAction: 'LEARN_MORE',
  link: 'https://wingscompany.com.br/franquia?utm_source=meta',
};

describe('the ad set', () => {
  it('is born PAUSED, under the campaign, optimising for the pixel Lead event', async () => {
    const { api, client } = writer();
    const outcome = await client.createAdSet(adSetSpec);

    expect(outcome.status).toBe('created');
    const fields = api.writes('adsets')[0]?.fields ?? {};
    expect(fields).toMatchObject({
      campaign_id: '120210000000001',
      status: 'PAUSED',
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      destination_type: 'WEBSITE',
      start_time: '2026-09-21T00:00:00-0300',
      end_time: '2026-09-30T23:59:59-0300',
    });
    // The campaign owns the budget: an ad set must not name one.
    expect(fields).not.toHaveProperty('daily_budget');
    expect(JSON.parse(fields.promoted_object ?? '{}')).toEqual({
      pixel_id: '1116678872845520',
      custom_event_type: 'LEAD',
    });
  });

  it('with automatic placements names none, so Meta chooses (Advantage+)', async () => {
    const { api, client } = writer();
    await client.createAdSet(adSetSpec);

    const targeting = JSON.parse(api.writes('adsets')[0]?.fields.targeting ?? '{}');
    expect(targeting).toEqual({
      geo_locations: {
        regions: [{ key: '460' }],
        cities: [{ key: '268478' }],
        custom_locations: [
          { latitude: -23.5, longitude: -46.6, radius: 15, distance_unit: 'kilometer' },
        ],
        location_types: ['home', 'recent'],
      },
      age_min: 25,
      age_max: 65,
      locales: [31],
      targeting_automation: { advantage_audience: 0 },
    });
  });

  it('with manual placements names exactly the chosen ones, in Meta’s words', async () => {
    const { api, client } = writer();
    await client.createAdSet({
      ...adSetSpec,
      optimization: { goal: 'LANDING_PAGE_VIEWS' },
      placements: { facebook: ['feed', 'reels'], instagram: ['stories'], threads: [] },
    });

    const fields = api.writes('adsets')[0]?.fields ?? {};
    expect(fields.optimization_goal).toBe('LANDING_PAGE_VIEWS');
    expect(fields).not.toHaveProperty('promoted_object');
    expect(JSON.parse(fields.targeting ?? '{}')).toMatchObject({
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['feed', 'facebook_reels'],
      instagram_positions: ['story'],
    });
    expect(JSON.parse(fields.targeting ?? '{}')).not.toHaveProperty('threads_positions');

    const { api: facebookOnly, client: other } = writer();
    await other.createAdSet({
      ...adSetSpec,
      placements: { facebook: ['stories'], instagram: [], threads: [] },
    });
    const only = JSON.parse(facebookOnly.writes('adsets')[0]?.fields.targeting ?? '{}');
    expect(only.publisher_platforms).toEqual(['facebook']);
    expect(only).not.toHaveProperty('instagram_positions');
  });

  it('with Threads, names the one placement Meta offers there', async () => {
    const { api, client } = writer();
    await client.createAdSet({
      ...adSetSpec,
      placements: { facebook: [], instagram: ['feed'], threads: ['feed'] },
    });

    const targeting = JSON.parse(api.writes('adsets')[0]?.fields.targeting ?? '{}');
    expect(targeting.publisher_platforms).toEqual(['instagram', 'threads']);
    expect(targeting.threads_positions).toEqual(['threads_stream']);
  });
});

describe('media', () => {
  it('uploads an image as base64 and hands back Meta’s hash', async () => {
    const { api, client } = writer();
    const outcome = await client.uploadImage({ bytes: Buffer.from('png-bytes'), name: 'a.png' });

    expect(outcome).toMatchObject({ status: 'created' });
    expect(api.writes('adimages')[0]?.fields).toEqual({
      bytes: Buffer.from('png-bytes').toString('base64'),
      name: 'a.png',
    });
  });

  it('uploads a video in the chunks Meta asks for, waits for processing, takes the preferred still', async () => {
    const { api, client } = writer({
      videoChunkSize: 1_000,
      videoStatuses: ['processing', 'processing', 'ready'],
    });
    const outcome = await client.uploadVideo({
      filePath: videoPath,
      byteSize: VIDEO_BYTES,
      name: 'wings-video',
    });

    expect(outcome).toMatchObject({
      status: 'created',
      value: {
        // The preferred still, downloaded and uploaded as an ad image of its own.
        imageHash: expect.stringMatching(/^hash-/) as unknown as string,
        videoId: expect.stringMatching(/^\d+$/),
        thumbnailUrl: 'https://scontent.xx.fbcdn.net/t/preferred.jpg',
      },
    });
    const phases = api.writes('advideos').map((call) => call.fields.upload_phase);
    expect(phases).toEqual(['start', 'transfer', 'transfer', 'transfer', 'finish']);
    expect(api.writes('advideos')[0]?.fields.file_size).toBe(String(VIDEO_BYTES));
    expect(
      api
        .writes('advideos')
        .filter((call) => call.fields.upload_phase === 'transfer')
        .map((call) => [call.fields.start_offset, call.fields.video_file_chunk]),
    ).toEqual([
      ['0', '<1000 bytes>'],
      ['1000', '<1000 bytes>'],
      ['2000', '<500 bytes>'],
    ]);
  });

  it('calls a video Meta could not process unknown — the video object already exists', async () => {
    const { client } = writer({ videoStatuses: ['processing', 'error'] });
    const outcome = await client.uploadVideo({
      filePath: videoPath,
      byteSize: VIDEO_BYTES,
      name: 'wings-video',
    });
    expect(outcome.status).toBe('unknown');
    expect(outcome.status === 'unknown' && outcome.reason).toMatch(/já existe na Meta/);
  });

  it('gives up waiting for processing, as unknown', async () => {
    const { client } = writer({ videoStatuses: ['processing'] });
    const outcome = await client.uploadVideo({
      filePath: videoPath,
      byteSize: VIDEO_BYTES,
      name: 'wings-video',
    });
    expect(outcome.status === 'unknown' && outcome.reason).toMatch(/não terminou a tempo/);
  });

  it('is rejected cleanly when Meta refuses to start the upload: nothing exists yet', async () => {
    const { client } = writer({ failOn: { edge: 'advideos', mode: 'reject' } });
    const outcome = await client.uploadVideo({
      filePath: videoPath,
      byteSize: VIDEO_BYTES,
      name: 'wings-video',
    });
    expect(outcome.status).toBe('rejected');
  });
});

describe('creatives and ads', () => {
  const storyOf = (api: ReturnType<typeof fakeMetaApi>) =>
    JSON.parse(api.writes('adcreatives')[0]?.fields.object_story_spec ?? '{}');

  it('single image: page, Instagram account, copy, image hash and button', async () => {
    const { api, client } = writer();
    await client.createCreative({
      ...creativeBase,
      body: { type: 'single', media: { kind: 'image', imageHash: 'abc123' } },
    });

    expect(storyOf(api)).toEqual({
      page_id: '104567890123456',
      instagram_user_id: '17841400000000000',
      link_data: {
        link: creativeBase.link,
        message: 'Fale com a gente.',
        name: 'Leve a Wings',
        image_hash: 'abc123',
        call_to_action: { type: 'LEARN_MORE', value: { link: creativeBase.link } },
      },
    });
    // The retired field must never come back.
    expect(api.writes('adcreatives')[0]?.fields.object_story_spec).not.toContain(
      'instagram_actor_id',
    );
  });

  it('video: video id, Meta’s still, title and button', async () => {
    const { api, client } = writer();
    await client.createCreative({
      ...creativeBase,
      instagramUserId: null,
      body: {
        type: 'single',
        media: {
          kind: 'video',
          videoId: '999',
          thumbnailUrl: 'https://x/t.jpg',
          imageHash: 'h-still',
        },
      },
    });

    const story = storyOf(api);
    expect(story).not.toHaveProperty('instagram_user_id');
    expect(story.video_data).toEqual({
      video_id: '999',
      image_hash: 'h-still',
      title: 'Leve a Wings',
      message: 'Fale com a gente.',
      call_to_action: { type: 'LEARN_MORE', value: { link: creativeBase.link } },
    });
  });

  it('carousel: cards in the approved order, image and video mixed', async () => {
    const { api, client } = writer();
    await client.createCreative({
      ...creativeBase,
      body: {
        type: 'carousel',
        cards: [
          {
            media: { kind: 'image', imageHash: 'h1' },
            headline: 'Cartão 1',
            description: 'Suporte.',
            link: 'https://wingscompany.com.br/a',
          },
          {
            media: {
              kind: 'video',
              videoId: '999',
              thumbnailUrl: 'https://x/t.jpg',
              imageHash: 'h-still',
            },
            headline: 'Cartão 2',
            description: 'Modelo.',
            link: 'https://wingscompany.com.br/b',
          },
        ],
      },
    });

    const linkData = storyOf(api).link_data;
    expect(linkData.multi_share_optimized).toBe(false);
    expect(linkData.child_attachments).toEqual([
      {
        link: 'https://wingscompany.com.br/a',
        name: 'Cartão 1',
        description: 'Suporte.',
        call_to_action: { type: 'LEARN_MORE', value: { link: 'https://wingscompany.com.br/a' } },
        image_hash: 'h1',
      },
      {
        link: 'https://wingscompany.com.br/b',
        name: 'Cartão 2',
        description: 'Modelo.',
        call_to_action: { type: 'LEARN_MORE', value: { link: 'https://wingscompany.com.br/b' } },
        video_id: '999',
        image_hash: 'h-still',
      },
    ]);
  });

  it('an ad is born PAUSED, and there is no way to ask otherwise', async () => {
    const { api, client } = writer();
    const outcome = await client.createAd({ name: 'Anúncio', adSetId: '1', creativeId: '2' });

    expect(outcome.status).toBe('created');
    expect(api.writes('ads')[0]?.fields).toEqual({
      name: 'Anúncio',
      adset_id: '1',
      creative: JSON.stringify({ creative_id: '2' }),
      status: 'PAUSED',
    });
  });

  it.each([
    ['reject', 'rejected'],
    ['server_error', 'unknown'],
    ['network_failure', 'unknown'],
  ] as const)('a %s from Meta on the ad set is %s', async (mode, status) => {
    const { client } = writer({ failOn: { edge: 'adsets', mode } });
    expect((await client.createAdSet(adSetSpec)).status).toBe(status);
  });

  it('keeps the token in a header, never in a URL or a form field', async () => {
    const { api, client } = writer();
    await client.createAd({ name: 'Anúncio', adSetId: '1', creativeId: '2' });
    const call = api.writes('ads')[0];
    expect(call?.headers.authorization).toBe('Bearer token');
    expect(JSON.stringify([call?.query, call?.fields])).not.toContain('token');
  });
});

describe('reads that come before any write', () => {
  const reader = (options: FakeMetaApiOptions = {}) => {
    const api = fakeMetaApi(options);
    return {
      api,
      client: new MetaReadOnlyClient({
        accessToken: 'token',
        adAccountId: api.accountId,
        fetchImpl: api.impl,
      }),
    };
  };

  it('resolves states, cities inside their state, and Portuguese (Brazil)', async () => {
    const { client } = reader();
    expect(
      await client.resolveTargeting({
        states: ['SP'],
        cities: [{ name: 'curitiba', state: 'PR' }],
      }),
    ).toEqual({
      regions: [{ key: '460', name: 'São Paulo' }],
      cities: [{ key: '268478', name: 'Curitiba', region: 'Paraná' }],
      localeKey: 31,
    });
  });

  it('places DF, GO, RJ and SC by the keys Meta answered, with no region search', async () => {
    // The request of 2026-09-30 failed on "A Meta não conhece \"DF\"": Meta
    // names it "Federal District", which a name search for "Distrito Federal"
    // could never match.
    const { api, client } = reader();
    const resolved = await client.resolveTargeting({
      states: ['DF', 'GO', 'RJ', 'SC'],
      cities: [],
    });
    expect(resolved.regions).toEqual([
      { key: '444', name: 'Federal District' },
      { key: '462', name: 'Goiás' },
      { key: '454', name: 'Rio de Janeiro' },
      { key: '459', name: 'Santa Catarina' },
    ]);
    expect(
      api.calls.filter((call) => (call.query.location_types ?? '').includes('region')),
    ).toHaveLength(0);
  });

  it('has a Meta region for every state the builder offers', () => {
    expect(Object.keys(BRAZIL_STATE_REGIONS).sort()).toEqual([...BRAZIL_STATES].sort());
    expect(new Set(Object.values(BRAZIL_STATE_REGIONS).map((region) => region.key)).size).toBe(27);
  });

  it('refuses a city Meta does not know, knows twice, or knows in another state', async () => {
    const { api, client } = reader();
    for (const city of [
      { name: 'Atlântida', state: 'SP' },
      { name: 'Bom Jesus', state: 'MG' },
      { name: 'Campinas', state: 'PR' },
    ]) {
      await expect(client.resolveTargeting({ states: [], cities: [city] })).rejects.toBeInstanceOf(
        TargetingResolutionError,
      );
    }
    expect(api.writes()).toHaveLength(0);
  });

  it('lists the Pages the system user can act for, with the account’s Instagram accounts', async () => {
    const { client } = reader();
    expect(await client.listIdentities()).toEqual({
      pages: [
        {
          id: '104567890123456',
          name: 'Wings Company',
          instagramAccounts: [{ id: '17841400000000000', username: 'wingscompany' }],
        },
      ],
    });
  });

  it('hands back the address of Meta’s own preview, unescaped', async () => {
    const { client } = reader();
    expect(await client.getAdPreview('120210000000009', 'INSTAGRAM_STORY')).toBe(
      'https://www.facebook.com/ads/api/preview_iframe.php?d=abc&t=INSTAGRAM_STORY',
    );
    expect(await client.getAdPreview('1 OR 1=1', 'INSTAGRAM_STORY')).toBeNull();
  });
});
