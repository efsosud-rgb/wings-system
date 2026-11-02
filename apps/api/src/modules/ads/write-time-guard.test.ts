import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adApprovalRequests,
  adChangeRequests,
  auditLog,
  budgetPeriods,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { openPeriod } from './budget-guard.js';
import { expireStaleChanges, reportExpiredChanges } from './expiry.js';
import { at, CAP, guardFixtures, NOW, USABLE } from './write-time-guard-fixtures.js';

/**
 * Travas de verba, part 1: the executor judges the change's own delta at the
 * instant of the write, decisions cannot both win, and old requests expire.
 * The clock and the world are in write-time-guard-fixtures.ts; the races
 * (two clicks at the same instant) in write-time-guard-races.test.ts. Part 2
 * (one commitment for every stage) is in commitment*.test.ts; the
 * expectations here follow it: a reduction frees nothing until it runs, and
 * a release works the commitment out again on the day it happens.
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
  approved,
  execute,
  changeRow,
  twoIncreasesAcrossAReconciliation,
} = guardFixtures(() => ({ db, approverId }));

describe('the executor judges the change’s own delta at the instant of the write', () => {
  it('lets the second increase out when the month ends exactly at the ceiling', async () => {
    // B to R$ 40/dia: +78_750, so 131_250 + 78_750 = 210_000 = usable.
    const { w, a, b } = await twoIncreasesAcrossAReconciliation(4000);

    expect(await execute(w, a.changeId, at(1))).toMatchObject({ outcome: 'applied' });
    expect(await execute(w, b.changeId, at(1))).toMatchObject({ outcome: 'applied' });
    expect(w.budgetWrites()).toEqual(['a', 'b']);
  });

  it('refuses the second increase at its request when it would pass the ceiling', async () => {
    // B to R$ 40,01/dia: 131_250 + 78_776 = 210_026 > 210_000. In part 1 the
    // reconciliation wiped A, B was reserved and approved, and only the
    // executor stopped it; now the request itself is refused.
    const w = await world({ a: 1000, b: 1000 });
    const raise = await approved(w, 'a', 4000);
    await w.reconcile(at(0.25));

    await expect(approved(w, 'b', 4001, at(0.5))).rejects.toThrow(
      'reservation refused: usable_would_be_exceeded',
    );
    expect(await execute(w, raise.changeId, at(1))).toMatchObject({ outcome: 'applied' });
    expect(w.budgetWrites()).toEqual(['a']);
  });

  it('refuses an approved change that no longer holds its reservation', async () => {
    const w = await world({ a: 1000 });
    const a = await approved(w, 'a', 2000);
    // The state the approve/reject race (T-4) used to leave behind.
    await db
      .update(adChangeRequests)
      .set({ reservationActive: false })
      .where(eq(adChangeRequests.id, a.changeId));

    expect(await execute(w, a.changeId, at(1))).toMatchObject({
      outcome: 'refused',
      reason: 'reservation_missing',
    });
    expect(w.budgetWrites()).toEqual([]);
  });

  it('refuses a change asked for in another budget month', async () => {
    const w = await world({ a: 1000 });
    const a = await approved(w, 'a', 2000);
    const december = new Date('2026-12-01T15:00:00Z');
    await openPeriod(db, {
      adAccountId: w.accountId,
      periodMonth: '2026-12-01',
      capCents: CAP,
      usablePercent: 70,
    });
    await db
      .update(budgetPeriods)
      .set({ lastReconciledAt: december })
      .where(
        and(
          eq(budgetPeriods.adAccountId, w.accountId),
          eq(budgetPeriods.periodMonth, '2026-12-01'),
        ),
      );

    expect(await execute(w, a.changeId, december)).toMatchObject({
      outcome: 'refused',
      reason: 'cap_no_longer_allows',
    });
    expect(w.budgetWrites()).toEqual([]);
  });
});

describe('a reduction is never held back', () => {
  it('pauses a campaign in a month that is already at its ceiling', async () => {
    const w = await world({ a: 8000 }); // 210_000: the whole usable slice
    expect(await w.committed()).toBe(USABLE);
    const pause = await requested(w, 'a', { kind: 'pause_campaign' });
    await decide(pause.approvalId, 'approved');

    expect(await execute(w, pause.changeId)).toMatchObject({ outcome: 'applied' });
    expect(w.budgetWrites()).toEqual(['a']);
  });

  it('a pending pause frees no space, so rejecting it needs no freeze (T-3, T-5)', async () => {
    const w = await world({ a: 4000, b: 4000 }); // 210_000
    const pause = await requested(w, 'a', { kind: 'pause_campaign' });
    expect(await w.committed()).toBe(USABLE); // a is still spending

    // Part 1 reserved this raise on the space the pause only promised.
    await expect(approved(w, 'b', 8000)).rejects.toThrow(
      'reservation refused: usable_would_be_exceeded',
    );
    expect(await decide(pause.approvalId, 'rejected')).toMatchObject({ ok: true });

    expect(await changeRow(pause.changeId)).toMatchObject({
      status: 'rejected',
      reservationActive: false,
    });
    expect(await w.committed()).toBe(USABLE);
    const account = await db.query.adAccounts.findFirst({
      where: eq(adAccounts.id, w.accountId),
    });
    expect(account?.killSwitchEngaged).toBe(false);
  });
});

describe('a reservation is given back once (T-2)', () => {
  it('rejecting an increase that crossed a reconciliation does not take it out again', async () => {
    const w = await world({ a: 1000, b: 1000 }); // 52_500
    const raise = await requested(w, 'a', { kind: 'set_daily_budget', to: 4000 }); // 131_250
    await w.reconcile(at(0.25)); // still 131_250: the reservation survives it (part 2)
    expect(await w.committed()).toBe(131_250);

    expect(await decide(raise.approvalId, 'rejected', at(0.5))).toMatchObject({ ok: true });

    // Part 1 era: 52_500 − 78_750, floored at 0, and the month looked empty.
    expect(await w.committed()).toBe(52_500);
    expect(await changeRow(raise.changeId)).toMatchObject({
      status: 'rejected',
      reservationActive: false,
    });
  });

  it('expiring a pause that crossed a reconciliation does not add it back again', async () => {
    const w = await world({ a: 1000, b: 1000 }); // 52_500
    const pause = await requested(w, 'a', { kind: 'pause_campaign' }); // frees nothing: 52_500
    await w.reconcile(at(0.25)); // 52_500: the pause never happened on the platform

    await expireStaleChanges(db, { now: at(25) });

    expect(await changeRow(pause.changeId)).toMatchObject({ status: 'expired' });
    // Worked out on the day it expires: 2 × 1000 × 20 days × 1.25. Not 78_750.
    expect(await w.committed()).toBe(50_000);
  });

  it('still gives back a reservation taken since the last reconciliation', async () => {
    const w = await world({ a: 1000 }); // 26_250
    const raise = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 }); // 52_500

    await decide(raise.approvalId, 'rejected');

    expect(await w.committed()).toBe(26_250);
  });
});

describe('old requests expire', () => {
  it('expires a request nobody decided in 24 h, gives its reservation back and closes the approval', async () => {
    const w = await world({ a: 1000 });
    const ids = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 });
    expect(await w.committed()).toBe(52_500);

    expect((await expireStaleChanges(db, { now: at(23) })).expired).not.toContainEqual(
      expect.objectContaining({ changeRequestId: ids.changeId }),
    );
    const expired = (await expireStaleChanges(db, { now: at(25) })).expired;

    expect(expired).toContainEqual({
      changeRequestId: ids.changeId,
      adAccountId: w.accountId,
      why: 'age',
    });
    expect(await changeRow(ids.changeId)).toMatchObject({
      status: 'expired',
      reservationActive: false,
    });
    // The campaign alone, on the day it expired: 1000 × 20 days × 1.25.
    expect(await w.committed()).toBe(25_000);
    const approval = await db.query.adApprovalRequests.findFirst({
      where: eq(adApprovalRequests.id, ids.approvalId),
    });
    expect(approval?.status).toBe('expired');
    const audit = await db.query.auditLog.findFirst({
      where: and(eq(auditLog.entityId, ids.changeId), eq(auditLog.action, 'ads.change_expired')),
    });
    expect(audit?.metadata).toMatchObject({ why: 'age', previousStatus: 'pending_approval' });

    // Nobody can approve it afterwards, and a second run changes nothing.
    expect(await decide(ids.approvalId, 'approved', at(26))).toMatchObject({
      ok: false,
      reason: 'already_decided',
    });
    expect((await expireStaleChanges(db, { now: at(27) })).expired).not.toContainEqual(
      expect.objectContaining({ changeRequestId: ids.changeId }),
    );
    expect(await w.committed()).toBe(25_000);
  });

  it('counts an approval’s day from the decision, and then the executor refuses it', async () => {
    const w = await world({ a: 1000 });
    const ids = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 });
    expect(await decide(ids.approvalId, 'approved', at(20))).toMatchObject({ ok: true });

    expect((await expireStaleChanges(db, { now: at(30) })).expired).not.toContainEqual(
      expect.objectContaining({ changeRequestId: ids.changeId }),
    );
    expect((await expireStaleChanges(db, { now: at(45) })).expired).toContainEqual(
      expect.objectContaining({ changeRequestId: ids.changeId, why: 'age' }),
    );

    expect(await execute(w, ids.changeId)).toMatchObject({
      outcome: 'refused',
      reason: 'not_approved',
    });
    expect(w.budgetWrites()).toEqual([]);
  });

  it('expires every open request of a month that has ended', async () => {
    const w = await world({ a: 1000 });
    const ids = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 });

    const expired = (await expireStaleChanges(db, { now: new Date('2026-12-01T03:30:00Z') }))
      .expired;

    expect(expired).toContainEqual(
      expect.objectContaining({ changeRequestId: ids.changeId, why: 'month_turned' }),
    );
  });

  it('expiring a reduction in a full month neither breaks nor freezes', async () => {
    const w = await world({ a: 4000, b: 4000 }); // 210_000
    const pause = await requested(w, 'a', { kind: 'pause_campaign' });

    const expired = (await expireStaleChanges(db, { now: at(25) })).expired;

    expect(expired).toContainEqual(
      expect.objectContaining({ changeRequestId: pause.changeId, why: 'age' }),
    );
    expect(await changeRow(pause.changeId)).toMatchObject({ status: 'expired' });
    // Both campaigns, on the day it expired: 2 × 4000 × 20 days × 1.25.
    expect(await w.committed()).toBe(200_000);
    const account = await db.query.adAccounts.findFirst({
      where: eq(adAccounts.id, w.accountId),
    });
    expect(account?.killSwitchEngaged).toBe(false);
  });

  it('one request that cannot be expired does not keep the others holding money', async () => {
    const w = await world({ a: 1000, b: 1000 });
    const stuck = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 });
    const other = await requested(w, 'b', { kind: 'set_daily_budget', to: 2000 });
    // A fault on this one request only, in the throwaway database.
    await db.execute(
      sql.raw(`
        create function fail_one_change() returns trigger language plpgsql as $$
        begin
          if new.id = '${stuck.changeId}' then raise exception 'falha injetada'; end if;
          return new;
        end $$;
        create trigger fail_one_change before update on ad_change_requests
          for each row execute function fail_one_change();
      `),
    );
    try {
      const result = await expireStaleChanges(db, { now: at(25) });

      expect(result.failed).toContainEqual({
        changeRequestId: stuck.changeId,
        error: expect.stringContaining('falha injetada'),
      });
      expect(result.expired.map((entry) => entry.changeRequestId)).toContain(other.changeId);
      // The failed one rolled back whole: still pending, still holding its reservation.
      expect(await changeRow(stuck.changeId)).toMatchObject({
        status: 'pending_approval',
        reservationActive: true,
      });
      // Worked out when the other expired: the mirror at 20 days (50_000) and the stuck reservation.
      expect(await w.committed()).toBe(50_000 + 26_250);
    } finally {
      await db.execute(
        sql.raw(
          'drop trigger fail_one_change on ad_change_requests; drop function fail_one_change();',
        ),
      );
    }
  });

  it('a failed read of the open requests is logged and does not stop the ingestion cycle', async () => {
    // A database that fails on the first query, the way a dropped connection does.
    const broken = new Proxy({} as Database, {
      get: () => {
        throw new Error('conexão perdida');
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(reportExpiredChanges(broken, NOW)).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('conexão perdida'));
    } finally {
      logged.mockRestore();
    }
  });

  it('leaves executed and rejected requests alone', async () => {
    const w = await world({ a: 1000, b: 1000 });
    const done = await approved(w, 'a', 2000);
    expect(await execute(w, done.changeId)).toMatchObject({ outcome: 'applied' });
    const no = await requested(w, 'b', { kind: 'set_daily_budget', to: 2000 });
    await decide(no.approvalId, 'rejected');

    const expired = (await expireStaleChanges(db, { now: at(100) })).expired;

    const ids = expired.map((entry) => entry.changeRequestId);
    expect(ids).not.toContain(done.changeId);
    expect(ids).not.toContain(no.changeId);
    expect((await changeRow(done.changeId)).status).toBe('executed');
    expect((await changeRow(no.changeId)).status).toBe('rejected');
  });
});
