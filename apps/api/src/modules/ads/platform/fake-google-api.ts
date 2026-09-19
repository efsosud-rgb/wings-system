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

export interface FakeGoogleApiOptions {
  customerId?: string;
  campaigns?: FakeGoogleCampaign[];
  /** Approved account budget, in micros. Null means no account budget row. */
  accountBudget?: { limitMicros: string; servedMicros: string } | null;
  /** Rows answered for `FROM geo_target_constant`. */
  geo?: { id: string; name: string; canonicalName: string; targetType: 'State' | 'City' }[];
  /** How the next mutate behaves. */
  mutate?: 'ok' | 'ok_without_id' | 'reject' | 'server_error' | 'network_failure';
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

  function search(query: string): unknown[] {
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
      // Metrics queries carry a date segment; nothing has spent in this fake.
      if (/segments\.date/.test(query)) return [];
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
      return Promise.resolve(json(200, { results: search(String(body.query ?? '')) }));
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
