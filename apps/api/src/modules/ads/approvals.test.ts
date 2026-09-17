import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adApprovalRequests,
  adCampaigns,
  adChangeRequests,
  auditLog,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import {
  DEFAULT_APPROVAL_POLICY,
  decideApproval,
  escalateStaleApprovals,
  evaluateApproval,
  gateChange,
  listOpenApprovals,
  rollingAutoApprovedCents,
  type ApprovalNotification,
  type ApprovalNotifier,
  type ApprovalPolicy,
} from './approvals.js';
import { getPeriodState, openPeriod, reserveChange } from './budget-guard.js';

const CAP = 400_000; // R$4.000,00
const NOW = new Date('2026-09-17T12:00:00.000Z');
const PERIOD = '2026-09-01';

const THRESHOLDS: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, mode: 'thresholds' };

let harness: TestDatabase;
let db: Database;

class RecordingNotifier implements ApprovalNotifier {
  readonly sent: ApprovalNotification[] = [];
  async send(notification: ApprovalNotification): Promise<void> {
    this.sent.push(notification);
  }
}

class FailingNotifier implements ApprovalNotifier {
  async send(): Promise<void> {
    throw new Error('whatsapp gateway unreachable');
  }
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

async function account(): Promise<string> {
  const [row] = await db
    .insert(adAccounts)
    .values({
      platform: 'meta',
      externalId: `act_${randomBytes(4).toString('hex')}`,
      name: 'Wings Matriz',
    })
    .returning({ id: adAccounts.id });
  if (!row) throw new Error('failed');
  await openPeriod(db, {
    adAccountId: row.id,
    periodMonth: PERIOD,
    capCents: CAP,
    usablePercent: 70,
  });
  return row.id;
}

async function campaign(accountId: string, dailyBudgetCents = 0): Promise<string> {
  const [row] = await db
    .insert(adCampaigns)
    .values({
      adAccountId: accountId,
      externalId: `c_${randomBytes(4).toString('hex')}`,
      name: 'Campanha',
      status: 'ACTIVE',
      dailyBudgetCents,
      budgetLevel: dailyBudgetCents > 0 ? 'campaign' : 'none',
    })
    .returning({ id: adCampaigns.id });
  if (!row) throw new Error('failed');
  return row.id;
}

/** Reserves a change so the gate has something real to judge. */
async function reserve(accountId: string, toDailyBudgetCents: number): Promise<string> {
  const campaignId = await campaign(accountId);
  const result = await reserveChange(db, {
    adAccountId: accountId,
    campaignId,
    kind: 'set_daily_budget',
    toDailyBudgetCents,
    now: NOW,
  });
  if (!result.ok) throw new Error(`reservation refused: ${result.reason}`);
  return result.value.changeRequestId;
}

describe('policy: always (the default)', () => {
  it('requires a decision for every change, however small', async () => {
    const id = await account();
    const verdict = await evaluateApproval(db, { adAccountId: id, amountCents: 100, now: NOW });
    expect(verdict.required).toBe(true);
    if (verdict.required) expect(verdict.trigger).toBe('policy_always');
  });

  it('is what the default policy uses, so nothing executes unapproved', () => {
    expect(DEFAULT_APPROVAL_POLICY.mode).toBe('always');
  });
});

describe('policy: thresholds', () => {
  it('lets a small change through without a person', async () => {
    const id = await account();
    const verdict = await evaluateApproval(db, {
      adAccountId: id,
      amountCents: 40_000, // R$400,00
      now: NOW,
      policy: THRESHOLDS,
    });
    expect(verdict.required).toBe(false);
  });

  it('demands a decision above the single-change limit', async () => {
    const id = await account();
    const verdict = await evaluateApproval(db, {
      adAccountId: id,
      amountCents: 50_001, // one cent over R$500,00
      now: NOW,
      policy: THRESHOLDS,
    });
    expect(verdict.required).toBe(true);
    if (verdict.required) expect(verdict.trigger).toBe('above_single_threshold');
  });

  it('closes the death-by-a-thousand-small-changes gap', async () => {
    const id = await account();
    const campaignId = await campaign(id);

    // Five auto-approved changes of R$450 each: R$2.250 in a day, each one
    // individually under the R$500 limit.
    for (let i = 0; i < 5; i++) {
      const [row] = await db
        .insert(adChangeRequests)
        .values({
          adAccountId: id,
          campaignId,
          budgetPeriodId: (await getPeriodState(db, id, PERIOD))?.id ?? '',
          kind: 'set_daily_budget',
          fromValueCents: 0,
          toValueCents: 1000,
          exposureDeltaCents: 45_000,
          payloadHash: `hash-${i}`,
          status: 'approved',
          autoApproved: true,
          createdAt: new Date(NOW.getTime() - i * 3600_000),
        })
        .returning({ id: adChangeRequests.id });
      expect(row).toBeDefined();
    }

    const rolling = await rollingAutoApprovedCents(db, id, NOW);
    expect(rolling).toBe(225_000);

    const verdict = await evaluateApproval(db, {
      adAccountId: id,
      amountCents: 10_000, // R$100,00 — small, but the day is already big
      now: NOW,
      policy: THRESHOLDS,
    });
    expect(verdict.required).toBe(true);
    if (verdict.required) expect(verdict.trigger).toBe('cumulative_24h');
  });

  it('forgets changes older than the 24h window', async () => {
    const id = await account();
    const campaignId = await campaign(id);
    await db.insert(adChangeRequests).values({
      adAccountId: id,
      campaignId,
      budgetPeriodId: (await getPeriodState(db, id, PERIOD))?.id ?? '',
      kind: 'set_daily_budget',
      exposureDeltaCents: 300_000,
      payloadHash: 'old',
      status: 'approved',
      autoApproved: true,
      createdAt: new Date(NOW.getTime() - 25 * 3600_000),
    });

    expect(await rollingAutoApprovedCents(db, id, NOW)).toBe(0);
  });
});

describe('the gate', () => {
  it('creates a pending approval and notifies', async () => {
    const id = await account();
    const changeId = await reserve(id, 2000);
    const notifier = new RecordingNotifier();

    const result = await gateChange(db, { changeRequestId: changeId, notifier, now: NOW });

    expect(result.status).toBe('pending_approval');
    expect(result.trigger).toBe('policy_always');
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.kind).toBe('requested');

    const stored = await db.query.adApprovalRequests.findFirst({
      where: eq(adApprovalRequests.changeRequestId, changeId),
    });
    expect(stored?.status).toBe('pending');
    expect(stored?.notifiedAt).toBeTruthy();
  });

  it('keeps the change pending when the notification fails', async () => {
    const id = await account();
    const changeId = await reserve(id, 2000);

    const result = await gateChange(db, {
      changeRequestId: changeId,
      notifier: new FailingNotifier(),
      now: NOW,
    });

    // A broken notification channel must never look like consent.
    expect(result.status).toBe('pending_approval');
    const stored = await db.query.adApprovalRequests.findFirst({
      where: eq(adApprovalRequests.changeRequestId, changeId),
    });
    expect(stored?.status).toBe('pending');
    expect(stored?.notificationError).toMatch(/unreachable/);
  });

  it('auto-approves under the threshold policy, and records it', async () => {
    const id = await account();
    const changeId = await reserve(id, 500); // R$5,00/day — tiny
    const result = await gateChange(db, {
      changeRequestId: changeId,
      policy: THRESHOLDS,
      now: NOW,
    });

    expect(result.status).toBe('auto_approved');
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeId),
    });
    expect(change?.autoApproved).toBe(true);
    expect(change?.status).toBe('approved');
  });
});

describe('decisions', () => {
  it('lets Admin Master approve', async () => {
    const id = await account();
    const changeId = await reserve(id, 2000);
    const gate = await gateChange(db, { changeRequestId: changeId, now: NOW });
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });

    const decision = await decideApproval(db, {
      approvalId: gate.approvalId ?? '',
      approverEmployeeId: admin.id,
      decision: 'approved',
      now: NOW,
    });

    expect(decision).toEqual({ ok: true, status: 'approved' });
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeId),
    });
    expect(change?.status).toBe('approved');
    // Approving does NOT execute anything: that is a later stage.
    expect(change?.executedAt).toBeNull();
  });

  it('lets Diretoria approve too', async () => {
    const id = await account();
    const gate = await gateChange(db, { changeRequestId: await reserve(id, 2000), now: NOW });
    const diretor = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });

    const decision = await decideApproval(db, {
      approvalId: gate.approvalId ?? '',
      approverEmployeeId: diretor.id,
      decision: 'approved',
      now: NOW,
    });
    expect(decision.ok).toBe(true);
  });

  it('refuses anybody else, including a sector manager', async () => {
    const id = await account();
    const gate = await gateChange(db, { changeRequestId: await reserve(id, 2000), now: NOW });
    const manager = await createEmployee(db, {
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
    });

    const decision = await decideApproval(db, {
      approvalId: gate.approvalId ?? '',
      approverEmployeeId: manager.id,
      decision: 'approved',
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('approver_not_allowed');
  });

  it('frees the reserved budget when rejected', async () => {
    const id = await account();
    const changeId = await reserve(id, 2000);
    const before = await getPeriodState(db, id, PERIOD);
    const gate = await gateChange(db, { changeRequestId: changeId, now: NOW });
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });

    await decideApproval(db, {
      approvalId: gate.approvalId ?? '',
      approverEmployeeId: admin.id,
      decision: 'rejected',
      reason: 'fora da estratégia do mês',
      now: NOW,
    });

    const after = await getPeriodState(db, id, PERIOD);
    expect(before?.committedCents).toBeGreaterThan(0);
    expect(after?.committedCents).toBe(0);
  });

  it('cannot be decided twice', async () => {
    const id = await account();
    const gate = await gateChange(db, { changeRequestId: await reserve(id, 2000), now: NOW });
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });

    await decideApproval(db, {
      approvalId: gate.approvalId ?? '',
      approverEmployeeId: admin.id,
      decision: 'approved',
      now: NOW,
    });
    const second = await decideApproval(db, {
      approvalId: gate.approvalId ?? '',
      approverEmployeeId: admin.id,
      decision: 'rejected',
      now: NOW,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_decided');
  });

  it('voids an approval whose change drifted', async () => {
    const id = await account();
    const changeId = await reserve(id, 2000);
    const gate = await gateChange(db, { changeRequestId: changeId, now: NOW });
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });

    // The underlying change is altered after approval was sought.
    await db
      .update(adChangeRequests)
      .set({ payloadHash: 'something-else', toValueCents: 999_999 })
      .where(eq(adChangeRequests.id, changeId));

    const decision = await decideApproval(db, {
      approvalId: gate.approvalId ?? '',
      approverEmployeeId: admin.id,
      decision: 'approved',
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('payload_changed');
  });

  it('audits every decision', async () => {
    const id = await account();
    const gate = await gateChange(db, { changeRequestId: await reserve(id, 2000), now: NOW });
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });

    await decideApproval(db, {
      approvalId: gate.approvalId ?? '',
      approverEmployeeId: admin.id,
      decision: 'approved',
      reason: 'dentro do plano',
      now: NOW,
      ip: '203.0.113.10',
    });

    const entries = await db.query.auditLog.findMany({
      where: eq(auditLog.actorEmployeeId, admin.id),
    });
    expect(entries.some((entry) => entry.action === 'ads.approval_granted')).toBe(true);
  });
});

describe('escalation after 4 hours', () => {
  it('escalates to Diretoria instead of expiring or executing', async () => {
    const id = await account();
    const changeId = await reserve(id, 2000);
    const gate = await gateChange(db, { changeRequestId: changeId, now: NOW });
    const notifier = new RecordingNotifier();

    const later = new Date(NOW.getTime() + 4 * 3600_000 + 60_000);
    const escalated = await escalateStaleApprovals(db, { notifier, now: later });

    expect(escalated).toContain(gate.approvalId);
    const stored = await db.query.adApprovalRequests.findFirst({
      where: eq(adApprovalRequests.id, gate.approvalId ?? ''),
    });
    expect(stored?.status).toBe('escalated');
    expect(stored?.escalatedAt).toBeTruthy();
    // Crucially: still undecided, and the change has NOT become executable.
    expect(stored?.decidedAt).toBeNull();
    const change = await db.query.adChangeRequests.findFirst({
      where: eq(adChangeRequests.id, changeId),
    });
    expect(change?.status).toBe('pending_approval');
    expect(notifier.sent.some((n) => n.kind === 'escalated')).toBe(true);
  });

  it('leaves a fresh request alone', async () => {
    const id = await account();
    const gate = await gateChange(db, { changeRequestId: await reserve(id, 2000), now: NOW });

    const escalated = await escalateStaleApprovals(db, {
      now: new Date(NOW.getTime() + 60 * 60_000),
    });
    expect(escalated).not.toContain(gate.approvalId);
  });

  it('still accepts a decision after escalation', async () => {
    const id = await account();
    const gate = await gateChange(db, { changeRequestId: await reserve(id, 2000), now: NOW });
    await escalateStaleApprovals(db, { now: new Date(NOW.getTime() + 5 * 3600_000) });
    const diretor = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });

    const decision = await decideApproval(db, {
      approvalId: gate.approvalId ?? '',
      approverEmployeeId: diretor.id,
      decision: 'approved',
      now: new Date(NOW.getTime() + 6 * 3600_000),
    });
    expect(decision.ok).toBe(true);
  });

  it('lists what is still waiting, oldest first', async () => {
    const id = await account();
    await gateChange(db, { changeRequestId: await reserve(id, 2000), now: NOW });
    await gateChange(db, {
      changeRequestId: await reserve(id, 1000),
      now: new Date(NOW.getTime() + 60_000),
    });

    const open = await listOpenApprovals(db, id);
    expect(open.length).toBeGreaterThanOrEqual(2);
    expect(open[0]?.requestedAt.getTime()).toBeLessThanOrEqual(open[1]?.requestedAt.getTime() ?? 0);
  });
});
