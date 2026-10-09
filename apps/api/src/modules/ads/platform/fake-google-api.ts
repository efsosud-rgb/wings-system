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
  /** YYYY-MM-DD, as `campaign.start_date`/`end_date` come back on v22. */
  startDate?: string;
  endDate?: string;
  /** campaign.serving_status; SERVING for an enabled campaign when omitted. */
  servingStatus?: string;
  /** campaign.final_url_suffix; left out of the answer when unset, as Google does. */
  finalUrlSuffix?: string;
}

/** What a create left under a campaign, as the fake keeps it. */
export interface FakeGoogleAdGroup {
  id: string;
  campaignId: string;
  name: string;
  status: string;
  keywords: { text: string; matchType: string }[];
}

export interface FakeGoogleAd {
  /** `<adGroupId>~<adId>`, as Google names an ad group ad. */
  id: string;
  adGroupId: string;
  status: string;
  finalUrls: string[];
  headlines: string[];
  descriptions: string[];
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
  /** customer.final_url_suffix; left out of the answer when unset. */
  accountFinalUrlSuffix?: string;
  /** Approved account budget, in micros. Null means no account budget row. */
  accountBudget?: { limitMicros: string; servedMicros: string } | null;
  /** Rows answered for `FROM geo_target_constant`. */
  geo?: { id: string; name: string; canonicalName: string; targetType: 'State' | 'City' }[];
  /** Daily performance rows; none by default, as an account that never delivered. */
  metrics?: FakeGoogleMetricsRow[];
  /** How the next mutate behaves. */
  /** `reject_writes` accepts a validate-only request and refuses the write. */
  mutate?:
    | 'ok'
    | 'ok_without_id'
    | 'reject'
    | 'reject_writes'
    | 'server_error'
    | 'server_error_writes'
    | 'network_failure';
  /** Rows answered for `FROM conversion_action`; one enabled action by default. */
  conversionActions?: {
    id: string;
    name: string;
    status: string;
    type?: string;
    category?: string;
    primaryForGoal?: boolean;
  }[];
  /** Rows answered for `FROM custom_conversion_goal`; none by default. */
  customConversionGoals?: {
    resourceName: string;
    name?: string;
    conversionActions: string[];
    status: string;
  }[];
  /** Rows answered for `FROM user_list` and `FROM custom_audience`; none by default. */
  userLists?: { id: string; name: string }[];
  customAudiences?: { id: string; name: string }[];
  /** Ads already in the account (not made by a create here), with the campaign they sit under. */
  existingAds?: (FakeGoogleAd & { campaignId: string; approvalStatus?: string })[];
  /** One day of one ad, for the ad-level report. */
  adMetrics?: {
    adId: string;
    date: string;
    costMicros: string;
    impressions: number;
    clicks: number;
    conversions?: number;
  }[];
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

/**
 * The first temporary resource name (`…/-3`) an operation points at before
 * any earlier operation of the request created it; null when all resolve. A
 * goal config names its campaign's temporary id (`conversionGoalCampaignConfigs/-2`).
 */
function danglingTemporaryId(
  operations: Record<
    string,
    { create?: Record<string, unknown>; update?: Record<string, unknown> }
  >[],
): string | null {
  const created = new Set<string>();
  const references = (value: unknown, own: unknown): string[] => {
    if (typeof value === 'string') {
      return /\/-\d+$/.test(value) && value !== own ? [value] : [];
    }
    if (Array.isArray(value)) return value.flatMap((item) => references(item, own));
    if (value && typeof value === 'object') {
      return Object.values(value).flatMap((item) => references(item, own));
    }
    return [];
  };
  for (const operation of operations) {
    for (const body of Object.values(operation)) {
      const own = body.create?.resourceName;
      const wanted = [
        ...references(body.create ?? {}, own),
        ...references(body.update ?? {}, undefined).map((name) =>
          name.replace(/conversionGoalCampaignConfigs\/(-\d+)$/, 'campaigns/$1'),
        ),
      ];
      const missing = wanted.find((name) => !created.has(name));
      if (missing) return missing;
      if (typeof own === 'string') created.add(own);
    }
  }
  return null;
}

export function fakeGoogleApi(options: FakeGoogleApiOptions = {}) {
  const customerId = options.customerId ?? '4268586278';
  const campaigns: FakeGoogleCampaign[] = [...(options.campaigns ?? [])];
  const adGroups: FakeGoogleAdGroup[] = [];
  const ads: (FakeGoogleAd & { campaignId?: string; approvalStatus?: string })[] = [
    ...(options.existingAds ?? []),
  ];
  const negatives: { campaignId: string; text: string; matchType: string }[] = [];
  /** What a Demand Gen create left besides its ad group and ad. */
  const assets: { id: string; name: string; youtubeVideoId?: string; imageBytes?: number }[] = [];
  const audiences: { id: string; name: string; dimensions: unknown[] }[] = [];
  const goalConfigs: { campaignId: string; customConversionGoal: string }[] = [];
  const customGoals = [...(options.customConversionGoals ?? [])];
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
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      servingStatus: campaign.servingStatus ?? (campaign.status === 'ENABLED' ? 'SERVING' : 'NONE'),
      ...(campaign.startDate ? { startDate: campaign.startDate } : {}),
      ...(campaign.endDate ? { endDate: campaign.endDate } : {}),
      ...(campaign.finalUrlSuffix ? { finalUrlSuffix: campaign.finalUrlSuffix } : {}),
    },
    customer: options.accountFinalUrlSuffix
      ? { finalUrlSuffix: options.accountFinalUrlSuffix }
      : {},
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
    if (/FROM\s+custom_conversion_goal/i.test(query)) {
      return customGoals.map((goal) => ({ customConversionGoal: goal }));
    }
    if (/FROM\s+user_list/i.test(query)) {
      return (options.userLists ?? []).map((list) => ({ userList: list }));
    }
    if (/FROM\s+custom_audience/i.test(query)) {
      return (options.customAudiences ?? []).map((audience) => ({ customAudience: audience }));
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
    if (/FROM\s+ad_group_ad/i.test(query) && /responsive_search_ad/.test(query)) {
      return ads
        .filter((ad) => ad.status !== 'REMOVED')
        .map((ad) => ({
          adGroupAd: {
            status: ad.status,
            policySummary: { approvalStatus: ad.approvalStatus ?? 'APPROVED' },
            ad: {
              id: ad.id.split('~')[1],
              type: 'RESPONSIVE_SEARCH_AD',
              responsiveSearchAd: {
                headlines: ad.headlines.map((text) => ({ text })),
                descriptions: ad.descriptions.map((text) => ({ text })),
              },
            },
          },
          adGroup: { id: ad.adGroupId },
          campaign: {
            id: ad.campaignId ?? adGroups.find((group) => group.id === ad.adGroupId)?.campaignId,
          },
        }));
    }
    if (/FROM\s+ad_group_ad/i.test(query) && /segments\.date/.test(query)) {
      const range = /BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/.exec(query);
      return (options.adMetrics ?? [])
        .filter((row) => !range || (row.date >= range[1]! && row.date <= range[2]!))
        .map((row) => ({
          adGroupAd: { ad: { id: row.adId } },
          segments: { date: row.date },
          metrics: {
            costMicros: row.costMicros,
            impressions: String(row.impressions),
            clicks: String(row.clicks),
            conversions: row.conversions ?? 0,
          },
        }));
    }
    if (/FROM\s+ad_group_ad/i.test(query)) {
      const wanted = [...query.matchAll(/(\d+)/g)].map((m) => m[1]);
      return ads
        .filter((ad) => wanted.includes(ad.id.split('~')[1] ?? ''))
        .map((ad) => ({ adGroupAd: { status: ad.status, ad: { id: ad.id.split('~')[1] } } }));
    }
    if (/FROM\s+ad_group\b/i.test(query)) {
      const wanted = [...query.matchAll(/(\d+)/g)].map((m) => m[1]);
      return adGroups
        .filter((group) => wanted.includes(group.id))
        .map((group) => ({ adGroup: { id: group.id, status: group.status } }));
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

  type Operation = Record<
    string,
    { create?: Record<string, unknown>; update?: Record<string, unknown>; updateMask?: string }
  >;

  /**
   * Like Google: the whole request is checked and, unless `validateOnly`,
   * applied atomically. Temporary ids (`-1`, `-2`, `-3`) resolve inside the
   * request. A `validateOnly` request changes nothing and answers 200 with
   * no results — exactly the shape the real API gives.
   */
  function mutate(body: Record<string, unknown>): Response {
    if (
      state.mutate === 'server_error' ||
      (state.mutate === 'server_error_writes' && body.validateOnly !== true)
    ) {
      return json(503, { error: { message: 'backend error' } });
    }
    if (
      state.mutate === 'reject' ||
      (state.mutate === 'reject_writes' && body.validateOnly !== true)
    ) {
      return json(400, {
        error: {
          message: 'Request contains an invalid argument.',
          details: [
            {
              errors: [
                {
                  errorCode: { campaignBudgetError: 'MONEY_AMOUNT_TOO_SMALL' },
                  message: 'The budget amount is too small.',
                  location: {
                    fieldPathElements: [
                      { fieldName: 'mutate_operations', index: 0 },
                      { fieldName: 'campaign_budget_operation' },
                      { fieldName: 'create' },
                      { fieldName: 'amount_micros' },
                    ],
                  },
                },
              ],
            },
          ],
        },
      });
    }

    const operations = (body.mutateOperations ?? []) as Operation[];
    // Like Google, a temporary id must be created earlier in the same request
    // than anything that points at it — checked on a rehearsal as on a write.
    const unresolved = danglingTemporaryId(operations);
    if (unresolved) {
      return json(400, {
        error: {
          message: 'Request contains an invalid argument.',
          details: [
            {
              errors: [
                {
                  errorCode: { mutateError: 'RESOURCE_NOT_FOUND' },
                  message: `Temporary resource ${unresolved} is not created before it is used.`,
                },
              ],
            },
          ],
        },
      });
    }
    if (body.validateOnly === true) return json(200, { mutateOperationResponses: [] });

    const tempIds = new Map<string, string>();
    const resolve = (name: unknown): string => {
      const value = String(name ?? '');
      return tempIds.get(value) ?? value;
    };
    const lastSegment = (name: string) => name.slice(name.lastIndexOf('/') + 1);
    const responses: Record<string, { resourceName: string }>[] = [];

    for (const op of operations) {
      if (op.campaignBudgetOperation) {
        const { create, update } = op.campaignBudgetOperation;
        if (create) {
          const id = `b${nextId}`;
          const resourceName = `customers/${customerId}/campaignBudgets/${id}`;
          tempIds.set(String(create.resourceName), resourceName);
          responses.push({ campaignBudgetResult: { resourceName } });
        } else if (update) {
          const target = campaigns.find(
            (campaign) =>
              (campaign.budgetResourceName ??
                `customers/${customerId}/campaignBudgets/b${campaign.id}`) === update.resourceName,
          );
          if (target) target.amountMicros = String(update.amountMicros);
          responses.push({ campaignBudgetResult: { resourceName: String(update.resourceName) } });
        }
      } else if (op.campaignOperation) {
        const { create, update } = op.campaignOperation;
        if (create) {
          const id = String(nextId++);
          const resourceName = `customers/${customerId}/campaigns/${id}`;
          tempIds.set(String(create.resourceName), resourceName);
          const budgetName = resolve(create.campaignBudget);
          const budget = operations.find(
            (item) => item.campaignBudgetOperation?.create?.resourceName === create.campaignBudget,
          )?.campaignBudgetOperation?.create;
          campaigns.push({
            id,
            name: String(create.name ?? ''),
            status: (create.status as FakeGoogleCampaign['status']) ?? 'PAUSED',
            amountMicros: String(budget?.amountMicros ?? '0'),
            budgetResourceName: budgetName,
          });
          responses.push({
            campaignResult: { resourceName: state.mutate === 'ok_without_id' ? '' : resourceName },
          });
        } else if (update) {
          const target = campaigns.find(
            (campaign) => campaign.id === lastSegment(String(update.resourceName)),
          );
          if (target && update.status)
            target.status = update.status as FakeGoogleCampaign['status'];
          responses.push({ campaignResult: { resourceName: String(update.resourceName) } });
        }
      } else if (op.campaignCriterionOperation) {
        const create = op.campaignCriterionOperation.create ?? {};
        const campaignId = lastSegment(resolve(create.campaign));
        const keyword = create.keyword as { text: string; matchType: string } | undefined;
        if (create.negative === true && keyword) {
          negatives.push({ campaignId, text: keyword.text, matchType: keyword.matchType });
        }
        responses.push({
          campaignCriterionResult: {
            resourceName: `customers/${customerId}/campaignCriteria/${campaignId}~${nextId++}`,
          },
        });
      } else if (op.adGroupOperation) {
        const { create, update } = op.adGroupOperation;
        if (create) {
          const id = String(nextId++);
          const resourceName = `customers/${customerId}/adGroups/${id}`;
          tempIds.set(String(create.resourceName), resourceName);
          adGroups.push({
            id,
            campaignId: lastSegment(resolve(create.campaign)),
            name: String(create.name ?? ''),
            status: String(create.status ?? 'ENABLED'),
            keywords: [],
          });
          responses.push({ adGroupResult: { resourceName } });
        } else if (update) {
          const target = adGroups.find(
            (group) => group.id === lastSegment(String(update.resourceName)),
          );
          if (target && update.status) target.status = String(update.status);
          responses.push({ adGroupResult: { resourceName: String(update.resourceName) } });
        }
      } else if (op.adGroupCriterionOperation) {
        const create = op.adGroupCriterionOperation.create ?? {};
        const groupId = lastSegment(resolve(create.adGroup));
        const keyword = create.keyword as { text: string; matchType: string } | undefined;
        const group = adGroups.find((item) => item.id === groupId);
        if (group && keyword) group.keywords.push(keyword);
        responses.push({
          adGroupCriterionResult: {
            resourceName: `customers/${customerId}/adGroupCriteria/${groupId}~${nextId++}`,
          },
        });
      } else if (op.assetOperation) {
        const create = op.assetOperation.create ?? {};
        const id = String(nextId++);
        const resourceName = `customers/${customerId}/assets/${id}`;
        tempIds.set(String(create.resourceName), resourceName);
        const video = create.youtubeVideoAsset as { youtubeVideoId?: string } | undefined;
        const image = create.imageAsset as { data?: string } | undefined;
        assets.push({
          id,
          name: String(create.name ?? ''),
          ...(video?.youtubeVideoId ? { youtubeVideoId: video.youtubeVideoId } : {}),
          ...(image?.data ? { imageBytes: Buffer.from(image.data, 'base64').length } : {}),
        });
        responses.push({ assetResult: { resourceName } });
      } else if (op.audienceOperation) {
        const create = op.audienceOperation.create ?? {};
        const id = String(nextId++);
        const resourceName = `customers/${customerId}/audiences/${id}`;
        tempIds.set(String(create.resourceName), resourceName);
        audiences.push({
          id,
          name: String(create.name ?? ''),
          dimensions: (create.dimensions as unknown[]) ?? [],
        });
        responses.push({ audienceResult: { resourceName } });
      } else if (op.customConversionGoalOperation) {
        const create = op.customConversionGoalOperation.create ?? {};
        const resourceName = `customers/${customerId}/customConversionGoals/${nextId++}`;
        tempIds.set(String(create.resourceName), resourceName);
        customGoals.push({
          resourceName,
          conversionActions: (create.conversionActions as string[]) ?? [],
          status: String(create.status ?? 'ENABLED'),
        });
        responses.push({ customConversionGoalResult: { resourceName } });
      } else if (op.conversionGoalCampaignConfigOperation) {
        const update = op.conversionGoalCampaignConfigOperation.update ?? {};
        const campaignTemp = String(update.resourceName ?? '').replace(
          /conversionGoalCampaignConfigs\/(-?\d+)$/,
          'campaigns/$1',
        );
        const campaignId = lastSegment(resolve(campaignTemp));
        goalConfigs.push({
          campaignId,
          customConversionGoal: resolve(update.customConversionGoal),
        });
        responses.push({
          conversionGoalCampaignConfigResult: {
            resourceName: `customers/${customerId}/conversionGoalCampaignConfigs/${campaignId}`,
          },
        });
      } else if (op.adGroupAdOperation) {
        const { create, update } = op.adGroupAdOperation;
        if (create) {
          const groupId = lastSegment(resolve(create.adGroup));
          const id = `${groupId}~${nextId++}`;
          const ad = (create.ad ?? {}) as {
            finalUrls?: string[];
            responsiveSearchAd?: {
              headlines?: { text: string }[];
              descriptions?: { text: string }[];
            };
            demandGenVideoResponsiveAd?: {
              headlines?: { text: string }[];
              descriptions?: { text: string }[];
            };
          };
          const copy = ad.responsiveSearchAd ?? ad.demandGenVideoResponsiveAd;
          ads.push({
            id,
            adGroupId: groupId,
            status: String(create.status ?? 'ENABLED'),
            finalUrls: ad.finalUrls ?? [],
            headlines: (copy?.headlines ?? []).map((item) => item.text),
            descriptions: (copy?.descriptions ?? []).map((item) => item.text),
          });
          responses.push({
            adGroupAdResult: { resourceName: `customers/${customerId}/adGroupAds/${id}` },
          });
        } else if (update) {
          const target = ads.find((ad) => ad.id === lastSegment(String(update.resourceName)));
          if (target && update.status) target.status = String(update.status);
          responses.push({ adGroupAdResult: { resourceName: String(update.resourceName) } });
        }
      } else {
        responses.push({});
      }
    }

    return json(200, { mutateOperationResponses: responses });
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
    /** The scripted transport itself, for an app built with `platformFetch`. */
    fetch: impl,
    calls,
    campaigns,
    adGroups,
    ads,
    negatives,
    assets,
    audiences,
    goalConfigs,
    customGoals,
    state,
    mutateCalls: () => calls.filter((call) => call.url.endsWith('googleAds:mutate')),
    /** Only the mutates that could change something: validate-only ones are left out. */
    writeCalls: () =>
      calls.filter(
        (call) => call.url.endsWith('googleAds:mutate') && call.body.validateOnly !== true,
      ),
    searchCalls: (from: string) =>
      calls.filter(
        (call) =>
          call.url.endsWith('googleAds:search') &&
          new RegExp(`FROM\\s+${from}`, 'i').test(String(call.body.query ?? '')),
      ),
  };
}
