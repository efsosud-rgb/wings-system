import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { adAccounts, adCampaigns, adChangeRequests, budgetPeriods } from '../../db/schema/index.js';
import { decideApproval, gateChange } from './approvals.js';
import { openPeriod, reserveChange } from './budget-guard.js';
import { executeApprovedChange } from './executor.js';
import { FakeMetaClient } from './platform/fake-meta-client.js';
import { reconcileAccount } from './reconcile.js';

/**
 * The world of the write-time guard tests (write-time-guard*.test.ts).
 *
 * Fixed clock (lesson 2): 10/11/2026, 12:00 in São Paulo, 21 days left in the
 * month counting today. On Meta a daily budget of B costs B × 21 × 1.25 =
 * 26.25 B for the rest of the month, so R$ 10/dia (1000) is 26_250.
 */
export const NOW = new Date('2026-11-10T15:00:00Z');
const HOUR = 3_600_000;
export const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
// Usable = 70% of the cap = 210_000: exactly a R$ 80/dia campaign (8000 × 26.25).
export const CAP = 300_000;
export const USABLE = 210_000;

export interface World {
  accountId: string;
  client: FakeMetaClient;
  campaign: (externalId: string) => Promise<string>;
  committed: () => Promise<number>;
  periodId: () => Promise<string>;
  reconcile: (now: Date) => Promise<void>;
  budgetWrites: () => string[];
}

/** The test file's database and approver, read when each helper runs (they are set in beforeAll). */
export function guardFixtures(context: () => { db: Database; approverId: string }) {
  const period = async (accountId: string) => {
    const row = await context().db.query.budgetPeriods.findFirst({
      where: eq(budgetPeriods.adAccountId, accountId),
    });
    if (!row) throw new Error('period not found');
    return row;
  };

  /** An account mirrored from a (live-looking) fake, reconciled at NOW. */
  async function world(budgets: Record<string, number>): Promise<World> {
    const { db } = context();
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

    const reconcile = async (now: Date) => {
      await reconcileAccount(db, client, account.id, now);
    };
    // Half an hour before the requests: what they reserve comes after it.
    await reconcile(at(-0.5));

    return {
      accountId: account.id,
      client,
      reconcile,
      campaign: async (externalId) => {
        const row = await db.query.adCampaigns.findFirst({
          where: and(
            eq(adCampaigns.adAccountId, account.id),
            eq(adCampaigns.externalId, externalId),
          ),
        });
        if (!row) throw new Error(`campaign ${externalId} not mirrored`);
        return row.id;
      },
      committed: async () => (await period(account.id)).committedCents,
      periodId: async () => (await period(account.id)).id,
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
    const { db } = context();
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
    const { db, approverId } = context();
    return decideApproval(db, { approvalId, approverEmployeeId: approverId, decision, now });
  }

  async function approved(w: World, externalId: string, to: number, now = NOW) {
    const ids = await requested(w, externalId, { kind: 'set_daily_budget', to }, now);
    const decision = await decide(ids.approvalId, 'approved', now);
    if (!decision.ok) throw new Error(`approval failed: ${decision.reason}`);
    return ids;
  }

  function execute(w: World, changeId: string, now = NOW) {
    return executeApprovedChange(context().db, w.client, changeId, { allowWrites: true, now });
  }

  async function changeRow(changeId: string) {
    const row = await context().db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeId),
    });
    if (!row) throw new Error('change not found');
    return row;
  }

  /**
   * Two increases across a reconciliation. A is reserved; the 15-minute
   * reconciliation then works the commitment out again, and A stays in it
   * (T-1, part 2: it used to be wiped); B is judged on top of A. Both are
   * approved. Base: two campaigns at R$ 10/dia = 52_500. `bTo` must fit with
   * A, or the request for B is refused and this throws.
   */
  async function twoIncreasesAcrossAReconciliation(bTo: number) {
    const w = await world({ a: 1000, b: 1000 });
    const a = await approved(w, 'a', 4000); // +78_750 → 131_250
    await w.reconcile(at(0.25));
    const kept = await w.committed();
    if (kept !== 131_250) throw new Error(`expected 131_250 after the reconcile, got ${kept}`);
    const b = await approved(w, 'b', bTo, at(0.5));
    return { w, a, b };
  }

  /**
   * Waits until `count` other sessions of this database are blocked on a lock
   * (a row lock or an advisory lock): the moment every racer is parked at the
   * same line, so none of them has gone past it.
   */
  async function lockWaiters(count: number, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await context().db.execute<{ waiting: string } & Record<string, unknown>>(sql`
        select count(*)::text as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'
      `);
      if (Number(result.rows[0]?.waiting ?? 0) >= count) return;
      if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions ever waited`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Holds the period row (`FOR UPDATE`) while `start` launches the racers, and
   * lets go only once `racers` of them are queued behind it. Every racer has
   * then done all its reads before any of them writes: the closest a test gets
   * to two clicks in the same millisecond.
   */
  async function raceBehindThePeriod<T>(
    w: World,
    racers: number,
    start: () => Promise<T>[],
  ): Promise<T[]> {
    const periodId = await w.periodId();
    let runs: Promise<T>[] = [];
    await context().db.transaction(async (tx) => {
      await tx.execute(sql`select id from ad_budget_periods where id = ${periodId} for update`);
      runs = start();
      await lockWaiters(racers);
    });
    return Promise.all(runs);
  }

  return {
    world,
    requested,
    decide,
    approved,
    execute,
    changeRow,
    twoIncreasesAcrossAReconciliation,
    lockWaiters,
    raceBehindThePeriod,
  };
}
