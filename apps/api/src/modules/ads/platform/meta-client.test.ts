import { describe, expect, it } from 'vitest';
import {
  AD_ACCOUNT_RESPONSE,
  CAMPAIGNS_RESPONSE,
  ERROR_INVALID_TOKEN,
  ERROR_RATE_LIMIT,
  INSIGHTS_RESPONSE,
} from './fixtures.js';
import {
  MetaApiError,
  MetaReadOnlyClient,
  MetaWritesDisabledError,
  sliceDateRange,
} from './meta-client.js';
import {
  centsFromDecimalCurrencyString,
  centsFromMinorUnitString,
  spendCapFromString,
} from './meta-parse.js';

/**
 * The live client is exercised against recorded fixtures through an injected
 * fetch. No test can reach the network — the suite blocks it globally — so this
 * is the only way the parsing of real Meta payloads is ever verified.
 */

function stubFetch(handler: (url: string) => { status?: number; body: unknown }): typeof fetch {
  return ((input: unknown) => {
    const url = String(input);
    const { status = 200, body } = handler(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

function client(handler: (url: string) => { status?: number; body: unknown }) {
  return new MetaReadOnlyClient({
    accessToken: 'test-token-not-real',
    adAccountId: 'act_123456789',
    fetchImpl: stubFetch(handler),
  });
}

describe('money parsing — the 100x trap', () => {
  it('reads budgets and spend_cap as integer cents', () => {
    expect(centsFromMinorUnitString('5000', 'daily_budget')).toBe(5000); // R$50,00
    expect(spendCapFromString('1000000')).toBe(1_000_000); // R$10.000,00
  });

  it('reads Insights spend as decimal reais, a different unit entirely', () => {
    expect(centsFromDecimalCurrencyString('48.71', 'spend')).toBe(4871);
    expect(centsFromDecimalCurrencyString('61.02', 'spend')).toBe(6102);
    // Breakdowns write more decimals than a cent has; they are rounded, not refused.
    expect(centsFromDecimalCurrencyString('1.67832', 'spend')).toBe(168);
    expect(centsFromDecimalCurrencyString('0.005', 'spend')).toBe(1);
    expect(centsFromDecimalCurrencyString('12.999', 'spend')).toBe(1300);
    expect(centsFromDecimalCurrencyString('7', 'spend')).toBe(700);
    expect(centsFromDecimalCurrencyString('1.5', 'spend')).toBe(150);
    expect(centsFromDecimalCurrencyString('7', 'spend')).toBe(700);
    expect(centsFromDecimalCurrencyString('7.5', 'spend')).toBe(750);
  });

  it('refuses malformed values instead of guessing', () => {
    expect(() => centsFromMinorUnitString('48.71', 'daily_budget')).toThrow(
      /integer string in cents/,
    );
    expect(() => centsFromMinorUnitString(null, 'daily_budget')).toThrow();
    expect(() => centsFromDecimalCurrencyString('5000', 'spend')).not.toThrow(); // "5000" reais is valid
    expect(() => centsFromDecimalCurrencyString('abc', 'spend')).toThrow(/decimal currency string/);
    expect(() => centsFromDecimalCurrencyString(48.71, 'spend')).toThrow();
  });

  it('treats a spend_cap of zero as no cap at all', () => {
    expect(spendCapFromString('0')).toBeNull();
  });
});

describe('reading the account', () => {
  it('parses the recorded ad account payload', async () => {
    const meta = client(() => ({ body: AD_ACCOUNT_RESPONSE }));
    const account = await meta.getAccount();

    expect(account.currency).toBe('BRL');
    expect(account.spendCapCents).toBe(1_000_000); // R$10.000,00
    expect(account.amountSpentCents).toBe(123_456); // R$1.234,56
    expect(account.capReached).toBe(false);
  });

  it('flags a reached cap', async () => {
    const meta = client(() => ({
      body: { ...AD_ACCOUNT_RESPONSE, amount_spent: '1000000' },
    }));
    expect((await meta.getAccount()).capReached).toBe(true);
  });

  it('parses campaigns and their budgets', async () => {
    const meta = client(() => ({ body: CAMPAIGNS_RESPONSE }));
    const campaigns = await meta.listCampaigns();

    expect(campaigns).toHaveLength(2);
    expect(campaigns[0]).toMatchObject({ status: 'ACTIVE', dailyBudgetCents: 5000 });
    expect(campaigns[1]).toMatchObject({ status: 'PAUSED', dailyBudgetCents: 3000 });
  });

  it("reads each campaign's schedule as São Paulo days, falling back to when it was created", async () => {
    const meta = client(() => ({
      body: {
        data: [
          {
            id: '1',
            name: '28Set',
            status: 'ACTIVE',
            daily_budget: '24000',
            start_time: '2026-09-28T09:59:32-0300',
            stop_time: '2026-10-02T23:59:59-0300',
          },
          // 01:30 UTC on the 29th is still the 28th in São Paulo.
          { id: '2', name: 'Sem fim', status: 'ACTIVE', created_time: '2026-09-29T01:30:00+0000' },
        ],
      },
    }));
    const [dated, open] = await meta.listCampaigns();
    expect(dated).toMatchObject({ startDate: '2026-09-28', endDate: '2026-10-02' });
    expect(open).toMatchObject({ startDate: '2026-09-28', endDate: null });
  });

  it('parses daily spend from Insights', async () => {
    const meta = client(() => ({ body: INSIGHTS_RESPONSE }));
    const rows = await meta.getSpend('2026-09-01');

    expect(rows).toEqual([
      { campaignId: '23851234567890123', date: '2026-09-15', spendCents: 4871 },
      { campaignId: '23851234567890123', date: '2026-09-16', spendCents: 6102 },
    ]);
  });
});

describe('errors are classified, not swallowed', () => {
  it('recognises an invalidated token as a credential failure', async () => {
    const meta = client(() => ({ status: 401, body: ERROR_INVALID_TOKEN }));
    const error = await meta.getAccount().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MetaApiError);
    if (error instanceof MetaApiError) {
      expect(error.isCredentialFailure).toBe(true);
      expect(error.isRateLimit).toBe(false);
    }
  });

  it('recognises a rate limit', async () => {
    const meta = client(() => ({ status: 400, body: ERROR_RATE_LIMIT }));
    const error = await meta.getAccount().catch((e: unknown) => e);
    if (error instanceof MetaApiError) expect(error.isRateLimit).toBe(true);
  });
});

describe('the live client cannot spend money', () => {
  const meta = client(() => ({ body: AD_ACCOUNT_RESPONSE }));

  it('refuses every mutating operation', () => {
    expect(() => meta.setDailyBudget('c1', 5000)).toThrow(MetaWritesDisabledError);
    expect(() => meta.pauseCampaign('c1')).toThrow(MetaWritesDisabledError);
    expect(() => meta.resumeCampaign('c1')).toThrow(MetaWritesDisabledError);
    expect(() => meta.setAccountSpendCap(100_000)).toThrow(MetaWritesDisabledError);
  });

  it('declares itself live, so callers treat it as consequential', () => {
    expect(meta.isLive).toBe(true);
  });
});

describe('client configuration', () => {
  it('rejects a malformed account id before any call', () => {
    expect(() => new MetaReadOnlyClient({ accessToken: 't', adAccountId: '123456789' })).toThrow(
      /expected act_/,
    );
  });

  it('requires a token', () => {
    expect(() => new MetaReadOnlyClient({ accessToken: '', adAccountId: 'act_1' })).toThrow(
      /token is required/,
    );
  });

  it('never puts the token in the URL', async () => {
    const seen: string[] = [];
    const meta = new MetaReadOnlyClient({
      accessToken: 'super-secret-token',
      adAccountId: 'act_123456789',
      fetchImpl: ((input: unknown) => {
        seen.push(String(input));
        return Promise.resolve(
          new Response(JSON.stringify(AD_ACCOUNT_RESPONSE), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof fetch,
    });

    await meta.getAccount();
    expect(seen[0]).not.toContain('super-secret-token');
  });
});

describe('cursor paging', () => {
  /**
   * The live account has 84 campaigns, 202 ad sets and 660 ads. Asking for all
   * of it at once makes Meta answer "Please reduce the amount of data you're
   * asking for" rather than truncating, so paging is what makes the call work
   * at all.
   */
  it('follows paging.next across pages and concatenates them', async () => {
    const pages = [
      {
        data: [{ id: '1', name: 'A', status: 'ACTIVE' }],
        paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'cursor-1' } },
      },
      {
        data: [{ id: '2', name: 'B', status: 'PAUSED' }],
        // No `next`: this is the last page, even though a cursor is present.
        paging: { cursors: { after: 'cursor-2' } },
      },
    ];
    const seen: string[] = [];
    const meta = new MetaReadOnlyClient({
      accessToken: 'token',
      adAccountId: 'act_1',
      fetchImpl: ((url: unknown) => {
        seen.push(String(url));
        const page = pages.shift();
        return Promise.resolve(
          new Response(JSON.stringify(page ?? { data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof fetch,
    });

    const campaigns = await meta.listCampaigns();

    expect(campaigns.map((c) => c.id)).toEqual(['1', '2']);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('after=cursor-1');
  });

  it('stops at a page that carries a cursor but no next, instead of looping', async () => {
    // Exactly the shape that spun to the page limit before: every response
    // carries a cursor, so the cursor cannot be the stop signal.
    const meta = new MetaReadOnlyClient({
      accessToken: 'token',
      adAccountId: 'act_1',
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ id: 'same', name: 'Same', status: 'ACTIVE' }],
              paging: { cursors: { after: 'always-the-same' } },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        )) as typeof fetch,
    });

    expect(await meta.listCampaigns()).toHaveLength(1);
  });

  it('stops if the platform repeats a cursor, rather than paging forever', async () => {
    let calls = 0;
    const meta = new MetaReadOnlyClient({
      accessToken: 'token',
      adAccountId: 'act_1',
      fetchImpl: (() => {
        calls += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{ id: String(calls), name: 'X', status: 'ACTIVE' }],
              paging: { next: 'https://graph.facebook.com/next', cursors: { after: 'stuck' } },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }) as typeof fetch,
    });

    await meta.listCampaigns();
    expect(calls).toBe(2); // first page, then the repeat is detected
  });
});

describe('slicing the insights window', () => {
  it('splits an inclusive range into consecutive windows', () => {
    // Both ends inclusive, as Meta's time_range is: a 3-day window starting on
    // the 1st ends on the 3rd, and the next starts on the 4th.
    expect(sliceDateRange('2026-09-01', '2026-09-07', 3)).toEqual([
      ['2026-09-01', '2026-09-03'],
      ['2026-09-04', '2026-09-06'],
      ['2026-09-07', '2026-09-07'],
    ]);
  });

  it('returns a single window when the range fits', () => {
    expect(sliceDateRange('2026-09-01', '2026-09-30', 30)).toEqual([['2026-09-01', '2026-09-30']]);
  });

  it('handles a one-day range', () => {
    expect(sliceDateRange('2026-09-18', '2026-09-18', 3)).toEqual([['2026-09-18', '2026-09-18']]);
  });

  it('covers every day exactly once, with no gap or overlap', () => {
    const windows = sliceDateRange('2026-08-19', '2026-09-18', 3);
    const days = new Set<string>();
    for (const [since, until] of windows) {
      for (
        let d = Date.parse(`${since}T00:00:00Z`);
        d <= Date.parse(`${until}T00:00:00Z`);
        d += 86_400_000
      ) {
        const key = new Date(d).toISOString().slice(0, 10);
        expect(days.has(key)).toBe(false); // no overlap
        days.add(key);
      }
    }
    expect(days.size).toBe(31); // 19 Aug to 18 Sep inclusive
  });

  it('returns nothing when the range is inverted', () => {
    expect(sliceDateRange('2026-09-18', '2026-09-01', 3)).toEqual([]);
  });

  it('asks Meta for one window per slice at ad level', async () => {
    const ranges: string[] = [];
    const meta = new MetaReadOnlyClient({
      accessToken: 'token',
      adAccountId: 'act_1',
      fetchImpl: ((url: unknown) => {
        const parsed = new URL(String(url));
        const range = parsed.searchParams.get('time_range');
        if (range) ranges.push(range);
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof fetch,
    });

    await meta.getInsights('ad', '2026-09-01', '2026-09-09');

    // One day per window at ad level: measured, a 3-day window takes 16,7s
    // against the live account and blows the request timeout.
    expect(ranges).toHaveLength(9);
    expect(JSON.parse(ranges[0] ?? '{}')).toEqual({ since: '2026-09-01', until: '2026-09-01' });
    expect(JSON.parse(ranges[8] ?? '{}')).toEqual({ since: '2026-09-09', until: '2026-09-09' });
  });

  it('does not slice campaign level, which returns comfortably', async () => {
    const ranges: string[] = [];
    const meta = new MetaReadOnlyClient({
      accessToken: 'token',
      adAccountId: 'act_1',
      fetchImpl: ((url: unknown) => {
        const range = new URL(String(url)).searchParams.get('time_range');
        if (range) ranges.push(range);
        return Promise.resolve(
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof fetch,
    });

    await meta.getInsights('campaign', '2026-08-19', '2026-09-18');
    expect(ranges).toHaveLength(2); // 31 days at 30 per window
  });
});
