import { describe, expect, it } from 'vitest';
import { BRAZIL_GEO, fakeGoogleApi } from './fake-google-api.js';
import {
  GoogleAdsPlatformClient,
  GoogleAdsWriteClient,
  PORTUGUESE_LANGUAGE_CONSTANT,
  googleLocationCriteria,
  microsFromCents,
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
  },
};

const youtubeSpec: CreateCampaignSpec = {
  ...searchSpec,
  name: 'YouTube — institucional',
  google: { ...searchSpec.google!, channel: 'DEMAND_GEN', bidding: 'MAXIMIZE_CLICKS' },
};

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
      maximizeConversions: {},
      networkSettings: {
        targetGoogleSearch: true,
        targetSearchNetwork: false,
        targetContentNetwork: false,
        targetPartnerSearchNetwork: false,
      },
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },
    });

    const criteria = operations.slice(2).map((op) => op.campaignCriterionOperation?.create);
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

  it('creates nothing below the campaign: no ad group, no ad, no keyword', async () => {
    const { api, client } = writer();
    await client.createCampaign(searchSpec);

    const kinds = new Set(operationsOf(api).flatMap((operation) => Object.keys(operation)));
    expect([...kinds].sort()).toEqual([
      'campaignBudgetOperation',
      'campaignCriterionOperation',
      'campaignOperation',
    ]);
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
      .slice(2)
      .map((op) => op.campaignCriterionOperation?.create);
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

  it('on YouTube the radius stays in the approved draft, like every other place', async () => {
    const { api, client } = writer();
    const outcome = await client.createCampaign({
      ...youtubeSpec,
      google: {
        ...youtubeSpec.google!,
        reach: { states: ['SP'], cities: [], customLocations: [campinas] },
      },
    });

    expect(outcome.status).toBe('applied');
    // Demand Gen takes places on the ad group, which is not created yet.
    expect(operationsOf(api)).toHaveLength(2);
    if (outcome.status !== 'applied') return;
    expect(outcome.detail).toMatchObject({ radii: [] });
  });
});

describe('creating a YouTube campaign', () => {
  it('is a Demand Gen shell: budget and campaign only, nothing about places', async () => {
    const { api, client } = writer();
    const outcome = await client.createCampaign(youtubeSpec);

    expect(outcome.status).toBe('applied');
    const operations = operationsOf(api);
    expect(operations).toHaveLength(2);
    const campaign = operations[1]?.campaignOperation?.create;
    expect(campaign).toMatchObject({
      advertisingChannelType: 'DEMAND_GEN',
      status: 'PAUSED',
      targetSpend: {},
    });
    // Demand Gen takes locations, language and channels on the ad group.
    expect(campaign).not.toHaveProperty('networkSettings');
    expect(campaign).not.toHaveProperty('advertisingChannelSubType');
    expect(api.searchCalls('geo_target_constant')).toHaveLength(0);
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

  it('anything about a campaign that already exists', async () => {
    const { api, client } = writer(
      fakeGoogleApi({
        campaigns: [
          {
            id: '111',
            name: 'Search - Wings - Geral',
            status: 'ENABLED',
            amountMicros: '30000000',
          },
        ],
      }),
    );

    for (const outcome of [
      await client.setDailyBudget(),
      await client.pauseCampaign(),
      await client.resumeCampaign(),
    ]) {
      expect(outcome).toMatchObject({ status: 'rejected', code: 'google_not_supported' });
    }
    expect((await client.setAccountSpendCap()).status).toBe('rejected');
    expect(api.calls).toHaveLength(0);
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
      message: 'The budget amount is too small.',
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
    expect(outcome).toMatchObject({ status: 'rejected', code: 'writes_disabled' });
    expect(api.calls).toHaveLength(0);
  });
});

describe('micros', () => {
  it('turns cents into micros exactly', () => {
    expect(microsFromCents(1)).toBe('10000');
    expect(microsFromCents(3000)).toBe('30000000');
  });
});
