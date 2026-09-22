import { GoogleAdsReadClient } from './google-client.js';

/**
 * A scripted Google Ads API for tests: the OAuth token endpoint, a
 * `googleAds:search` that answers by what the query reads FROM, and a
 * `googleAds:mutate` that really adds the campaign to the account's state —
 * so a create followed by a re-read behaves as it would live.
 *
 * Nothing here talks to Google. It exists because the first real Google write
 * happens with a person watching, and everything before that is rehearsal.
 */

export interface FakeGoogleCampaign {
  id: string;
  name: string;
  status: 'ENABLED' | 'PAUSED' | 'REMOVED';
  amountMicros: string;
  budgetResourceName?: string;
  explicitlyShared?: boolean;
}

export interface RecordedGoogleCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * One day of one campaign as the fake reports it. The optional dimensions
 * make the row answer the matching breakdown query as well; a row with no
 * dimension answers only the plain daily query.
 */
export interface FakeGoogleMetricsRow {
  campaignId: string;
  date: string;
  costMicros: string;
  impressions: number;
  clicks: number;
  conversions?: number;
  videoViews?: number;
  /** Quartile rates, 0..1 of views. */
  quartiles?: [number, number, number, number];
  hour?: number;
  adNetworkType?: string;
  /** A geo target constant resource name, resolved through `geo`. */
  geoTargetRegion?: string;
  ageRange?: string;
  gender?: string;
  /** MOBILE, DESKTOP, TABLET… */
  device?: string;
}

export interface FakeGoogleApiOptions {
  customerId?: string;
  campaigns?: FakeGoogleCampaign[];
  /** Approved account budget, in micros. Null means no account budget row. */
  accountBudget?: { limitMicros: string; servedMicros: string } | null;
  /** Rows answered for `FROM geo_target_constant`. */
  geo?: { id: string; name: string; canonicalName: string; targetType: 'State' | 'City' }[];
  /** Daily performance rows; none by default, as an account that never delivered. */
  metrics?: FakeGoogleMetricsRow[];
  /** How the next mutate behaves. */
  mutate?: 'ok' | 'ok_without_id' | 'reject' | 'server_error' | 'network_failure';
  /** Rows answered for `FROM conversion_action`; one enabled action by default. */
  conversionActions?: { id: string; name: string; status: string; type?: string }[];
  /**
   * Fields this "API version" does not know: a query naming one is refused
   * the way v22 refused `metrics.video_views` on the first real run.
   */
  unrecognizedFields?: string[];
}

export const BRAZIL_GEO = [
  {
    id: '20106',
    name: 'São Paulo',
    canonicalName: 'State of Sao Paulo,Brazil',
    targetType: 'State',
  },
  { id: '20101', name: 'Paraná', canonicalName: 'State of Parana,Brazil', targetType: 'State' },
  {
    id: '20098',
    name: 'Minas Gerais',
    canonicalName: 'State of Minas Gerais,Brazil',
    targetType: 'State',
  },
  {
    id: '1001773',
    name: 'Campinas',
    canonicalName: 'Campinas,State of Sao Paulo,Brazil',
    targetType: 'City',
  },
  {
    id: '1001634',
    name: 'Curitiba',
    canonicalName: 'Curitiba,State of Parana,Brazil',
    targetType: 'City',
  },
  // Two cities of the same name in one state: Google cannot tell which is meant.
  {
    id: '1',
    name: 'Bom Jesus',
    canonicalName: 'Bom Jesus,State of Minas Gerais,Brazil',
    targetType: 'City',
  },
  {
    id: '2',
    name: 'Bom Jesus',
    canonicalName: 'Bom Jesus,State of Minas Gerais,Brazil',
    targetType: 'City',
  },
] as const satisfies FakeGoogleApiOptions['geo'];

export function fakeGoogleApi(options: FakeGoogleApiOptions = {}) {
  const customerId = options.customerId ?? '4268586278';
  const campaigns: FakeGoogleCampaign[] = [...(options.campaigns ?? [])];
  const geo = options.geo ?? [...BRAZIL_GEO];
  const calls: RecordedGoogleCall[] = [];
  const state = { mutate: options.mutate ?? 'ok', accountBudget: options.accountBudget };
  let nextId = 900_000_001;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const campaignRow = (campaign: FakeGoogleCampaign) => ({
    campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
    campaignBudget: {
      resourceName:
        campaign.budgetResourceName ?? `customers/${customerId}/campaignBudgets/b${campaign.id}`,
      amountMicros: campaign.amountMicros,
      period: 'DAILY',
      explicitlyShared: campaign.explicitlyShared ?? false,
    },
  });

  const metricsRow = (row: FakeGoogleMetricsRow) => ({
    campaign: { id: row.campaignId },
    segments: {
      date: row.date,
      ...(row.hour === undefined ? {} : { hour: row.hour }),
      ...(row.adNetworkType === undefined ? {} : { adNetworkType: row.adNetworkType }),
      ...(row.geoTargetRegion === undefined ? {} : { geoTargetRegion: row.geoTargetRegion }),
      ...(row.device === undefined ? {} : { device: row.device }),
    },
    ...(row.ageRange === undefined && row.gender === undefined
      ? {}
      : {
          adGroupCriterion: {
            ...(row.ageRange === undefined ? {} : { ageRange: { type: row.ageRange } }),
            ...(row.gender === undefined ? {} : { gender: { type: row.gender } }),
          },
        }),
    metrics: {
      costMicros: row.costMicros,
      impressions: String(row.impressions),
      clicks: String(row.clicks),
      conversions: row.conversions ?? 0,
      ...(row.videoViews === undefined
        ? {}
        : {
            videoViews: String(row.videoViews),
            videoQuartileP25Rate: row.quartiles?.[0] ?? 0,
            videoQuartileP50Rate: row.quartiles?.[1] ?? 0,
            videoQuartileP75Rate: row.quartiles?.[2] ?? 0,
            videoQuartileP100Rate: row.quartiles?.[3] ?? 0,
          }),
    },
  });

  /** Rows inside the query's date range that carry exactly the asked dimension. */
  function metricsFor(query: string, dimension: keyof FakeGoogleMetricsRow | null): unknown[] {
    const range = /BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(query);
    return (options.metrics ?? [])
      .filter((row) => !range || (row.date >= range[1]! && row.date <= range[2]!))
      .filter((row) => {
        const dimensions = (
          ['hour', 'adNetworkType', 'geoTargetRegion', 'ageRange', 'gender', 'device'] as const
        ).filter((name) => row[name] !== undefined);
        return dimension === null ? dimensions.length === 0 : dimensions.join() === dimension;
      })
      .map(metricsRow);
  }

  function search(query: string): unknown[] {
    if (/FROM\s+geographic_view/i.test(query)) return metricsFor(query, 'geoTargetRegion');
    if (/FROM\s+age_range_view/i.test(query)) return metricsFor(query, 'ageRange');
    if (/FROM\s+gender_view/i.test(query)) return metricsFor(query, 'gender');
    if (/FROM\s+geo_target_constant/i.test(query) && /resource_name IN/.test(query)) {
      const wanted = [...query.matchAll(/'geoTargetConstants\/(\d+)'/g)].map((m) => m[1]);
      return geo
        .filter((row) => wanted.includes(row.id))
        .map((row) => ({
          geoTargetConstant: { resourceName: `geoTargetConstants/${row.id}`, name: row.name },
        }));
    }
    if (/FROM\s+conversion_action/i.test(query)) {
      const actions = options.conversionActions ?? [
        { id: '77', name: 'Lead - formulário', status: 'ENABLED', type: 'WEBPAGE' },
      ];
      return actions.map((action) => ({
        conversionAction: { ...action, type: action.type ?? 'WEBPAGE' },
      }));
    }
    if (/FROM\s+account_budget/i.test(query)) {
      const budget =
        state.accountBudget === undefined
          ? { limitMicros: '1000000000', servedMicros: '0' }
          : state.accountBudget;
      return budget
        ? [
            {
              accountBudget: {
                id: '1',
                status: 'APPROVED',
                adjustedSpendingLimitMicros: budget.limitMicros,
                amountServedMicros: budget.servedMicros,
              },
            },
          ]
        : [];
    }
    if (/FROM\s+geo_target_constant/i.test(query)) {
      const wantState = /target_type = 'State'/.test(query);
      const like = /name LIKE '([^']*)'/.exec(query)?.[1];
      return geo
        .filter((row) => (wantState ? row.targetType === 'State' : row.targetType === 'City'))
        .filter((row) =>
          like === undefined ? true : row.name.toLowerCase() === like.toLowerCase(),
        )
        .map((row) => ({ geoTargetConstant: { ...row, status: 'ENABLED' } }));
    }
    if (/FROM\s+campaign/i.test(query)) {
      // Metrics queries carry a date segment and answer from `metrics`.
      if (/segments\.date/.test(query)) {
        if (/segments\.hour/.test(query)) return metricsFor(query, 'hour');
        if (/segments\.ad_network_type/.test(query)) return metricsFor(query, 'adNetworkType');
        if (/segments\.device/.test(query)) return metricsFor(query, 'device');
        return metricsFor(query, null);
      }
      const byId = /campaign\.id = (\d+)/.exec(query)?.[1];
      return campaigns
        .filter((campaign) => campaign.status !== 'REMOVED')
        .filter((campaign) => (byId ? campaign.id === byId : true))
        .map(campaignRow);
    }
    return [];
  }

  function mutate(body: Record<string, unknown>): Response {
    if (state.mutate === 'server_error') return json(503, { error: { message: 'backend error' } });
    if (state.mutate === 'reject') {
      return json(400, {
        error: {
          message: 'Request contains an invalid argument.',
          details: [
            {
              errors: [
                {
                  errorCode: { campaignBudgetError: 'MONEY_AMOUNT_TOO_SMALL' },
                  message: 'The budget amount is too small.',
                },
              ],
            },
          ],
        },
      });
    }

    const operations = (body.mutateOperations ?? []) as Record<
      string,
      { create?: Record<string, unknown> }
    >[];
    const budget = operations.find((op) => op.campaignBudgetOperation)?.campaignBudgetOperation
      ?.create;
    const campaign = operations.find((op) => op.campaignOperation)?.campaignOperation?.create;
    const id = String(nextId++);
    campaigns.push({
      id,
      name: String(campaign?.name ?? ''),
      status: (campaign?.status as FakeGoogleCampaign['status']) ?? 'PAUSED',
      amountMicros: String(budget?.amountMicros ?? '0'),
    });

    return json(200, {
      mutateOperationResponses: operations.map((op) =>
        op.campaignBudgetOperation
          ? {
              campaignBudgetResult: {
                resourceName: `customers/${customerId}/campaignBudgets/b${id}`,
              },
            }
          : op.campaignOperation
            ? {
                campaignResult: {
                  resourceName:
                    state.mutate === 'ok_without_id'
                      ? ''
                      : `customers/${customerId}/campaigns/${id}`,
                },
              }
            : {
                campaignCriterionResult: {
                  resourceName: `customers/${customerId}/campaignCriteria/${id}~1`,
                },
              },
      ),
    });
  }

  const impl = ((url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (href.startsWith('https://oauth2.googleapis.com/token')) {
      return Promise.resolve(json(200, { access_token: 'access-token', expires_in: 3600 }));
    }

    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({
      url: href,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
      body,
    });

    if (href.endsWith('googleAds:search')) {
      const query = String(body.query ?? '');
      const unknown = (options.unrecognizedFields ?? []).find((field) => query.includes(field));
      if (unknown) {
        return Promise.resolve(
          json(400, {
            error: {
              message: 'Request contains an invalid argument.',
              details: [{ errors: [{ message: `Unrecognized field in the query: '${unknown}'` }] }],
            },
          }),
        );
      }
      // Like the real API, only the metrics the query named come back.
      const results = search(query).map((row) => {
        const metrics = (row as { metrics?: Record<string, unknown> }).metrics;
        if (!metrics || /metrics\.video_views/.test(query)) return row;
        const {
          videoViews,
          videoQuartileP25Rate,
          videoQuartileP50Rate,
          videoQuartileP75Rate,
          videoQuartileP100Rate,
          ...rest
        } = metrics;
        void [
          videoViews,
          videoQuartileP25Rate,
          videoQuartileP50Rate,
          videoQuartileP75Rate,
          videoQuartileP100Rate,
        ];
        return { ...(row as object), metrics: rest };
      });
      return Promise.resolve(json(200, { results }));
    }
    if (href.endsWith('googleAds:mutate')) {
      if (state.mutate === 'network_failure') return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(mutate(body));
    }
    return Promise.resolve(json(404, { error: { message: 'unexpected url' } }));
  }) as typeof fetch;

  const reader = new GoogleAdsReadClient({
    credentials: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      developerToken: 'developer-token',
      customerId,
    },
    fetchImpl: impl,
  });

  return {
    reader,
    calls,
    campaigns,
    state,
    mutateCalls: () => calls.filter((call) => call.url.endsWith('googleAds:mutate')),
    searchCalls: (from: string) =>
      calls.filter(
        (call) =>
          call.url.endsWith('googleAds:search') &&
          new RegExp(`FROM\\s+${from}`, 'i').test(String(call.body.query ?? '')),
      ),
  };
}
