import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adApprovalRequests, auditLog } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import type { DecisionResult } from './approvals.js';
import { expireStaleChanges, type ExpiryResult } from './expiry.js';
import { at, guardFixtures, type World } from './write-time-guard-fixtures.js';

/**
 * Two clicks at the same instant. Promise.all alone does not make them meet:
 * the fake platform answers at once and one transaction is over before the
 * other starts, so a test can pass with the guard removed (review of PR #76).
 * Each test here parks the racers at a known line first: a write held on its
 * way to the platform, an advisory lock inside the claim, or the period row.
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

const {
  world,
  requested,
  decide,
  execute,
  changeRow,
  twoIncreasesAcrossAReconciliation,
  lockWaiters,
  raceBehindThePeriod,
} = guardFixtures(() => ({ db, approverId }));

/**
 * The first budget write waits until the test lets it go, as a real one waits
 * seconds for Meta: until then the mirror still shows the old budget, and only
 * the sum of the changes in flight holds the ceiling.
 */
function holdFirstWrite(w: World) {
  const send = w.client.setDailyBudget.bind(w.client);
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  w.client.setDailyBudget = async (...args) => {
    if (!held) {
      held = true;
      await released;
    }
    return send(...args);
  };
  return release;
}

describe('two executions at the same instant', () => {
  // B to R$ 50/dia: A (+78_750) and B (+105_000) each fit alone on the 52_500
  // base, not together (236_250 > 210_000).

  it('lets only one out while the first write is still on its way to Meta', async () => {
    const { w, a, b } = await twoIncreasesAcrossAReconciliation(5000);
    const release = holdFirstWrite(w);

    const runs = [execute(w, a.changeId, at(1)), execute(w, b.changeId, at(1))];
    try {
      // The held one cannot finish, so the first to finish is the other click,
      // judged while the first write is still out.
      await Promise.race(runs);
    } finally {
      release();
    }
    const results = await Promise.all(runs);

    expect(results.filter((result) => result.outcome === 'applied')).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.outcome === 'refused' && result.reason === 'cap_no_longer_allows',
      ),
    ).toHaveLength(1);
    expect(w.budgetWrites()).toHaveLength(1);
  });

  it('judges two claims one after the other (the period lock)', async () => {
    const { w, a, b } = await twoIncreasesAcrossAReconciliation(5000);
    // Each claim stops right after its check, before it commits `executing`,
    // until the test lets go. With the period lock the second waits for the
    // first to commit; without it both pass the check on the same figures.
    const key = 7_301_076;
    await db.execute(
      sql.raw(`
        create function hold_claim() returns trigger language plpgsql as $$
        begin
          perform pg_advisory_xact_lock_shared(${key});
          return new;
        end $$;
        create trigger hold_claim before update on ad_change_requests
          for each row when (old.status = 'approved' and new.status = 'executing')
          execute function hold_claim();
      `),
    );
    try {
      let runs: ReturnType<typeof execute>[] = [];
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
        runs = [execute(w, a.changeId, at(1)), execute(w, b.changeId, at(1))];
        // One claim at the advisory lock and the other behind the period row
        // (with the lock), or both at the advisory lock (without it).
        await lockWaiters(2);
      });
      const results = await Promise.all(runs);

      expect(results.filter((result) => result.outcome === 'applied')).toHaveLength(1);
      expect(
        results.filter(
          (result) => result.outcome === 'refused' && result.reason === 'cap_no_longer_allows',
        ),
      ).toHaveLength(1);
      expect(w.budgetWrites()).toHaveLength(1);
    } finally {
      await db.execute(
        sql.raw('drop trigger hold_claim on ad_change_requests; drop function hold_claim();'),
      );
    }
  });
});

describe('one decision wins', () => {
  async function decisionAudits(approvalId: string) {
    const audits = await db.query.auditLog.findMany({ where: eq(auditLog.entityId, approvalId) });
    return audits.filter((entry) =>
      ['ads.approval_granted', 'ads.approval_rejected'].includes(entry.action),
    );
  }

  it('approve and reject at the same instant: exactly one is recorded', async () => {
    const w = await world({ a: 1000 });
    const ids = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 });

    const results = await raceBehindThePeriod(w, 2, () => [
      decide(ids.approvalId, 'approved'),
      decide(ids.approvalId, 'rejected'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.reason === 'already_decided'),
    ).toHaveLength(1);
    const change = await changeRow(ids.changeId);
    const approval = await db.query.adApprovalRequests.findFirst({
      where: eq(adApprovalRequests.id, ids.approvalId),
    });
    expect(approval?.status).toBe(change.status === 'approved' ? 'approved' : 'rejected');
    // Approved keeps its reservation; rejected gave it back. Never both, never neither.
    expect(change.reservationActive).toBe(change.status === 'approved');
    expect(await w.committed()).toBe(change.status === 'approved' ? 52_500 : 26_250);
    expect(await decisionAudits(ids.approvalId)).toHaveLength(1);
  });

  it('two approvers approving at the same instant: one approval, one audit entry', async () => {
    const w = await world({ a: 1000 });
    const ids = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 });

    const results = await raceBehindThePeriod(w, 2, () => [
      decide(ids.approvalId, 'approved'),
      decide(ids.approvalId, 'approved'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.reason === 'already_decided'),
    ).toHaveLength(1);
    expect(await changeRow(ids.changeId)).toMatchObject({
      status: 'approved',
      reservationActive: true,
    });
    expect(await w.committed()).toBe(52_500);
    expect(await decisionAudits(ids.approvalId)).toHaveLength(1);
  });

  it('approve and expire at the same instant: exactly one wins', async () => {
    const w = await world({ a: 1000 });
    const ids = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 });

    const [decision, expired] = await raceBehindThePeriod<DecisionResult | ExpiryResult>(
      w,
      2,
      () => [decide(ids.approvalId, 'approved', at(25)), expireStaleChanges(db, { now: at(25) })],
    );
    if (!decision || !expired || !('ok' in decision) || !('expired' in expired)) {
      throw new Error('unexpected race results');
    }

    const change = await changeRow(ids.changeId);
    const expiredThis = expired.expired.some((entry) => entry.changeRequestId === ids.changeId);
    expect(decision.ok).toBe(!expiredThis);
    expect(change.status).toBe(expiredThis ? 'expired' : 'approved');
    expect(change.reservationActive).toBe(!expiredThis);
  });
});
