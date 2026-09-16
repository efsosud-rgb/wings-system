import { describe, expect, it } from 'vitest';
import {
  AD_ACCOUNT_RESPONSE,
  CAMPAIGNS_RESPONSE,
  ERROR_INVALID_TOKEN,
  ERROR_RATE_LIMIT,
  INSIGHTS_RESPONSE,
} from './fixtures.js';
import { MetaApiError, MetaReadOnlyClient, MetaWritesDisabledError } from './meta-client.js';
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
