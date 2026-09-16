import { describe, expect, it } from 'vitest';
import { FakeMetaClient } from './fake-meta-client.js';
import { assertPlausibleAmount, formatBrl } from './money.js';

const CAP = 1_000_000; // R$10.000,00 in cents

function client(overrides = {}) {
  return new FakeMetaClient({
    spendCapCents: CAP,
    campaigns: [
      { id: 'c1', name: 'Institucional', status: 'ACTIVE', dailyBudgetCents: 5000 },
      { id: 'c2', name: 'Remarketing', status: 'PAUSED', dailyBudgetCents: 3000 },
    ],
    ...overrides,
  });
}

describe('fake client is never mistaken for a live one', () => {
  it('reports isLive false', () => {
    expect(client().isLive).toBe(false);
  });
});

describe('money units', () => {
  it('treats budgets as integer cents', async () => {
    const meta = client();
    const result = await meta.setDailyBudget('c1', 7500);
    expect(result.status).toBe('applied');
    if (result.status === 'applied') expect(result.campaign.dailyBudgetCents).toBe(7500);
    expect(formatBrl(7500)).toContain('75,00');
  });

  it('refuses non-integer or negative amounts', async () => {
    const meta = client();
    await expect(meta.setDailyBudget('c1', 75.5)).rejects.toThrow(/integer in cents/);
    await expect(meta.setDailyBudget('c1', -100)).rejects.toThrow(/integer in cents/);
  });

  it('catches a 100x unit mistake before it reaches the platform', () => {
    // R$50,00 sent as 5000 is right; sending 500000 ("50000 reais") is not.
    expect(() => assertPlausibleAmount(5000, { monthlyCapCents: CAP })).not.toThrow();
    expect(() => assertPlausibleAmount(CAP * 100, { monthlyCapCents: CAP })).toThrow(
      /exceeds the monthly cap/,
    );
    expect(() => assertPlausibleAmount(5, { monthlyCapCents: CAP })).toThrow(/below the minimum/);
  });
});

describe('delivery behaves like Meta, not like arithmetic', () => {
  it('overspends the daily budget by up to 25%', () => {
    const meta = client({ overdeliveryFactor: 1.25 });
    meta.simulateDay('2026-09-16');
    // R$50 budget, R$62,50 actually delivered.
    expect(meta.actualTotalSpendCents()).toBe(6250);
  });

  it('never lets the overdelivery factor exceed the documented 25%', () => {
    const meta = client({ overdeliveryFactor: 5 });
    meta.simulateDay('2026-09-16');
    expect(meta.actualTotalSpendCents()).toBe(6250);
  });

  it('only spends on active campaigns', () => {
    const meta = client();
    meta.simulateDay('2026-09-16');
    expect(meta.actualTotalSpendCents()).toBe(5000); // c2 is paused
  });

  it('hides spend that has not been reported yet', async () => {
    const meta = client({ reportingLagMinutes: 60 });
    meta.simulateDay('2026-09-16');

    const account = await meta.getAccount();
    // The platform admits to nothing yet, but the money is already gone.
    expect(account.amountSpentCents).toBe(0);
    expect(meta.actualTotalSpendCents()).toBe(5000);

    meta.settleReporting();
    expect((await meta.getAccount()).amountSpentCents).toBe(5000);
  });
});

describe('account spending limit', () => {
  it('pauses every campaign when the cap is reached', async () => {
    const meta = new FakeMetaClient({
      spendCapCents: 10_000, // R$100,00
      campaigns: [{ id: 'c1', name: 'Institucional', dailyBudgetCents: 8000 }],
    });

    meta.simulateDay('2026-09-16');
    meta.simulateDay('2026-09-17');

    const account = await meta.getAccount();
    expect(account.capReached).toBe(true);
    // Spend stops exactly at the cap, never above it.
    expect(meta.actualTotalSpendCents()).toBe(10_000);
    expect((await meta.getCampaign('c1'))?.status).toBe('PAUSED');
  });

  it('refuses to resume while the cap is reached', async () => {
    const meta = new FakeMetaClient({
      spendCapCents: 5000,
      campaigns: [{ id: 'c1', name: 'X', dailyBudgetCents: 5000 }],
    });
    meta.simulateDay('2026-09-16');

    const resumed = await meta.resumeCampaign('c1');
    expect(resumed.status).toBe('rejected');
  });

  it('refuses a cap below what was already spent', async () => {
    const meta = client();
    meta.simulateDay('2026-09-16');
    const result = await meta.setAccountSpendCap(100);
    expect(result.status).toBe('rejected');
  });
});

describe('failure modes the executor must survive', () => {
  it('returns unknown when the call times out after applying the change', async () => {
    const meta = client();
    meta.injectFailure({ kind: 'timeout_after_apply' });

    const result = await meta.setDailyBudget('c1', 9000);
    expect(result.status).toBe('unknown');

    // The change DID land. Retrying blindly would be the bug; reading state
    // is the only safe next move.
    expect((await meta.getCampaign('c1'))?.dailyBudgetCents).toBe(9000);
  });

  it('surfaces rate limits and invalid tokens as rejections, not successes', async () => {
    const meta = client();
    meta.injectFailure({ kind: 'rate_limit' });
    expect(await meta.setDailyBudget('c1', 6000)).toMatchObject({
      status: 'rejected',
      code: '80004',
    });

    meta.injectFailure({ kind: 'invalid_token' });
    expect(await meta.setDailyBudget('c1', 6000)).toMatchObject({
      status: 'rejected',
      code: '190',
    });

    // Neither attempt changed the budget.
    expect((await meta.getCampaign('c1'))?.dailyBudgetCents).toBe(5000);
  });

  it('rejects a budget below the platform minimum', async () => {
    const meta = client();
    expect(await meta.setDailyBudget('c1', 50)).toMatchObject({ status: 'rejected' });
  });

  it('records every call for auditing what the system attempted', async () => {
    const meta = client();
    await meta.setDailyBudget('c1', 6000);
    await meta.pauseCampaign('c1');
    expect(meta.calls.map((c) => c.method)).toEqual(['setDailyBudget', 'pauseCampaign']);
  });
});
