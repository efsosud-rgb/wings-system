import { describe, expect, it } from 'vitest';
import { centsFromMicros, createGoogleClient, GoogleAdsReadClient } from './google-client.js';

/**
 * The header test here is the point of this file.
 *
 * Sending `login-customer-id` looks obviously right — the env var exists, the
 * MCC owns the developer token, and every Google example shows it. It is
 * nonetheless wrong for this account and breaks every call with a 403. That is
 * exactly the kind of "fix" someone applies confidently in six months, so it is
 * pinned by a test rather than by a comment alone.
 */

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: RecordedCall[] = [];
  const impl = ((url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return { impl, calls };
}

const CREDENTIALS = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token',
  developerToken: 'developer-token',
  customerId: '4268586278',
};

const TOKEN_RESPONSE = { status: 200, body: { access_token: 'access-token', expires_in: 3600 } };

function accountBudget(overrides: Record<string, string> = {}) {
  return {
    status: 200,
    body: {
      results: [
        {
          accountBudget: {
            id: '8108783231',
            status: 'APPROVED',
            approvedSpendingLimitMicros: '13100000000',
            adjustedSpendingLimitMicros: '13239570000',
            amountServedMicros: '12718810000',
            totalAdjustmentsMicros: '139570000',
            ...overrides,
          },
        },
      ],
    },
  };
}

describe('the login-customer-id header', () => {
  it('is NEVER sent — with it, Google refuses this account', async () => {
    const { impl, calls } = fakeFetch([TOKEN_RESPONSE, accountBudget()]);
    const client = new GoogleAdsReadClient({ credentials: CREDENTIALS, fetchImpl: impl });

    await client.getSpendLimit();

    const searchCall = calls.find((call) => call.url.includes('googleAds:search'));
    expect(searchCall).toBeTruthy();
    expect(Object.keys(searchCall?.headers ?? {})).not.toContain('login-customer-id');
    // The authorising user reaches the ad account directly, so the request goes
    // straight at it. Routing through the MCC is what produced the 403.
    expect(searchCall?.url).toContain('/customers/4268586278/googleAds:search');
  });

  it('carries only what Google actually requires', async () => {
    const { impl, calls } = fakeFetch([TOKEN_RESPONSE, accountBudget()]);
    const client = new GoogleAdsReadClient({ credentials: CREDENTIALS, fetchImpl: impl });

    const headers = await client.requestHeaders();

    expect(headers.authorization).toBe('Bearer access-token');
    expect(headers['developer-token']).toBe('developer-token');
    expect(Object.keys(headers).sort()).toEqual([
      'authorization',
      'content-type',
      'developer-token',
    ]);
    expect(calls).toHaveLength(1); // only the token refresh so far
  });

  it('is not accepted through the factory either, even when configured', () => {
    // The env var exists as documentation of who owns the developer token. It
    // must not reach the client.
    const client = createGoogleClient({
      GOOGLE_ADS_CLIENT_ID: 'a',
      GOOGLE_ADS_CLIENT_SECRET: 'b',
      GOOGLE_ADS_REFRESH_TOKEN: 'c',
      GOOGLE_ADS_DEVELOPER_TOKEN: 'd',
      GOOGLE_ADS_CUSTOMER_ID: '426-858-6278',
      // @ts-expect-error — deliberately passing it to prove it is ignored.
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: '6693183441',
    });

    expect(client).toBeTruthy();
    expect(JSON.stringify(client)).not.toContain('6693183441');
  });
});

describe('the request itself', () => {
  it('omits pageSize, which v22 rejects outright', async () => {
    const { impl, calls } = fakeFetch([TOKEN_RESPONSE, accountBudget()]);
    const client = new GoogleAdsReadClient({ credentials: CREDENTIALS, fetchImpl: impl });

    await client.getSpendLimit();

    const searchCall = calls.find((call) => call.url.includes('googleAds:search'));
    expect(searchCall?.body).not.toContain('pageSize');
  });

  it('strips dashes from a customer id written the human way', () => {
    const client = createGoogleClient({
      GOOGLE_ADS_CLIENT_ID: 'a',
      GOOGLE_ADS_CLIENT_SECRET: 'b',
      GOOGLE_ADS_REFRESH_TOKEN: 'c',
      GOOGLE_ADS_DEVELOPER_TOKEN: 'd',
      GOOGLE_ADS_CUSTOMER_ID: '426-858-6278',
    });
    expect(JSON.stringify(client)).toContain('4268586278');
  });

  it('returns null when credentials are incomplete, rather than half a client', () => {
    expect(createGoogleClient({ GOOGLE_ADS_CLIENT_ID: 'only-one' })).toBeNull();
  });
});

describe('reading the spending ceiling', () => {
  it('reports the prepaid balance as limit minus what was served', async () => {
    const { impl } = fakeFetch([TOKEN_RESPONSE, accountBudget()]);
    const client = new GoogleAdsReadClient({ credentials: CREDENTIALS, fetchImpl: impl });

    const limit = await client.getSpendLimit();

    // R$13.239,57 adjusted − R$12.718,81 served = R$520,76 — the live figure
    // after the R$500 top-up.
    expect(limit.limitCents).toBe(1_323_957);
    expect(limit.spentCents).toBe(1_271_881);
    expect(limit.remainingCents).toBe(52_076);
    expect(limit.source).toBe('google.account_budget');
  });

  it('never reports a negative balance', async () => {
    const { impl } = fakeFetch([
      TOKEN_RESPONSE,
      accountBudget({ amountServedMicros: '99000000000' }),
    ]);
    const client = new GoogleAdsReadClient({ credentials: CREDENTIALS, fetchImpl: impl });

    expect((await client.getSpendLimit()).remainingCents).toBe(0);
  });

  it('treats a missing account budget as "no limit", not as zero', async () => {
    const { impl } = fakeFetch([TOKEN_RESPONSE, { status: 200, body: { results: [] } }]);
    const client = new GoogleAdsReadClient({ credentials: CREDENTIALS, fetchImpl: impl });

    const limit = await client.getSpendLimit();
    // Zero would freeze a working account over a missing row.
    expect(limit.remainingCents).toBeNull();
    expect(limit.source).toContain('absent');
  });

  it('surfaces Google’s own error text instead of a bare status', async () => {
    const { impl } = fakeFetch([
      TOKEN_RESPONSE,
      {
        status: 403,
        body: {
          error: {
            details: [
              { errors: [{ message: 'User doesn’t have permission to access customer.' }] },
            ],
          },
        },
      },
    ]);
    const client = new GoogleAdsReadClient({ credentials: CREDENTIALS, fetchImpl: impl });

    await expect(client.getSpendLimit()).rejects.toThrow(/permission to access customer/);
  });

  it('reuses the access token instead of refreshing on every call', async () => {
    const { impl, calls } = fakeFetch([TOKEN_RESPONSE, accountBudget(), accountBudget()]);
    const client = new GoogleAdsReadClient({ credentials: CREDENTIALS, fetchImpl: impl });

    await client.getSpendLimit();
    await client.getSpendLimit();

    expect(calls.filter((call) => call.url.includes('oauth2'))).toHaveLength(1);
  });
});

describe('micros', () => {
  it('converts to cents, the only money unit the database stores', () => {
    expect(centsFromMicros('13239570000')).toBe(1_323_957); // R$ 13.239,57
    expect(centsFromMicros('30000000')).toBe(3000); // R$ 30,00
    expect(centsFromMicros(undefined)).toBe(0);
  });

  it('rounds a value that is not a whole number of cents', () => {
    // 1.333.333 micros = 133,3333 centavos.
    expect(centsFromMicros('1333333')).toBe(133);
  });

  it('refuses nonsense rather than silently producing NaN', () => {
    expect(() => centsFromMicros('not-a-number')).toThrow(/non-numeric/);
  });
});
