import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAccounts, budgetPeriods } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { activeAdAccounts } from './metrics.js';
import { seedAdAccount } from './seed-account.js';

let harness: TestDatabase;
let db: Database;

const NOW = new Date('2026-09-19T15:00:00Z');
const env = { META_WRITE_ACCOUNT_ID: 'act_111', GOOGLE_ADS_CUSTOMER_ID: '426-858-6278' };

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

async function periodOf(accountId: string) {
  return db.query.budgetPeriods.findFirst({
    where: and(
      eq(budgetPeriods.adAccountId, accountId),
      eq(budgetPeriods.periodMonth, '2026-09-01'),
    ),
  });
}

describe('seeding a Meta account — unchanged', () => {
  it('falls back to the configured account, the old name and R$ 4.000 at 70%', async () => {
    const seeded = await seedAdAccount(db, env, {}, NOW);

    expect(seeded).toMatchObject({
      platform: 'meta',
      externalId: 'act_111',
      name: 'Wings Matriz',
      capCents: 400_000,
      usablePercent: 70,
      periodMonth: '2026-09-01',
    });
    const period = await periodOf(seeded.accountId);
    expect(Number(period?.capCents)).toBe(400_000);
    expect(Number(period?.usableCents)).toBe(280_000);
  });

  it('takes the account, name, cap and usable share from the options', async () => {
    const seeded = await seedAdAccount(
      db,
      env,
      { account: 'act_222', name: 'Fly High', cap: '250000', usable: '70' },
      NOW,
    );
    const period = await periodOf(seeded.accountId);
    expect(seeded.platform).toBe('meta');
    expect(Number(period?.capCents)).toBe(250_000);
    expect(Number(period?.usableCents)).toBe(175_000);
  });

  it('is safe to repeat: same row, cap updated', async () => {
    const first = await seedAdAccount(db, env, { account: 'act_333', cap: '100000' }, NOW);
    const second = await seedAdAccount(db, env, { account: 'act_333', cap: '200000' }, NOW);

    expect(second.accountId).toBe(first.accountId);
    expect(Number((await periodOf(first.accountId))?.capCents)).toBe(200_000);
  });

  it('still demands an account when none is configured', async () => {
    await expect(seedAdAccount(db, {}, {}, NOW)).rejects.toThrow(/--account act_/);
  });
});

describe('seeding a Google account', () => {
  const google = {
    platform: 'google',
    account: '4268586278',
    name: 'Wings Company — Google Ads',
    cap: '250000',
    usable: '70',
  };

  it('creates a google row the ingestion job will pick up, with its period', async () => {
    const seeded = await seedAdAccount(db, env, google, NOW);

    const row = await db.query.adAccounts.findFirst({ where: eq(adAccounts.id, seeded.accountId) });
    expect(row).toMatchObject({
      platform: 'google',
      externalId: '4268586278',
      name: 'Wings Company — Google Ads',
      killSwitchEngaged: false,
    });
    expect((await activeAdAccounts(db, 'google')).map((a) => a.id)).toContain(seeded.accountId);
    expect((await activeAdAccounts(db, 'meta')).map((a) => a.id)).not.toContain(seeded.accountId);

    // Without a period, applyPlatformLimit has nowhere to record the limit.
    const period = await periodOf(seeded.accountId);
    expect(Number(period?.capCents)).toBe(250_000);
    expect(Number(period?.usableCents)).toBe(175_000);
  });

  it('stores the customer id without dashes, however it was typed', async () => {
    const seeded = await seedAdAccount(db, env, { ...google, account: '426-858-6278' }, NOW);
    expect(seeded.externalId).toBe('4268586278');
  });

  it('refuses a customer this environment is not credentialed for', async () => {
    await expect(seedAdAccount(db, env, { ...google, account: '1112223334' }, NOW)).rejects.toThrow(
      /GOOGLE_ADS_CUSTOMER_ID/,
    );
    await expect(seedAdAccount(db, {}, google, NOW)).rejects.toThrow(/GOOGLE_ADS_CUSTOMER_ID/);
  });

  it('requires an account and a name, and never borrows the Meta defaults', async () => {
    await expect(seedAdAccount(db, env, { platform: 'google' }, NOW)).rejects.toThrow(/--account/);
    await expect(
      seedAdAccount(db, env, { platform: 'google', account: '4268586278' }, NOW),
    ).rejects.toThrow(/--name/);
    await expect(seedAdAccount(db, env, { ...google, account: 'act_111' }, NOW)).rejects.toThrow(
      /10 digits/,
    );
  });
});

describe('options that would corrupt a period', () => {
  it.each([
    [{ platform: 'tiktok' }, /--platform/],
    [{ cap: 'abc' }, /--cap/],
    [{ cap: '0' }, /--cap/],
    [{ cap: '2500.50' }, /--cap/],
    [{ usable: '0' }, /--usable/],
    [{ usable: '101' }, /--usable/],
  ])('refuses %o before touching the database', async (options, message) => {
    const before = (await db.query.adAccounts.findMany()).length;
    await expect(seedAdAccount(db, env, { account: 'act_999', ...options }, NOW)).rejects.toThrow(
      message,
    );
    expect((await db.query.adAccounts.findMany()).length).toBe(before);
  });
});
