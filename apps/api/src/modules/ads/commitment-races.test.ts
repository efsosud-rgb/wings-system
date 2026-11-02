import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adCampaigns } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { reserveChange } from './budget-guard.js';
import { at, guardFixtures, type World } from './write-time-guard-fixtures.js';

/**
 * Travas de verba, part 2: the races of the one commitment. Every stage reads
 * the same number (mirror + increases holding a reservation), so what can go
 * wrong is a change dropping out of it on its way: wiped by a reconciliation
 * that read the platform before the change, or counted by neither the
 * reservation nor the mirror while it is being written. Each test parks the
 * racers at a known line before letting go (lesson of PR #76).
 *
 * Base world: two campaigns at R$ 10/dia = 52_500; usable 210_000. Raising A
 * to R$ 40/dia adds 78_750 (131_250); raising B to R$ 50/dia adds 105_000,
 * which fits on the base (157_500) but not on top of A (236_250).
 */
let harness: TestDatabase;
let db: Database;
let approverId: string;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  approverId = (await createEmployee(db, { role: 'admin_master', sector: 'diretoria' })).id;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const { world, requested, approved, execute, changeRow, lockWaiters, raceBehindThePeriod } =
  guardFixtures(() => ({ db, approverId }));

/** Asks for B to R$ 50/dia: refused while A's increase still counts, reserved once it does not. */
async function raiseB(w: World, now = at(2)) {
  return reserveChange(db, {
    adAccountId: w.accountId,
    campaignId: await w.campaign('b'),
    kind: 'set_daily_budget',
    toDailyBudgetCents: 5000,
    now,
  });
}

/** Makes one platform call wait for the test; resolves `reached` once the call has been made. */
function hold<K extends 'listCampaigns' | 'getSpend' | 'setDailyBudget'>(
  w: World,
  method: K,
  where: 'before' | 'after',
) {
  const original = (w.client[method] as (...args: unknown[]) => Promise<unknown>).bind(w.client);
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let reach = () => {};
  const reached = new Promise<void>((resolve) => (reach = resolve));
  let held = false;
  (w.client as unknown as Record<K, (...args: unknown[]) => Promise<unknown>>)[method] = async (
    ...args: unknown[]
  ) => {
    if (held) return original(...args);
    held = true;
    reach();
    if (where === 'before') await released;
    const answer = await original(...args);
    if (where === 'after') await released;
    return answer;
  };
  return { reached, release };
}

async function waitForStatus(changeId: string, status: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while ((await changeRow(changeId)).status !== status) {
    if (Date.now() > deadline) throw new Error(`change never reached ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('a reconciliation never wipes a reservation (T-1)', () => {
  it('counts a request made while it was reading the platform', async () => {
    const w = await world({ a: 1000, b: 1000 });
    // The reconciliation has mirrored the campaigns and waits on the spend
    // read, before its write: the old code then wrote the mirror alone.
    const spend = hold(w, 'getSpend', 'before');
    const reconciling = w.reconcile(at(0.25));
    await spend.reached;
    const a = await requested(w, 'a', { kind: 'set_daily_budget', to: 4000 }, at(0.2));
    spend.release();
    await reconciling;

    expect(await w.committed()).toBe(131_250);
    expect(await raiseB(w)).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
    expect(await changeRow(a.changeId)).toMatchObject({
      status: 'pending_approval',
      reservationActive: true,
    });
  });

  it('a reconciliation queued right behind a request at the period lock counts it', async () => {
    const w = await world({ a: 1000, b: 1000 });
    const periodId = await w.periodId();
    let runs: Promise<unknown>[] = [];

    // The request first in line, the reconciliation behind it: Postgres hands
    // the row over in that order, so the reconciliation works its figure out
    // after the request committed — and only if it does so under the lock.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from ad_budget_periods where id = ${periodId} for update`);
      runs = [requested(w, 'a', { kind: 'set_daily_budget', to: 4000 }, at(0.2))];
      await lockWaiters(1);
      runs.push(w.reconcile(at(0.25)));
      await lockWaiters(2);
    });
    await Promise.all(runs);

    expect(await w.committed()).toBe(131_250);
    expect(await raiseB(w)).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
  });

  it('two requests at the same instant that fit alone but not together: one is reserved', async () => {
    const w = await world({ a: 1000, b: 1000 });
    const campaignA = await w.campaign('a');

    const results = await raceBehindThePeriod(w, 2, () => [
      reserveChange(db, {
        adAccountId: w.accountId,
        campaignId: campaignA,
        kind: 'set_daily_budget',
        toDailyBudgetCents: 6000, // +131_250 → 183_750
        now: at(0.2),
      }),
      raiseB(w, at(0.2)), // +105_000 → 157_500
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect([183_750, 157_500]).toContain(await w.committed());
  });
});

describe('a change never leaves the count on its way to the platform', () => {
  it('still counts while its write is on its way to Meta, through a reconciliation', async () => {
    const w = await world({ a: 1000, b: 1000 });
    const a = await approved(w, 'a', 4000);
    const write = hold(w, 'setDailyBudget', 'before');

    const running = execute(w, a.changeId, at(1));
    try {
      await write.reached;
      await waitForStatus(a.changeId, 'executing');
      // The platform and the mirror still show R$ 10/dia: only `executing` holds A.
      await w.reconcile(at(1));
      expect(await w.committed()).toBe(131_250);
      expect(await raiseB(w, at(1))).toMatchObject({
        ok: false,
        reason: 'usable_would_be_exceeded',
      });
    } finally {
      write.release();
    }

    expect(await running).toMatchObject({ outcome: 'applied' });
    // Executed: now the mirror holds it, and the reservation no longer does.
    expect(await w.committed()).toBe(131_250);
    expect(await raiseB(w)).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
    expect(w.budgetWrites()).toEqual(['a']);
  });

  it('a reconciliation that read the platform before the write does not write the old budget back', async () => {
    const w = await world({ a: 1000, b: 1000 });
    const a = await approved(w, 'a', 4000);
    // The reconciliation read the campaigns (A at R$ 10/dia) and waits there.
    // Its clock is a minute behind the execution's, as a read made before the
    // write is: the test does not lean on the executor's clock moving 1 ms.
    const read = hold(w, 'listCampaigns', 'after');
    const reconciling = w.reconcile(new Date(at(1).getTime() - 60_000));
    await read.reached;

    try {
      expect(await execute(w, a.changeId, at(1))).toMatchObject({ outcome: 'applied' });
    } finally {
      read.release();
    }
    await reconciling;

    const mirrored = await db.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, await w.campaign('a')),
    });
    expect(mirrored?.dailyBudgetCents).toBe(4000);
    expect(await w.committed()).toBe(131_250);
    expect(await raiseB(w)).toMatchObject({ ok: false, reason: 'usable_would_be_exceeded' });
  });
});
