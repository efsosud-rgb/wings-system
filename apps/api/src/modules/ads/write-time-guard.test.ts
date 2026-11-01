import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adApprovalRequests,
  adCampaigns,
  adChangeRequests,
  adGuardrailEvents,
  auditLog,
  budgetPeriods,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { decideApproval, gateChange } from './approvals.js';
import { openPeriod, reserveChange } from './budget-guard.js';
import { executeApprovedChange } from './executor.js';
import { expireStaleChanges } from './expiry.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';
import { reconcileAccount } from './reconcile.js';

/**
 * Travas de verba, part 1: the executor judges the change's own delta at the
 * instant of the write, decisions cannot both win, and old requests expire.
 *
 * Fixed clock (lesson 2): 10/11/2026, 12:00 in São Paulo, 21 days left in the
 * month counting today. On Meta a daily budget of B costs B × 21 × 1.25 =
 * 26.25 B for the rest of the month, so R$ 10/dia (1000) is 26_250.
 */
const NOW = new Date('2026-11-10T15:00:00Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
// Usable = 70% of the cap = 210_000: exactly a R$ 80/dia campaign (8000 × 26.25).
const CAP = 300_000;
const USABLE = 210_000;

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

interface World {
  accountId: string;
  client: FakeMetaClient;
  campaign: (externalId: string) => Promise<string>;
  committed: () => Promise<number>;
  reconcile: () => Promise<void>;
  budgetWrites: () => string[];
}

/** An account mirrored from a (live-looking) fake, reconciled at NOW. */
async function world(budgets: Record<string, number>): Promise<World> {
  const externalAccountId = `act_${randomBytes(4).toString('hex')}`;
  const client = new FakeMetaClient({
    accountId: externalAccountId,
    now: () => NOW,
    campaigns: Object.entries(budgets).map(([id, dailyBudgetCents]) => ({
      id,
      name: `Campanha ${id}`,
      status: 'ACTIVE' as const,
      dailyBudgetCents,
    })),
  });
  // The executor refuses anything that is not live.
  Object.defineProperty(client, 'isLive', { value: true });

  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId: externalAccountId, name: 'Conta de teste' })
    .returning({ id: adAccounts.id });
  if (!account) throw new Error('failed');
  await openPeriod(db, {
    adAccountId: account.id,
    periodMonth: '2026-11-01',
    capCents: CAP,
    usablePercent: 70,
  });

  const reconcile = async () => {
    await reconcileAccount(db, client, account.id, NOW);
  };
  await reconcile();

  return {
    accountId: account.id,
    client,
    reconcile,
    campaign: async (externalId) => {
      const row = await db.query.adCampaigns.findFirst({
        where: and(eq(adCampaigns.adAccountId, account.id), eq(adCampaigns.externalId, externalId)),
      });
      if (!row) throw new Error(`campaign ${externalId} not mirrored`);
      return row.id;
    },
    committed: async () => {
      const period = await db.query.budgetPeriods.findFirst({
        where: eq(budgetPeriods.adAccountId, account.id),
      });
      return period?.committedCents ?? -1;
    },
    budgetWrites: () =>
      client.calls
        .filter((call) => call.method === 'setDailyBudget' || call.method === 'pauseCampaign')
        .map((call) => String(call.args[0])),
  };
}

/** Requested and put in front of an approver; returns the change and approval ids. */
async function requested(
  w: World,
  externalId: string,
  change: { kind: 'set_daily_budget'; to: number } | { kind: 'pause_campaign' },
  now = NOW,
) {
  const reserved = await reserveChange(db, {
    adAccountId: w.accountId,
    campaignId: await w.campaign(externalId),
    kind: change.kind,
    toDailyBudgetCents: change.kind === 'set_daily_budget' ? change.to : undefined,
    now,
  });
  if (!reserved.ok) throw new Error(`reservation refused: ${reserved.reason}`);
  // The row's created_at comes from the database clock; the test's clock is fixed.
  await db
    .update(adChangeRequests)
    .set({ createdAt: now })
    .where(eq(adChangeRequests.id, reserved.value.changeRequestId));
  const gate = await gateChange(db, { changeRequestId: reserved.value.changeRequestId, now });
  return { changeId: reserved.value.changeRequestId, approvalId: gate.approvalId ?? '' };
}

async function decide(approvalId: string, decision: 'approved' | 'rejected', now = NOW) {
  return decideApproval(db, { approvalId, approverEmployeeId: approverId, decision, now });
}

async function approved(w: World, externalId: string, to: number, now = NOW) {
  const ids = await requested(w, externalId, { kind: 'set_daily_budget', to }, now);
  const decision = await decide(ids.approvalId, 'approved', now);
  if (!decision.ok) throw new Error(`approval failed: ${decision.reason}`);
  return ids;
}

function execute(w: World, changeId: string, now = NOW) {
  return executeApprovedChange(db, w.client, changeId, { allowWrites: true, now });
}

async function changeRow(changeId: string) {
  const row = await db.query.adChangeRequests.findFirst({
    where: eq(adChangeRequests.id, changeId),
  });
  if (!row) throw new Error('change not found');
  return row;
}

/**
 * Two increases that each fit alone. A is reserved; the 15-minute
 * reconciliation then rewrites the commitment from the platform and wipes A
 * (T-1, fixed in part 2); B is reserved on top of the wiped figure. Both are
 * approved. Base: two campaigns at R$ 10/dia = 52_500.
 */
async function twoIncreasesAcrossAReconciliation(bTo: number) {
  const w = await world({ a: 1000, b: 1000 });
  const a = await approved(w, 'a', 4000); // +78_750 → 131_250 once applied
  await w.reconcile();
  expect(await w.committed()).toBe(52_500); // A's reservation is gone (T-1)
  const b = await approved(w, 'b', bTo);
  return { w, a, b };
}

describe('the executor judges the change’s own delta at the instant of the write', () => {
  it('lets the second increase out when the month ends exactly at the ceiling', async () => {
    // B to R$ 40/dia: +78_750, so 131_250 + 78_750 = 210_000 = usable.
    const { w, a, b } = await twoIncreasesAcrossAReconciliation(4000);

    expect(await execute(w, a.changeId)).toMatchObject({ outcome: 'applied' });
    expect(await execute(w, b.changeId)).toMatchObject({ outcome: 'applied' });
    expect(w.budgetWrites()).toEqual(['a', 'b']);
  });

  it('refuses the second increase when it would pass the ceiling, and sends nothing', async () => {
    // B to R$ 40,01/dia: 131_250 + 78_776 = 210_026 > 210_000. Before this
    // change the executor only compared the stored commitment (52_500 +
    // 78_776) with the ceiling, and both writes went out.
    const { w, a, b } = await twoIncreasesAcrossAReconciliation(4001);

    expect(await execute(w, a.changeId)).toMatchObject({ outcome: 'applied' });
    const second = await execute(w, b.changeId);

    expect(second).toMatchObject({ outcome: 'refused', reason: 'cap_no_longer_allows' });
    expect(w.budgetWrites()).toEqual(['a']);
    // A refusal changes nothing: B stays approved, ready for when there is room.
    expect(await changeRow(b.changeId)).toMatchObject({
      status: 'approved',
      reservationActive: true,
    });
    const events = await db.query.adGuardrailEvents.findMany({
      where: eq(adGuardrailEvents.adAccountId, w.accountId),
    });
    expect(
      events.some(
        (event) =>
          event.kind === 'usable_would_be_exceeded' &&
          (event.detail as Record<string, unknown>).stage === 'execution',
      ),
    ).toBe(true);
  });

  it('lets only one of two simultaneous executions out when they only fit alone', async () => {
    const { w, a, b } = await twoIncreasesAcrossAReconciliation(5000);

    const results = await Promise.all([execute(w, a.changeId), execute(w, b.changeId)]);

    const applied = results.filter((result) => result.outcome === 'applied');
    const refused = results.filter(
      (result) => result.outcome === 'refused' && result.reason === 'cap_no_longer_allows',
    );
    expect(applied).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(w.budgetWrites()).toHaveLength(1);
  });

  it('refuses an approved change that no longer holds its reservation', async () => {
    const w = await world({ a: 1000 });
    const a = await approved(w, 'a', 2000);
    // The state the approve/reject race (T-4) used to leave behind.
    await db
      .update(adChangeRequests)
      .set({ reservationActive: false })
      .where(eq(adChangeRequests.id, a.changeId));

    expect(await execute(w, a.changeId)).toMatchObject({
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

  it('rejecting a pause whose space was used freezes the account instead of failing (T-5)', async () => {
    const w = await world({ a: 4000, b: 4000 }); // 210_000
    const pause = await requested(w, 'a', { kind: 'pause_campaign' }); // committed 105_000
    await approved(w, 'b', 8000); // +105_000 → 210_000 again, on space the pause only promised

    const rejected = await decide(pause.approvalId, 'rejected');

    expect(rejected).toMatchObject({ ok: true, status: 'rejected' });
    expect(await changeRow(pause.changeId)).toMatchObject({
      status: 'rejected',
      reservationActive: false,
    });
    expect(await w.committed()).toBe(USABLE); // recorded at the ceiling, not past it
    const account = await db.query.adAccounts.findFirst({
      where: eq(adAccounts.id, w.accountId),
    });
    expect(account?.killSwitchEngaged).toBe(true);
  });
});

describe('one decision wins', () => {
  it('approve and reject at the same instant: exactly one is recorded', async () => {
    const w = await world({ a: 1000 });
    const ids = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 });

    const results = await Promise.all([
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
    const audits = await db.query.auditLog.findMany({
      where: eq(auditLog.entityId, ids.approvalId),
    });
    expect(
      audits.filter((entry) =>
        ['ads.approval_granted', 'ads.approval_rejected'].includes(entry.action),
      ),
    ).toHaveLength(1);
  });

  it('approve and expire at the same instant: exactly one wins', async () => {
    const w = await world({ a: 1000 });
    const ids = await requested(w, 'a', { kind: 'set_daily_budget', to: 2000 });

    const [decision, expired] = await Promise.all([
      decide(ids.approvalId, 'approved', at(25)),
      expireStaleChanges(db, { now: at(25) }),
    ]);

    const change = await changeRow(ids.changeId);
    const expiredThis = expired.expired.some((entry) => entry.changeRequestId === ids.changeId);
    expect(decision.ok).toBe(!expiredThis);
    expect(change.status).toBe(expiredThis ? 'expired' : 'approved');
    expect(change.reservationActive).toBe(!expiredThis);
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
    expect(await w.committed()).toBe(26_250);
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
    expect(await w.committed()).toBe(26_250);
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

  it('gives back an expired reduction without breaking on the ceiling', async () => {
    const w = await world({ a: 4000, b: 4000 }); // 210_000
    const pause = await requested(w, 'a', { kind: 'pause_campaign' }); // 105_000
    const raise = await approved(w, 'b', 8000, at(10)); // 210_000 again; its own day runs to at(34)

    const expired = (await expireStaleChanges(db, { now: at(25) })).expired;

    expect(expired).toContainEqual(
      expect.objectContaining({ changeRequestId: pause.changeId, why: 'age' }),
    );
    expect(await changeRow(pause.changeId)).toMatchObject({ status: 'expired' });
    expect(await changeRow(raise.changeId)).toMatchObject({ status: 'approved' });
    expect(await w.committed()).toBe(USABLE);
    const account = await db.query.adAccounts.findFirst({
      where: eq(adAccounts.id, w.accountId),
    });
    expect(account?.killSwitchEngaged).toBe(true);
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
      expect(await w.committed()).toBe(52_500 + 26_250);
    } finally {
      await db.execute(
        sql.raw(
          'drop trigger fail_one_change on ad_change_requests; drop function fail_one_change();',
        ),
      );
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
