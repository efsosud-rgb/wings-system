import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adApprovalRequests, auditLog } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import type { DecisionResult } from './approvals.js';
import { expireStaleChanges, type ExpiryResult } from './expiry.js';
import { at, guardFixtures } from './write-time-guard-fixtures.js';

/**
 * Two clicks at the same instant. Promise.all alone does not make them meet:
 * the fake platform answers at once and one transaction is over before the
 * other starts, so a test can pass with the guard removed (review of PR #76).
 * Each test here parks the racers at the period row first.
 *
 * Part 1 also raced two executions that each fit alone but not together. That
 * pair was born of T-1 (the reconciliation wiped the first reservation, so the
 * second was accepted); since part 2 the second request is refused, and every
 * stage counts both, so there is no such pair left to race. The races of the
 * one commitment are in commitment-races.test.ts.
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

const { world, requested, decide, changeRow, raceBehindThePeriod } = guardFixtures(() => ({
  db,
  approverId,
}));

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
