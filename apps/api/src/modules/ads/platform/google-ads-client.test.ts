import { GOOGLE_ACCOUNT_URL_SUFFIX } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import { BRAZIL_GEO, fakeGoogleApi } from './fake-google-api.js';
import {
  GoogleAdsPlatformClient,
  GoogleAdsWriteClient,
  PORTUGUESE_LANGUAGE_CONSTANT,
  googleLocationCriteria,
  microsFromCents,
  googleFailure,
} from './google-ads-client.js';
import type { CreateCampaignSpec } from './types.js';

/**
 * Everything here runs against a scripted Google Ads API. No test in this
 * repository writes to Google: the first real write happens in production with
 * a person watching, and these tests are what that person is relying on.
 */

type Operation = Record<string, { create: Record<string, unknown> }>;

const searchSpec: CreateCampaignSpec = {
  name: 'Pesquisa — franquia SP',
  objective: 'OUTCOME_LEADS',
  status: 'PAUSED',
  dailyBudgetCents: 3000,
  google: {
    channel: 'SEARCH',
    bidding: 'MAXIMIZE_CONVERSIONS',
    startDate: '2026-09-21',
    endDate: '2026-09-30',
    reach: { states: ['SP'], cities: [{ name: 'Curitiba', state: 'PR' }], customLocations: [] },
    search: {
      adGroupName: 'Franquia SP',
      locationMode: 'PRESENCE',
      bidding: 'MAXIMIZE_CLICKS',
      maxCpcCents: 600,
      keywords: [
        { text: 'franquia de alimentação', match: 'EXACT' },
        { text: 'abrir franquia', match: 'PHRASE' },
      ],
      negativeKeywords: ['grátis', 'emprego'],
      headlines: ['Franquia Wings', 'Expanda sua marca', 'Fale com a Wings'],
      descriptions: ['Conheça o modelo de negócio.', 'Suporte do início ao fim.'],
      finalUrl: 'https://wingscompany.com.br/franquia?utm_source=google',
    },
  },
};

const LOGO = Buffer.from('a square png, as far as this test cares').toString('base64');

const youtubeSpec: CreateCampaignSpec = {
  name: 'YouTube · Formatação · Out26',
  objective: 'OUTCOME_LEADS',
  status: 'PAUSED',
  dailyBudgetCents: 5000,
  google: {
    channel: 'DEMAND_GEN',
    bidding: 'MAXIMIZE_CONVERSIONS',
    startDate: '2026-10-09',
    endDate: '2026-10-15',
    reach: { states: ['SP'], cities: [{ name: 'Curitiba', state: 'PR' }], customLocations: [] },
    demandGen: {
      adGroupName: 'YouTube · Formatação · Out26',
      channels: { youtubeInStream: true, youtubeInFeed: true, youtubeShorts: true },
      ageMin: 25,
      ageMax: null,
      includeUnknownAge: false,
      audienceSegments: [],
      conversionActionId: '77',
      conversionActionName: 'RD form conversion',
      videoIds: ['34zzJBPHlYg', 'M0v5U4AaTvo'],
      headlines: ['Sua empresa pode virar franquia?'],
      longHeadlines: ['Sua empresa tem potencial para virar uma rede de franquias'],
      descriptions: ['O sucesso começa com um diagnóstico.'],
      businessName: 'Wings Company',
      logo: { driveFileId: '7c1f4a52-2b8e-4d0a-9f3e-1a2b3c4d5e6f', data: LOGO },
      finalUrl: 'https://wingssystem.online/lp/formatacao',
      finalUrlSuffix:
        'utm_source=youtube&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}',
    },
  },
};

const withDemandGen = (
  patch: Partial<NonNullable<NonNullable<CreateCampaignSpec['google']>['demandGen']>>,
  google: Partial<NonNullable<CreateCampaignSpec['google']>> = {},
): CreateCampaignSpec => ({
  ...youtubeSpec,
  google: {
    ...youtubeSpec.google!,
    ...google,
    demandGen: { ...youtubeSpec.google!.demandGen!, ...patch },
  },
});

function writer(api = fakeGoogleApi()) {
  return { api, client: new GoogleAdsWriteClient(api.reader, { confirmWrites: true }) };
}

const operationsOf = (api: ReturnType<typeof fakeGoogleApi>): Operation[] =>
  (api.mutateCalls()[0]?.body.mutateOperations ?? []) as Operation[];

describe('creating a Search campaign', () => {
  it('sends budget, campaign, locations and language in one atomic mutate', async () => {
    const { api, client } = writer();
    const outcome = await client.createCampaign(searchSpec);

    expect(outcome.status).toBe('applied');
    expect(api.mutateCalls()).toHaveLength(1);
    expect(api.mutateCalls()[0]?.url).toBe(
      'https://googleads.googleapis.com/v22/customers/4268586278/googleAds:mutate',
    );
    expect(api.mutateCalls()[0]?.body.partialFailure).toBe(false);

    const operations = operationsOf(api);
    const budget = operations[0]?.campaignBudgetOperation?.create;
    const campaign = operations[1]?.campaignOperation?.create;

    expect(budget).toMatchObject({
      resourceName: 'customers/4268586278/campaignBudgets/-1',
      amountMicros: '30000000',
      deliveryMethod: 'STANDARD',
      explicitlyShared: false,
    });
    expect(campaign).toMatchObject({
      resourceName: 'customers/4268586278/campaigns/-2',
      name: 'Pesquisa — franquia SP',
      status: 'PAUSED',
      advertisingChannelType: 'SEARCH',
      campaignBudget: 'customers/4268586278/campaignBudgets/-1',
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      startDate: '2026-09-21',
      endDate: '2026-09-30',
      // Maximize clicks with a ceiling of R$ 6,00 per click, from the draft.
      targetSpend: { cpcBidCeilingMicros: '6000000' },
      networkSettings: {
        targetGoogleSearch: true,
        targetSearchNetwork: false,
        targetContentNetwork: false,
        targetPartnerSearchNetwork: false,
      },
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },
    });

    // Locations and language; the negatives are checked with the ad group.
    const criteria = operations
      .map((op) => op.campaignCriterionOperation?.create)
      .filter((create) => create && create.negative !== true);
    expect(criteria).toEqual([
      {
        campaign: 'customers/4268586278/campaigns/-2',
        location: { geoTargetConstant: 'geoTargetConstants/20106' },
      },
      {
        campaign: 'customers/4268586278/campaigns/-2',
        location: { geoTargetConstant: 'geoTargetConstants/1001634' },
      },
      {
        campaign: 'customers/4268586278/campaigns/-2',
        language: { languageConstant: PORTUGUESE_LANGUAGE_CONSTANT },
      },
    ]);
  });

  it('creates the ad group, its keywords, the negatives and the ad in the same atomic mutate, all paused', async () => {
    const { api, client } = writer();
    const outcome = await client.createCampaign(searchSpec);
    if (outcome.status !== 'applied') throw new Error('expected applied');

    expect(api.writeCalls()).toHaveLength(1);
    const operations = operationsOf(api);
    const kinds = new Set(operations.flatMap((operation) => Object.keys(operation)));
    expect([...kinds].sort()).toEqual([
      'adGroupAdOperation',
      'adGroupCriterionOperation',
      'adGroupOperation',
      'campaignBudgetOperation',
      'campaignCriterionOperation',
      'campaignOperation',
    ]);

    // Negatives on the campaign, phrase match, so any ad group added by hand inherits them.
    const negatives = operations
      .map((op) => op.campaignCriterionOperation?.create)
      .filter((create) => create?.negative === true);
    expect(negatives).toEqual([
      {
        campaign: 'customers/4268586278/campaigns/-2',
        negative: true,
        keyword: { text: 'grátis', matchType: 'PHRASE' },
      },
      {
        campaign: 'customers/4268586278/campaigns/-2',
        negative: true,
        keyword: { text: 'emprego', matchType: 'PHRASE' },
      },
    ]);

    // The ad group: paused, standard search, under the temporary campaign.
    expect(operations.find((op) => op.adGroupOperation)?.adGroupOperation?.create).toEqual({
      resourceName: 'customers/4268586278/adGroups/-3',
      name: 'Franquia SP',
      campaign: 'customers/4268586278/campaigns/-2',
      status: 'PAUSED',
      type: 'SEARCH_STANDARD',
    });

    // Keywords with the match the draft wrote; never broad.
    const keywords = operations.map((op) => op.adGroupCriterionOperation?.create).filter(Boolean);
    expect(keywords).toEqual([
      {
        adGroup: 'customers/4268586278/adGroups/-3',
        status: 'ENABLED',
        keyword: { text: 'franquia de alimentação', matchType: 'EXACT' },
      },
      {
        adGroup: 'customers/4268586278/adGroups/-3',
        status: 'ENABLED',
        keyword: { text: 'abrir franquia', matchType: 'PHRASE' },
      },
    ]);

    // The responsive search ad: paused, final URL with UTMs, headlines and descriptions.
    expect(operations.find((op) => op.adGroupAdOperation)?.adGroupAdOperation?.create).toEqual({
      adGroup: 'customers/4268586278/adGroups/-3',
      status: 'PAUSED',
      ad: {
        finalUrls: ['https://wingscompany.com.br/franquia?utm_source=google'],
        responsiveSearchAd: {
          headlines: [
            { text: 'Franquia Wings' },
            { text: 'Expanda sua marca' },
            { text: 'Fale com a Wings' },
          ],
          descriptions: [
            { text: 'Conheça o modelo de negócio.' },
            { text: 'Suporte do início ao fim.' },
          ],
        },
      },
    });

    // What Google made, by id, for the execution's step list.
    expect(outcome.created?.map((object) => object.kind)).toEqual([
      'negative_keyword',
      'negative_keyword',
      'ad_group',
      'keyword',
      'keyword',
      'ad',
    ]);
    const adGroup = api.adGroups[0];
    expect(outcome.created?.find((object) => object.kind === 'ad_group')?.externalId).toBe(
      adGroup?.id,
    );
    expect(outcome.created?.find((object) => object.kind === 'ad')?.externalId).toBe(
      api.ads[0]?.id,
    );
    expect(adGroup).toMatchObject({
      status: 'PAUSED',
      keywords: [{ matchType: 'EXACT' }, { matchType: 'PHRASE' }],
    });
    expect(api.ads[0]).toMatchObject({ status: 'PAUSED' });
    expect(outcome.detail).toMatchObject({
      adGroup: 'Franquia SP',
      keywords: 2,
      negativeKeywords: 2,
      headlines: 3,
      descriptions: 2,
    });
  });

  it('bids and places people as the draft says: conversions, or presence-or-interest', async () => {
    const { api, client } = writer();
    await client.createCampaign({
      ...searchSpec,
      google: {
        ...searchSpec.google!,
        search: {
          ...searchSpec.google!.search!,
          locationMode: 'PRESENCE_OR_INTEREST',
          bidding: 'MAXIMIZE_CONVERSIONS',
          maxCpcCents: undefined,
        },
      },
    });
    const campaign = operationsOf(api)[1]?.campaignOperation?.create;
    expect(campaign).toMatchObject({
      maximizeConversions: {},
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST' },
    });
    expect(campaign).not.toHaveProperty('targetSpend');
  });

  it('refuses a Search spec without its ad group, before any read or write', async () => {
    const { api, client } = writer();
    const outcome = await client.createCampaign({
      ...searchSpec,
      google: { ...searchSpec.google!, search: undefined },
    });
    expect(outcome).toMatchObject({ status: 'rejected', code: 'google_search_spec_missing' });
    expect(api.calls).toHaveLength(0);
  });

  it('re-reads the campaign it made, and keeps the places it resolved as evidence', async () => {
    const { client } = writer();
    const outcome = await client.createCampaign(searchSpec);

    if (outcome.status !== 'applied') throw new Error('expected applied');
    expect(outcome.campaign).toMatchObject({
      name: 'Pesquisa — franquia SP',
      status: 'PAUSED',
      dailyBudgetCents: 3000,
    });
    expect(outcome.detail).toMatchObject({
      channel: 'SEARCH',
      locations: [
        { asked: 'SP', canonicalName: 'State of Sao Paulo,Brazil' },
        { asked: 'Curitiba/PR', canonicalName: 'Curitiba,State of Parana,Brazil' },
      ],
    });
  });

  it('never sends login-customer-id, on reads or on the write', async () => {
    const { api, client } = writer();
    await client.createCampaign(searchSpec);
    expect(api.calls.length).toBeGreaterThan(1);
    for (const call of api.calls) expect(call.headers).not.toHaveProperty('login-customer-id');
  });
});

/**
 * A radius drawn on the builder's map becomes a Google proximity criterion: the
 * point in micro degrees, the radius in kilometres. It lives beside states and
 * cities on the same campaign, never instead of them.
 */
describe('the reach translator: a radius on Google', () => {
  const campinas = { latitude: -22.9056, longitude: -47.0608, radiusKm: 15, label: 'Campinas' };
  const CAMPAIGN = 'customers/4268586278/campaigns/-2';
  const withReach = (reach: NonNullable<CreateCampaignSpec['google']>['reach']) => ({
    ...searchSpec,
    google: { ...searchSpec.google!, reach },
  });

  it('translates a point and a radius into micro degrees and kilometres', () => {
    expect(googleLocationCriteria(CAMPAIGN, [], [campinas])).toEqual([
      {
        campaignCriterionOperation: {
          create: {
            campaign: CAMPAIGN,
            proximity: {
              geoPoint: {
                latitudeInMicroDegrees: -22_905_600,
                longitudeInMicroDegrees: -47_060_800,
              },
              radius: 15,
              radiusUnits: 'KILOMETERS',
            },
          },
        },
      },
    ]);
  });

  it('sends whole micro degrees, whatever floating point makes of the product', () => {
    // -23.55052 * 1e6 is -23550519.999999996 in floating point.
    const [operation] = googleLocationCriteria(
      CAMPAIGN,
      [],
      [{ latitude: -23.55052, longitude: -46.63331, radiusKm: 1 }],
    ) as Operation[];
    expect(operation?.campaignCriterionOperation?.create.proximity).toMatchObject({
      geoPoint: { latitudeInMicroDegrees: -23_550_520, longitudeInMicroDegrees: -46_633_310 },
    });
  });

  it('sends the radius beside states and cities, in the same atomic mutate', async () => {
    const { api, client } = writer();
    const outcome = await client.createCampaign(
      withReach({
        states: ['SP'],
        cities: [{ name: 'Curitiba', state: 'PR' }],
        customLocations: [campinas],
      }),
    );

    expect(outcome.status).toBe('applied');
    expect(api.mutateCalls()).toHaveLength(1);
    const criteria = operationsOf(api)
      .map((op) => op.campaignCriterionOperation?.create)
      .filter((create) => create && create.negative !== true);
    expect(criteria.map((criterion) => Object.keys(criterion ?? {}).sort())).toEqual([
      ['campaign', 'location'],
      ['campaign', 'location'],
      ['campaign', 'proximity'],
      ['campaign', 'language'],
    ]);
    expect(criteria.every((criterion) => criterion?.campaign === CAMPAIGN)).toBe(true);
    // The place name is for people; Google gets coordinates only.
    expect(JSON.stringify(criteria)).not.toContain('Campinas');
    if (outcome.status !== 'applied') return;
    expect(outcome.detail).toMatchObject({
      radii: [{ latitude: -22.9056, longitude: -47.0608, radiusKm: 15 }],
    });
  });

  it('a reach of radii alone asks Google about no place at all', async () => {
    const { api, client } = writer();
    const outcome = await client.createCampaign(
      withReach({
        states: [],
        cities: [],
        customLocations: [campinas, { ...campinas, radiusKm: 80 }],
      }),
    );

    expect(outcome.status).toBe('applied');
    expect(api.searchCalls('geo_target_constant')).toHaveLength(0);
    const criteria = operationsOf(api)
      .slice(2)
      .map((op) => op.campaignCriterionOperation?.create);
    expect(criteria.filter((criterion) => criterion?.proximity)).toHaveLength(2);
    expect(criteria.filter((criterion) => criterion?.location)).toHaveLength(0);
  });

  it('on YouTube a radius is refused before anything is read or sent', async () => {
    const { api, client } = writer();
    const outcome = await client.createCampaign(
      withDemandGen({}, { reach: { states: ['SP'], cities: [], customLocations: [campinas] } }),
    );

    expect(outcome).toMatchObject({ status: 'rejected', code: 'google_radius_not_supported' });
    expect(api.calls).toHaveLength(0);
  });
});

/** The account's conversion, as Google names it. */
const RD_FORM = { id: '77', name: 'RD form conversion', status: 'ENABLED' };

describe('creating a YouTube (Demand Gen) campaign', () => {
  it('sends the whole tree in one atomic write, everything paused and on YouTube only', async () => {
    const { api, client } = writer(fakeGoogleApi({ conversionActions: [RD_FORM] }));
    const outcome = await client.createCampaign(youtubeSpec);

    expect(outcome.status).toBe('applied');
    expect(api.writeCalls()).toHaveLength(1);
    const operations = operationsOf(api);
    const kinds = operations.map((op) => Object.keys(op)[0]);
    expect(kinds).toEqual([
      'campaignBudgetOperation',
      'campaignOperation',
      'customConversionGoalOperation',
      'conversionGoalCampaignConfigOperation',
      'assetOperation',
      'assetOperation',
      'assetOperation',
      'audienceOperation',
      'adGroupOperation',
      'adGroupCriterionOperation',
      'adGroupCriterionOperation',
      'adGroupCriterionOperation',
      'adGroupCriterionOperation',
      'adGroupAdOperation',
    ]);

    expect(operations[1]?.campaignOperation?.create).toMatchObject({
      advertisingChannelType: 'DEMAND_GEN',
      status: 'PAUSED',
      maximizeConversions: {},
      demandGenCampaignSettings: { upgradedTargeting: true },
      finalUrlSuffix:
        'utm_source=youtube&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}',
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    });
    // Places and language are on the ad group, never on the campaign.
    expect(operations.some((op) => op.campaignCriterionOperation)).toBe(false);

    // It bids for the chosen conversion only, through a custom goal made for it.
    expect(operations[2]?.customConversionGoalOperation?.create).toMatchObject({
      name: 'Wings System · RD form conversion (77)',
      conversionActions: ['customers/4268586278/conversionActions/77'],
      status: 'ENABLED',
    });
    expect(operations[3]).toMatchObject({
      conversionGoalCampaignConfigOperation: {
        update: {
          resourceName: 'customers/4268586278/conversionGoalCampaignConfigs/-2',
          goalConfigLevel: 'CAMPAIGN',
          customConversionGoal: 'customers/4268586278/customConversionGoals/-5',
        },
        updateMask: 'goal_config_level,custom_conversion_goal',
      },
    });

    expect(operations[4]?.assetOperation?.create).toMatchObject({ imageAsset: { data: LOGO } });
    expect(
      operations.slice(5, 7).map((op) => op.assetOperation?.create?.youtubeVideoAsset),
    ).toEqual([{ youtubeVideoId: '34zzJBPHlYg' }, { youtubeVideoId: 'M0v5U4AaTvo' }]);
    // 25 to 65+, people of unknown age left out.
    expect(operations[7]?.audienceOperation?.create).toMatchObject({
      dimensions: [{ age: { ageRanges: [{ minAge: 25 }], includeUndetermined: false } }],
    });

    expect(operations[8]?.adGroupOperation?.create).toMatchObject({
      status: 'PAUSED',
      campaign: 'customers/4268586278/campaigns/-2',
      demandGenAdGroupSettings: {
        channelControls: {
          selectedChannels: {
            youtubeInStream: true,
            youtubeInFeed: true,
            youtubeShorts: true,
            discover: false,
            gmail: false,
            display: false,
          },
        },
      },
      audienceSetting: { useAudienceGrouped: true },
      optimizedTargetingEnabled: false,
    });
    const criteria = operations.slice(9, 13).map((op) => op.adGroupCriterionOperation?.create);
    expect(criteria.filter((criterion) => criterion?.location)).toHaveLength(2);
    expect(criteria).toContainEqual({
      adGroup: 'customers/4268586278/adGroups/-3',
      language: { languageConstant: PORTUGUESE_LANGUAGE_CONSTANT },
    });
    expect(criteria).toContainEqual({
      adGroup: 'customers/4268586278/adGroups/-3',
      audience: { audience: 'customers/4268586278/audiences/-4' },
    });

    expect(operations[13]?.adGroupAdOperation?.create).toMatchObject({
      status: 'PAUSED',
      ad: {
        finalUrls: ['https://wingssystem.online/lp/formatacao'],
        demandGenVideoResponsiveAd: {
          videos: [
            { asset: 'customers/4268586278/assets/-11' },
            { asset: 'customers/4268586278/assets/-12' },
          ],
          logoImages: [{ asset: 'customers/4268586278/assets/-10' }],
          businessName: { text: 'Wings Company' },
          headlines: [{ text: 'Sua empresa pode virar franquia?' }],
        },
      },
    });

    if (outcome.status !== 'applied') return;
    // The ad group and the ad become steps, so a resume switches them on.
    expect(outcome.created?.map((item) => item.kind)).toEqual(['ad_group', 'ad']);
    expect(outcome.detail).toMatchObject({
      channel: 'DEMAND_GEN',
      language: PORTUGUESE_LANGUAGE_CONSTANT,
      demandGen: {
        conversionAction: { id: '77', name: 'RD form conversion' },
        conversionGoal: 'criada nesta escrita',
        videos: ['34zzJBPHlYg', 'M0v5U4AaTvo'],
        ages: { min: 25, max: null, unknown: false },
      },
    });
    expect(api.goalConfigs).toHaveLength(1);
    expect(api.assets.find((asset) => asset.imageBytes)).toBeTruthy();
  });

  it("reuses the account's goal, bids at the target CPA and sends the signals", async () => {
    const api = fakeGoogleApi({
      conversionActions: [RD_FORM],
      customAudiences: [{ id: '1019547251', name: 'Concorrentes' }],
      userLists: [{ id: '9291286078', name: 'All visitors' }],
      customConversionGoals: [
        {
          resourceName: 'customers/4268586278/customConversionGoals/555',
          conversionActions: ['customers/4268586278/conversionActions/77'],
          status: 'ENABLED',
        },
      ],
    });
    const { client } = writer(api);
    const outcome = await client.createCampaign(
      withDemandGen({
        targetCpaCents: 9000,
        ageMin: 35,
        ageMax: 54,
        includeUnknownAge: true,
        channels: { youtubeInStream: true, youtubeInFeed: false, youtubeShorts: false },
        audienceSegments: [
          { kind: 'custom_audience', id: '1019547251', name: 'Concorrentes' },
          { kind: 'user_list', id: '9291286078', name: 'All visitors' },
        ],
      }),
    );

    expect(outcome.status).toBe('applied');
    const operations = operationsOf(api);
    expect(operations.some((op) => op.customConversionGoalOperation)).toBe(false);
    expect(operations[1]?.campaignOperation?.create).toMatchObject({
      maximizeConversions: { targetCpaMicros: microsFromCents(9000) },
    });
    const goal = operations.find((op) => op.conversionGoalCampaignConfigOperation);
    expect(goal).toMatchObject({
      conversionGoalCampaignConfigOperation: {
        update: { customConversionGoal: 'customers/4268586278/customConversionGoals/555' },
      },
    });
    expect(operations.find((op) => op.audienceOperation)).toMatchObject({
      audienceOperation: {
        create: {
          dimensions: [
            { age: { ageRanges: [{ minAge: 35, maxAge: 54 }], includeUndetermined: true } },
            {
              audienceSegments: {
                segments: [
                  {
                    customAudience: {
                      customAudience: 'customers/4268586278/customAudiences/1019547251',
                    },
                  },
                  { userList: { userList: 'customers/4268586278/userLists/9291286078' } },
                ],
              },
            },
          ],
        },
      },
    });
    expect(operations.find((op) => op.adGroupOperation)).toMatchObject({
      adGroupOperation: {
        create: {
          demandGenAdGroupSettings: {
            channelControls: {
              selectedChannels: {
                youtubeInStream: true,
                youtubeInFeed: false,
                youtubeShorts: false,
              },
            },
          },
          // Signals: Google may look beyond them, never beyond the ages.
          optimizedTargetingEnabled: true,
          excludeDemographicExpansion: true,
        },
      },
    });
    if (outcome.status !== 'applied') return;
    expect(outcome.detail).toMatchObject({
      demandGen: { conversionGoal: 'customers/4268586278/customConversionGoals/555' },
    });
  });

  it('sends no audience when it would restrict nothing', async () => {
    const { api, client } = writer(fakeGoogleApi({ conversionActions: [RD_FORM] }));
    const outcome = await client.createCampaign(
      withDemandGen({ ageMin: 18, ageMax: null, includeUnknownAge: true }),
    );
    expect(outcome.status).toBe('applied');
    const operations = operationsOf(api);
    expect(operations.some((op) => op.audienceOperation)).toBe(false);
    expect(
      operations.some((op) => op.adGroupCriterionOperation?.create?.audience !== undefined),
    ).toBe(false);
  });

  it('refuses a conversion action that is not live in the account, with nothing written', async () => {
    const api = fakeGoogleApi({
      conversionActions: [{ id: '77', name: 'RD form conversion', status: 'REMOVED' }],
    });
    const { client } = writer(api);
    const outcome = await client.createCampaign(youtubeSpec);

    expect(outcome).toMatchObject({ status: 'rejected', code: 'google_conversion_unavailable' });
    expect(api.mutateCalls()).toHaveLength(0);
  });

  it('sends 65+ as an open end: no maximum age', async () => {
    const { api, client } = writer(fakeGoogleApi({ conversionActions: [RD_FORM] }));
    await client.createCampaign(withDemandGen({ ageMin: 65, ageMax: null }));
    expect(operationsOf(api).find((op) => op.audienceOperation)).toMatchObject({
      audienceOperation: {
        create: { dimensions: [{ age: { ageRanges: [{ minAge: 65 }] } }] },
      },
    });
    const range = (
      operationsOf(api).find((op) => op.audienceOperation)?.audienceOperation?.create
        ?.dimensions as { age: { ageRanges: Record<string, number>[] } }[]
    )[0]?.age.ageRanges[0];
    expect(range).not.toHaveProperty('maxAge');
  });

  it('refuses when what the approver read no longer matches the account, with nothing written', async () => {
    // The conversion was renamed in Google Ads after approval.
    const renamed = fakeGoogleApi({
      conversionActions: [{ id: '77', name: 'Formulário antigo', status: 'ENABLED' }],
    });
    expect(await writer(renamed).client.createCampaign(youtubeSpec)).toMatchObject({
      status: 'rejected',
      code: 'google_conversion_changed',
    });
    expect(renamed.mutateCalls()).toHaveLength(0);

    // A signal that left the account.
    const gone = fakeGoogleApi({ conversionActions: [RD_FORM], customAudiences: [] });
    const withSignal = withDemandGen({
      audienceSegments: [{ kind: 'custom_audience', id: '1019547251', name: 'Concorrentes' }],
    });
    expect(await writer(gone).client.createCampaign(withSignal)).toMatchObject({
      status: 'rejected',
      code: 'google_audience_changed',
    });
    expect(gone.mutateCalls()).toHaveLength(0);

    // The goal this system would make exists, edited to hold other conversions.
    const conflict = fakeGoogleApi({
      conversionActions: [RD_FORM],
      customConversionGoals: [
        {
          resourceName: 'customers/4268586278/customConversionGoals/9',
          name: 'Wings System · RD form conversion (77)',
          conversionActions: [
            'customers/4268586278/conversionActions/77',
            'customers/4268586278/conversionActions/12',
          ],
          status: 'ENABLED',
        },
      ],
    });
    expect(await writer(conflict).client.createCampaign(youtubeSpec)).toMatchObject({
      status: 'rejected',
      code: 'google_conversion_goal_conflict',
    });
    expect(conflict.mutateCalls()).toHaveLength(0);
  });

  it('refuses a spec without its video ad or its logo, with nothing sent', async () => {
    const { api, client } = writer();
    const shell = await client.createCampaign({
      ...youtubeSpec,
      google: { ...youtubeSpec.google!, demandGen: undefined },
    });
    expect(shell).toMatchObject({ status: 'rejected', code: 'google_demand_gen_spec_missing' });
    const noLogo = await client.createCampaign(
      withDemandGen({ logo: { driveFileId: '7c1f4a52-2b8e-4d0a-9f3e-1a2b3c4d5e6f' } }),
    );
    expect(noLogo).toMatchObject({ status: 'rejected', code: 'google_logo_missing' });
    expect(api.calls).toHaveLength(0);
  });

  it('is rehearsed with the same request, validate-only', async () => {
    const api = fakeGoogleApi({ conversionActions: [RD_FORM] });
    const reader = new GoogleAdsPlatformClient(api.reader);
    const outcome = await reader.validateWrite({ kind: 'create_campaign', spec: youtubeSpec });

    expect(outcome).toMatchObject({ status: 'ok' });
    if (outcome.status !== 'ok') return;
    expect(outcome.operations).toContain('Logo');
    expect(outcome.operations).toContain('Anúncio de vídeo (Demand Gen)');
    expect(outcome.operations).toContain('Lance para "RD form conversion"');
    expect(api.mutateCalls()[0]?.body.validateOnly).toBe(true);
    expect(api.writeCalls()).toHaveLength(0);
  });

  it("reads what the builder offers: the account's conversions and segments", async () => {
    const api = fakeGoogleApi({
      conversionActions: [
        { id: '7804997444', name: 'RD form conversion', status: 'ENABLED', primaryForGoal: true },
        { id: '12', name: 'form_submit', status: 'ENABLED', category: 'SUBMIT_LEAD_FORM' },
        { id: '13', name: 'Antiga', status: 'REMOVED' },
      ],
      userLists: [{ id: '9291286078', name: 'All visitors' }],
      customAudiences: [{ id: '1019547251', name: 'Concorrentes' }],
    });
    const options = await new GoogleAdsPlatformClient(api.reader).demandGenOptions();

    expect(options.conversionActions).toEqual([
      { id: '12', name: 'form_submit', category: 'SUBMIT_LEAD_FORM', primary: false },
      { id: '7804997444', name: 'RD form conversion', category: null, primary: true },
    ]);
    expect(options.audienceSegments).toEqual([
      { kind: 'user_list', id: '9291286078', name: 'All visitors' },
      { kind: 'custom_audience', id: '1019547251', name: 'Concorrentes' },
    ]);
    expect(api.writeCalls()).toHaveLength(0);
  });
});

describe('what the write client refuses without calling Google', () => {
  it('a campaign that would be born active', async () => {
    const { api, client } = writer();
    const outcome = await client.createCampaign({ ...searchSpec, status: 'ACTIVE' });

    expect(outcome).toMatchObject({ status: 'rejected', code: 'google_must_start_paused' });
    expect(api.calls).toHaveLength(0);
  });

  it('a spec with no Google part', async () => {
    const { api, client } = writer();
    const outcome = await client.createCampaign({ ...searchSpec, google: undefined });
    expect(outcome).toMatchObject({ status: 'rejected', code: 'google_spec_missing' });
    expect(api.mutateCalls()).toHaveLength(0);
  });

  it('a shared budget: changing it would change other campaigns', async () => {
    const { api, client } = writer(
      fakeGoogleApi({
        campaigns: [
          {
            id: '111',
            name: 'Search - Wings - Geral',
            status: 'ENABLED',
            amountMicros: '30000000',
            explicitlyShared: true,
          },
        ],
      }),
    );
    const outcome = await client.setDailyBudget('111', 5000);
    expect(outcome).toMatchObject({ status: 'rejected', code: 'google_shared_budget' });
    expect(api.mutateCalls()).toHaveLength(0);
    expect((await client.setAccountSpendCap()).status).toBe('rejected');
  });

  it('a place Google does not know, or knows twice', async () => {
    const { api, client } = writer();

    const unknown = await client.createCampaign({
      ...searchSpec,
      google: {
        ...searchSpec.google!,
        reach: { states: [], cities: [{ name: 'Atlântida', state: 'SP' }], customLocations: [] },
      },
    });
    expect(unknown).toMatchObject({ status: 'rejected', code: 'geo_unresolved' });

    const ambiguous = await client.createCampaign({
      ...searchSpec,
      google: {
        ...searchSpec.google!,
        reach: { states: [], cities: [{ name: 'Bom Jesus', state: 'MG' }], customLocations: [] },
      },
    });
    expect(ambiguous).toMatchObject({ status: 'rejected', code: 'geo_unresolved' });

    // The right name in the wrong state is not that city.
    const wrongState = await client.createCampaign({
      ...searchSpec,
      google: {
        ...searchSpec.google!,
        reach: { states: [], cities: [{ name: 'Campinas', state: 'PR' }], customLocations: [] },
      },
    });
    expect(wrongState).toMatchObject({ status: 'rejected', code: 'geo_unresolved' });

    expect(api.mutateCalls()).toHaveLength(0);
  });

  it('cannot be built without saying writes are intended', () => {
    const api = fakeGoogleApi();
    expect(
      () => new GoogleAdsWriteClient(api.reader, { confirmWrites: false as unknown as true }),
    ).toThrow(/confirmWrites/);
  });
});

describe('what Google answers', () => {
  it('a refusal comes back as rejected, with Google’s own code', async () => {
    const { client } = writer(fakeGoogleApi({ mutate: 'reject' }));
    expect(await client.createCampaign(searchSpec)).toEqual({
      status: 'rejected',
      code: 'MONEY_AMOUNT_TOO_SMALL',
      message:
        'mutate_operations[0].campaign_budget_operation.create.amount_micros: The budget amount is too small.',
    });
  });

  it.each(['server_error', 'network_failure', 'ok_without_id'] as const)(
    '%s is unknown, never a retry and never a guess',
    async (mutate) => {
      const { api, client } = writer(fakeGoogleApi({ mutate }));
      const outcome = await client.createCampaign(searchSpec);
      expect(outcome.status).toBe('unknown');
      expect(api.mutateCalls()).toHaveLength(1);
    },
  );
});

describe('resolving places', () => {
  it('asks Google for the states once and for each city once', async () => {
    const { api, client } = writer();
    await client.createCampaign(searchSpec);
    await client.createCampaign({ ...searchSpec, name: 'Pesquisa — segunda' });

    // One query for the 27 states, one for Curitiba; the second campaign reuses both.
    expect(api.searchCalls('geo_target_constant')).toHaveLength(2);
  });

  it('matches names whatever the accents, and keeps quotes out of the query', async () => {
    const api = fakeGoogleApi({
      geo: [
        ...BRAZIL_GEO,
        {
          id: '9',
          name: "Santa Bárbara d'Oeste",
          canonicalName: "Santa Barbara d'Oeste,State of Sao Paulo,Brazil",
          targetType: 'City',
        },
      ],
    });
    const client = new GoogleAdsPlatformClient(api.reader);

    const [state] = await client.resolveLocations({ states: ['PR'], cities: [] });
    expect(state?.resourceName).toBe('geoTargetConstants/20101');

    await client
      .resolveLocations({ states: [], cities: [{ name: "x' OR name LIKE '%", state: 'SP' }] })
      .catch(() => undefined);
    const query = String(api.searchCalls('geo_target_constant').at(-1)?.body.query);
    expect(query).toContain(String.raw`LIKE 'x\' OR name LIKE \''`);
  });
});

describe('reading the account', () => {
  const campaigns = [
    { id: '111', name: 'Search - Wings - Geral', status: 'ENABLED', amountMicros: '30000000' },
    { id: '222', name: 'SEARCH | Geral', status: 'PAUSED', amountMicros: '50000000' },
    { id: '333', name: 'Apagada', status: 'REMOVED', amountMicros: '10000000' },
  ] as const;

  it('mirrors campaigns with their budgets in cents, leaving removed ones out', async () => {
    const api = fakeGoogleApi({ campaigns: [...campaigns] });
    const client = new GoogleAdsPlatformClient(api.reader);

    expect(await client.listCampaigns()).toEqual([
      expect.objectContaining({ id: '111', status: 'ACTIVE', dailyBudgetCents: 3000 }),
      expect.objectContaining({ id: '222', status: 'PAUSED', dailyBudgetCents: 5000 }),
    ]);
    expect(await client.listAdSets()).toEqual([]);
  });

  it("reads each campaign's Final URL suffix and the account's (empty when unset)", async () => {
    const api = fakeGoogleApi({
      campaigns: [{ ...campaigns[0], finalUrlSuffix: 'utm_source=outro' }, { ...campaigns[1] }],
      accountFinalUrlSuffix: GOOGLE_ACCOUNT_URL_SUFFIX,
    });
    const list = await new GoogleAdsPlatformClient(api.reader).listCampaigns();
    expect(list.map((c) => [c.finalUrlSuffix, c.accountFinalUrlSuffix])).toEqual([
      ['utm_source=outro', GOOGLE_ACCOUNT_URL_SUFFIX],
      ['', GOOGLE_ACCOUNT_URL_SUFFIX],
    ]);
    const query = String(api.searchCalls('campaign\\s').at(0)?.body.query);
    expect(query).toContain('campaign.final_url_suffix');
    expect(query).toContain('customer.final_url_suffix');
  });

  it('counts a shared budget once, on a campaign that is spending', async () => {
    const shared = 'customers/4268586278/campaignBudgets/shared';
    const api = fakeGoogleApi({
      campaigns: [
        {
          id: '1',
          name: 'Pausada',
          status: 'PAUSED',
          amountMicros: '40000000',
          budgetResourceName: shared,
          explicitlyShared: true,
        },
        {
          id: '2',
          name: 'Ativa',
          status: 'ENABLED',
          amountMicros: '40000000',
          budgetResourceName: shared,
          explicitlyShared: true,
        },
      ],
    });
    const list = await new GoogleAdsPlatformClient(api.reader).listCampaigns();

    expect(list.find((campaign) => campaign.id === '2')?.dailyBudgetCents).toBe(4000);
    expect(list.find((campaign) => campaign.id === '1')?.dailyBudgetCents).toBe(0);
  });

  it('reports the prepaid balance as the account’s ceiling', async () => {
    const api = fakeGoogleApi({
      accountBudget: { limitMicros: '13100000000', servedMicros: '12630120000' },
    });
    const client = new GoogleAdsPlatformClient(api.reader);

    expect(await client.getAccount()).toMatchObject({
      id: '4268586278',
      spendCapCents: 1_310_000,
      amountSpentCents: 1_263_012,
      capReached: false,
    });
    expect(client.spendLimitSource).toBe('google.account_budget');
  });

  it('asks nothing when a campaign id is not a number', async () => {
    const api = fakeGoogleApi({ campaigns: [...campaigns] });
    const client = new GoogleAdsPlatformClient(api.reader);

    expect(await client.getCampaign('111 OR 1=1')).toBeNull();
    expect(api.calls).toHaveLength(0);
    expect((await client.getCampaign('111'))?.name).toBe('Search - Wings - Geral');
  });

  it('is a reader: asked to create, it refuses without calling Google', async () => {
    const api = fakeGoogleApi();
    const outcome = await new GoogleAdsPlatformClient(api.reader).createCampaign(searchSpec);
    expect(outcome).toMatchObject({ status: 'rejected', code: 'google_read_only' });
    expect(api.calls).toHaveLength(0);
  });

  it('is a reader that can still rehearse: validateOnly goes out, nothing is created', async () => {
    const api = fakeGoogleApi();
    const reader = new GoogleAdsPlatformClient(api.reader);
    const outcome = await reader.validateWrite({ kind: 'create_campaign', spec: searchSpec });
    expect(outcome).toMatchObject({ status: 'ok' });
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.operations).toContain('Grupo Franquia SP');
    expect(outcome.operations).toContain('Anúncio responsivo de pesquisa');

    const [call] = api.mutateCalls();
    expect(call?.body.validateOnly).toBe(true);
    expect(call?.body.partialFailure).toBe(false);
    expect(api.writeCalls()).toHaveLength(0);
    expect(api.campaigns).toHaveLength(0);
    expect(api.adGroups).toHaveLength(0);
  });
});

describe('changes to a campaign that exists', () => {
  const existing = () =>
    fakeGoogleApi({
      campaigns: [
        { id: '111', name: 'Search - Wings - Geral', status: 'PAUSED', amountMicros: '30000000' },
      ],
    });

  it('a new daily budget is one update of the campaign’s own budget, masked to the amount', async () => {
    const { api, client } = writer(existing());
    const outcome = await client.setDailyBudget('111', 5000);
    expect(outcome).toMatchObject({
      status: 'applied',
      campaign: { id: '111', dailyBudgetCents: 5000 },
    });
    expect(operationsOf(api)).toEqual([
      {
        campaignBudgetOperation: {
          update: {
            resourceName: 'customers/4268586278/campaignBudgets/b111',
            amountMicros: '50000000',
          },
          updateMask: 'amount_micros',
        },
      },
    ]);
  });

  it('a pause is one status update of the campaign', async () => {
    const api = fakeGoogleApi({
      campaigns: [{ id: '111', name: 'X', status: 'ENABLED', amountMicros: '30000000' }],
    });
    const { client } = writer(api);
    const outcome = await client.pauseCampaign('111');
    expect(outcome).toMatchObject({ status: 'applied', campaign: { status: 'PAUSED' } });
    expect(operationsOf(api)).toEqual([
      {
        campaignOperation: {
          update: { resourceName: 'customers/4268586278/campaigns/111', status: 'PAUSED' },
          updateMask: 'status',
        },
      },
    ]);
  });

  it('a resume switches on the campaign and what the system created under it, in one mutate', async () => {
    const { api, client } = writer(existing());
    const outcome = await client.resumeCampaign('111', { adGroupIds: ['900'], adIds: ['900~901'] });
    expect(outcome).toMatchObject({ status: 'applied', campaign: { status: 'ACTIVE' } });
    expect(operationsOf(api)).toEqual([
      {
        campaignOperation: {
          update: { resourceName: 'customers/4268586278/campaigns/111', status: 'ENABLED' },
          updateMask: 'status',
        },
      },
      {
        adGroupOperation: {
          update: { resourceName: 'customers/4268586278/adGroups/900', status: 'ENABLED' },
          updateMask: 'status',
        },
      },
      {
        adGroupAdOperation: {
          update: { resourceName: 'customers/4268586278/adGroupAds/900~901', status: 'ENABLED' },
          updateMask: 'status',
        },
      },
    ]);
  });

  it('a campaign Google does not have is a rejection with nothing sent', async () => {
    const { api, client } = writer(existing());
    expect(await client.setDailyBudget('222', 5000)).toMatchObject({
      status: 'rejected',
      code: 'campaign_not_found',
    });
    expect(api.mutateCalls()).toHaveLength(0);
  });

  it('validates a change with validateOnly and changes nothing', async () => {
    const { api, client } = writer(existing());
    const outcome = await client.validateWrite({
      kind: 'set_daily_budget',
      campaignId: '111',
      dailyBudgetCents: 5000,
    });
    expect(outcome).toMatchObject({ status: 'ok', operations: ['Orçamento diário'] });
    expect(api.mutateCalls()[0]?.body.validateOnly).toBe(true);
    expect(api.campaigns[0]?.amountMicros).toBe('30000000');
  });

  it('reads Google’s refusal with the field it points at', () => {
    expect(
      googleFailure(
        JSON.stringify({
          error: {
            message: 'Request contains an invalid argument.',
            details: [
              {
                errors: [
                  {
                    errorCode: { adError: 'LINE_TOO_WIDE' },
                    message: 'Line too wide.',
                    location: {
                      fieldPathElements: [
                        { fieldName: 'mutate_operations', index: 7 },
                        { fieldName: 'ad_group_ad_operation' },
                        { fieldName: 'create' },
                        { fieldName: 'ad' },
                        { fieldName: 'responsive_search_ad' },
                        { fieldName: 'headlines', index: 1 },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual({
      code: 'LINE_TOO_WIDE',
      message:
        'mutate_operations[7].ad_group_ad_operation.create.ad.responsive_search_ad.headlines[1]: Line too wide.',
    });
  });
});

describe('micros', () => {
  it('turns cents into micros exactly', () => {
    expect(microsFromCents(1)).toBe('10000');
    expect(microsFromCents(3000)).toBe('30000000');
  });
});
