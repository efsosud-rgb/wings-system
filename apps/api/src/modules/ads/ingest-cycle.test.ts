import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAccountDaily, adAccounts, adCampaigns, budgetPeriods } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { openPeriod } from './budget-guard.js';
import {
  runIngestionCycle,
  runReconciliationCycle,
  type AccountCycleResult,
  type CycleAccount,
} from './ingest-cycle.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';
import type { AdsPlatformClient } from './platform/types.js';

const NOW = new Date('2026-09-18T12:00:00.000Z');
const PERIOD = '2026-09-01';
const SINCE = '2026-09-11';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

async function account(options: { withPeriod?: boolean } = {}): Promise<CycleAccount> {
  const externalId = `act_${randomBytes(4).toString('hex')}`;
  const [row] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId, name: 'Conta de teste' })
    .returning({ id: adAccounts.id });
  if (!row) throw new Error('failed');
  if (options.withPeriod ?? true) {
    await openPeriod(db, {
      adAccountId: row.id,
      periodMonth: PERIOD,
      capCents: 400_000,
      usablePercent: 70,
    });
  }
  return { id: row.id, platform: 'meta', externalId };
}

function liveLike(externalId: string, campaigns: { id: string; name: string }[] = []) {
  return new FakeMetaClient({
    accountId: externalId,
    campaigns: campaigns.map((c) => ({ ...c, dailyBudgetCents: 5000 })),
  });
}

/** A client whose platform is down: every read throws. */
function brokenClient(externalId: string): AdsPlatformClient {
  const client = liveLike(externalId);
  client.listCampaigns = () => Promise.reject(new Error('(#190) token expired'));
  return client;
}

async function lastReconciledAt(accountId: string): Promise<Date | null> {
  const period = await db.query.budgetPeriods.findFirst({
    where: and(eq(budgetPeriods.adAccountId, accountId), eq(budgetPeriods.periodMonth, PERIOD)),
  });
  return period?.lastReconciledAt ?? null;
}

describe('an ingestion cycle over several accounts', () => {
  it('still reconciles the accounts after one that throws', async () => {
    const broken = await account();
    const healthy = await account();

    const cycle = await runIngestionCycle(db, [broken, healthy], {
      clientFor: (a) =>
        a.id === broken.id
          ? brokenClient(a.externalId)
          : liveLike(a.externalId, [{ id: `c_${a.externalId}`, name: 'Institucional' }]),
      since: SINCE,
      now: NOW,
    });

    expect(cycle.failed).toBe(1);
    expect(cycle.accounts.map((r) => r.status)).toEqual(['failed', 'ok']);

    // The healthy account was really served, not merely reported as such.
    expect(await lastReconciledAt(healthy.id)).toEqual(NOW);
    const mirrored = await db.query.adCampaigns.findMany({
      where: eq(adCampaigns.adAccountId, healthy.id),
    });
    expect(mirrored).toHaveLength(1);

    // And the broken one is not passed off as reconciled: the dead-man switch
    // must still be able to see that it has gone stale.
    expect(await lastReconciledAt(broken.id)).toBeNull();
  });

  it('names the step an account died in', async () => {
    const broken = await account();
    const cycle = await runIngestionCycle(db, [broken], {
      clientFor: (a) => brokenClient(a.externalId),
      since: SINCE,
      now: NOW,
    });

    const [result] = cycle.accounts;
    expect(result).toMatchObject({ status: 'failed', step: 'reconcile' });
    expect(result?.status === 'failed' && result.error).toContain('token expired');
  });

  it('fails only the later step when the mirror worked but metrics did not', async () => {
    const target = await account();
    const client = liveLike(target.externalId, [{ id: 'c1', name: 'Institucional' }]);
    client.getInsights = (level) =>
      level === 'ad' ? Promise.reject(new Error('timeout')) : Promise.resolve([]);

    const cycle = await runIngestionCycle(db, [target], {
      clientFor: () => client,
      since: SINCE,
      now: NOW,
    });

    expect(cycle.accounts[0]).toMatchObject({ status: 'failed', step: 'metrics:ad' });
    // Reconciliation had already succeeded, and that stays true.
    expect(await lastReconciledAt(target.id)).toEqual(NOW);
  });

  it('treats an empty account as a normal success', async () => {
    const empty = await account();
    const cycle = await runIngestionCycle(db, [empty], {
      clientFor: (a) => liveLike(a.externalId),
      since: SINCE,
      now: NOW,
    });

    expect(cycle.failed).toBe(0);
    const [result] = cycle.accounts;
    expect(result?.status).toBe('ok');
    if (result?.status !== 'ok') throw new Error('unreachable');
    expect(result.reconciled.campaignsSynced).toBe(0);
    expect(result.metrics.ad.rows).toBe(0);
  });

  it('contains an account with no budget period, the way three of four real ones began', async () => {
    const unopened = await account({ withPeriod: false });
    const healthy = await account();

    const cycle = await runIngestionCycle(db, [unopened, healthy], {
      clientFor: (a) => liveLike(a.externalId),
      since: SINCE,
      now: NOW,
    });

    expect(cycle.accounts.map((r) => r.status)).toEqual(['failed', 'ok']);
    expect(cycle.accounts[0]).toMatchObject({ step: 'reconcile' });
  });

  it('skips an account without credentials and does not count it as failed', async () => {
    const orphan = await account();
    const healthy = await account();

    const cycle = await runIngestionCycle(db, [orphan, healthy], {
      clientFor: (a) => (a.id === orphan.id ? null : liveLike(a.externalId)),
      since: SINCE,
      now: NOW,
    });

    expect(cycle.failed).toBe(0);
    expect(cycle.accounts.map((r) => r.status)).toEqual(['skipped', 'ok']);
  });

  it('contains a client factory that throws', async () => {
    const broken = await account();
    const healthy = await account();

    const cycle = await runIngestionCycle(db, [broken, healthy], {
      clientFor: (a) => {
        if (a.id === broken.id) throw new Error('bad credentials shape');
        return liveLike(a.externalId);
      },
      since: SINCE,
      now: NOW,
    });

    expect(cycle.accounts[0]).toMatchObject({ status: 'failed', step: 'client' });
    expect(cycle.accounts[1]?.status).toBe('ok');
  });

  it('keeps going when the progress reporter itself throws', async () => {
    const first = await account();
    const second = await account();
    const seen: AccountCycleResult['status'][] = [];

    const cycle = await runIngestionCycle(db, [first, second], {
      clientFor: (a) => liveLike(a.externalId),
      since: SINCE,
      now: NOW,
      onAccountDone: (result) => {
        seen.push(result.status);
        throw new Error('stdout closed');
      },
    });

    expect(seen).toEqual(['ok', 'ok']);
    expect(cycle.failed).toBe(0);
  });
});

describe('what the read token may not see', () => {
  // The staging failure of 22/09: "(#10) Permission Denied" on the account's
  // payment fields took the whole account down in `reconcile`. A denied
  // nicety is "não disponível", and the money steps still run.
  it('records the payment fields as unavailable and still reconciles', async () => {
    const target = await account();
    const client = new FakeMetaClient({
      accountId: target.externalId,
      campaigns: [{ id: 'c1', name: 'Leads', dailyBudgetCents: 5000 }],
      permissionDenied: { funding: true },
    });
    client.simulateDay('2026-09-17');

    const cycle = await runIngestionCycle(db, [target], {
      clientFor: () => client,
      since: SINCE,
      now: NOW,
    });

    const [result] = cycle.accounts;
    expect(result?.status).toBe('ok');
    expect(result?.status === 'ok' && result.accountDay.warnings[0]).toContain('#10');
    expect(await lastReconciledAt(target.id)).toEqual(NOW);
    const day = await db.query.adAccountDaily.findFirst({
      where: eq(adAccountDaily.adAccountId, target.id),
    });
    expect(day?.fundingKind).toBe('unavailable');
    expect(day?.prepaidBalanceCents).toBeNull();
    expect(day?.spendCapCents).toBeNull();
  });

  it('marks a denied breakdown as unavailable and goes on with the others', async () => {
    const target = await account();
    const client = new FakeMetaClient({
      accountId: target.externalId,
      campaigns: [{ id: 'c1', name: 'Leads', dailyBudgetCents: 5000 }],
      permissionDenied: { breakdowns: ['region', 'hour'] },
    });
    client.simulateDay('2026-09-17');

    const cycle = await runIngestionCycle(db, [target], {
      clientFor: () => client,
      since: SINCE,
      now: NOW,
    });

    const [result] = cycle.accounts;
    expect(result?.status).toBe('ok');
    if (result?.status !== 'ok') throw new Error('unreachable');
    expect(result.breakdowns.region).toMatchObject({ unavailable: true, rows: 0 });
    expect(result.breakdowns.hour).toMatchObject({ unavailable: true, rows: 0 });
    expect(result.breakdowns.placement.unavailable).toBeUndefined();
    expect(result.breakdowns.placement.rows).toBeGreaterThan(0);
    // The steps after the breakdowns still ran.
    expect(result.accountDay.day).toBe('2026-09-18');
    expect(cycle.failed).toBe(0);
  });

  it('still fails the account on a breakdown error that is not a permission', async () => {
    const target = await account();
    const client = liveLike(target.externalId, [{ id: 'c1', name: 'Leads' }]);
    client.getBreakdowns = () => Promise.reject(new Error('timeout'));

    const cycle = await runIngestionCycle(db, [target], {
      clientFor: () => client,
      since: SINCE,
      now: NOW,
    });

    expect(cycle.accounts[0]).toMatchObject({ status: 'failed', step: 'breakdown:placement' });
  });
});

describe('the fast reconcile-only cycle', () => {
  it('reconciles every account and skips the rest of the full cycle entirely', async () => {
    const target = await account();
    const client = liveLike(target.externalId, [{ id: 'c1', name: 'Institucional' }]);

    const cycle = await runReconciliationCycle(db, [target], {
      clientFor: () => client,
      now: NOW,
    });

    expect(cycle.failed).toBe(0);
    const [result] = cycle.accounts;
    expect(result).toMatchObject({ status: 'ok' });
    if (result?.status !== 'ok') throw new Error('unreachable');
    expect(result.reconciled.campaignsSynced).toBe(1);
    expect(await lastReconciledAt(target.id)).toEqual(NOW);

    // No ad, no campaign metric row exists for this account: the fast cycle
    // never called syncAds/ingestMetrics/ingestBreakdown.
    const mirrored = await db.query.adCampaigns.findMany({
      where: eq(adCampaigns.adAccountId, target.id),
    });
    expect(mirrored).toHaveLength(1); // campaigns are mirrored by reconcileAccount itself
  });

  it('still reconciles the other accounts after one that throws', async () => {
    const broken = await account();
    const healthy = await account();

    const cycle = await runReconciliationCycle(db, [broken, healthy], {
      clientFor: (a) => (a.id === broken.id ? brokenClient(a.externalId) : liveLike(a.externalId)),
      now: NOW,
    });

    expect(cycle.failed).toBe(1);
    expect(cycle.accounts.map((r) => r.status)).toEqual(['failed', 'ok']);
    expect(await lastReconciledAt(healthy.id)).toEqual(NOW);
    expect(await lastReconciledAt(broken.id)).toBeNull();
  });

  it('skips an account without credentials and does not count it as failed', async () => {
    const orphan = await account();
    const cycle = await runReconciliationCycle(db, [orphan], {
      clientFor: () => null,
      now: NOW,
    });

    expect(cycle.failed).toBe(0);
    expect(cycle.accounts[0]).toMatchObject({ status: 'skipped', reason: 'no_credentials' });
  });
});
