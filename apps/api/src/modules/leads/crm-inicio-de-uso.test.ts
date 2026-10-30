import { WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { crmNotifications, leadTasks } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import {
  boardCounters,
  configureCrm,
  DEFAULT_TRACKING_START,
  ensureFirstContactTask,
  listTasks,
  trackingStartOf,
} from './crm.js';
import { runCrmAlerts } from './crm-alerts.js';
import { salesDashboardOf } from './sales-dashboard.js';
import { upsertLead } from './service.js';

/**
 * Eric, 09/10/2026: the counters, the first-contact task and its overdue alert only count deals that ENTERED
 * since the start of use. The RD history stays as it is and stays out.
 */
let harness: TestDatabase;
let db: Database;

const START = new Date('2026-10-09T03:00:00.000Z');
const BEFORE = new Date('2026-10-08T15:00:00.000Z');
const FAR = new Date(Date.now() + 5 * 86_400_000);

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  configureCrm({ trackingStart: START });
}, 60_000);

afterAll(async () => {
  configureCrm({ trackingStart: DEFAULT_TRACKING_START });
  await harness?.drop();
});

let phone = 5511933330000;
const born = (
  ownerEmployeeId: string,
  enteredAt: Date,
  pipeline: 'expansao' | 'formatacao' = 'expansao',
) =>
  upsertLead(db, {
    source: 'site_form',
    name: 'Teste de Entrada',
    phone: String(phone++),
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    pipeline,
    ownerEmployeeId,
    enteredAt,
    enteredAtSource: 'meta_created_time',
    skipResearch: true,
    event: { kind: 'lead.received.site_form' },
  });

describe('CRM start of use', () => {
  it('the default is the São Paulo midnight of 09/10/2026, and a day maps to its São Paulo midnight', () => {
    expect(DEFAULT_TRACKING_START.toISOString()).toBe('2026-10-09T03:00:00.000Z');
    expect(trackingStartOf('2026-10-09').toISOString()).toBe('2026-10-09T03:00:00.000Z');
  });

  it('gives the first-contact task only to a deal that entered since the start', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const history = await born(seller.id, BEFORE);
    const fresh = await born(seller.id, new Date(START.getTime() + 3_600_000));
    expect(
      await db.query.leadTasks.findFirst({ where: eq(leadTasks.leadId, history.lead.id) }),
    ).toBeUndefined();
    expect(
      await db.query.leadTasks.findFirst({ where: eq(leadTasks.leadId, fresh.lead.id) }),
    ).toMatchObject({
      kind: 'first_contact',
    });
    // Handing the history deal to someone else, or asking again, still makes no task.
    const other = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    await ensureFirstContactTask(db, { id: history.lead.id, ownerEmployeeId: other.id }, null);
    expect(
      await db.query.leadTasks.findFirst({ where: eq(leadTasks.leadId, history.lead.id) }),
    ).toBeUndefined();
  });

  it('counts only new deals in "novas sem contato" and only tracked tasks in "atrasadas"', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    const old = await born(seller.id, BEFORE, 'formatacao');
    const oldWithTask = await born(seller.id, BEFORE, 'formatacao');
    const oldWithFollowUp = await born(seller.id, BEFORE, 'formatacao');
    const fresh = await born(seller.id, new Date(START.getTime() + 60_000), 'formatacao');
    // What was already on staging: first-contact tasks born before the start, on history.
    await db.insert(leadTasks).values({
      leadId: oldWithTask.lead.id,
      kind: 'first_contact',
      title: 'Primeiro contato com o lead',
      dueAt: new Date(BEFORE.getTime() + 3_600_000),
      assigneeEmployeeId: seller.id,
      auto: true,
      createdAt: BEFORE,
    });
    // A person's own follow-up on an old deal is a real commitment and always counts.
    await db.insert(leadTasks).values({
      leadId: oldWithFollowUp.lead.id,
      kind: 'follow_up',
      title: 'Retornar a proposta',
      dueAt: new Date(BEFORE.getTime() + 7_200_000),
      assigneeEmployeeId: seller.id,
    });

    const counters = await boardCounters(db, { pipeline: 'formatacao', now: FAR });
    // Untouched: only the new deal (three history deals are out, however untouched).
    expect(counters.untouched).toBe(1);
    // Overdue: the new deal's first-contact task and the follow-up; the history task is out.
    expect(counters.overdue).toBe(2);
    expect(counters.since).toBe(START.toISOString());
    expect(old.lead.id).not.toBe(fresh.lead.id);

    // The seller's own list agrees.
    const mine = await listTasks(db, {
      assigneeEmployeeId: seller.id,
      status: 'overdue',
      now: FAR,
    });
    expect(mine.map((task) => task.leadId).sort()).toEqual(
      [fresh.lead.id, oldWithFollowUp.lead.id].sort(),
    );
    const open = await listTasks(db, { assigneeEmployeeId: seller.id, status: 'open', now: FAR });
    expect(open.some((task) => task.leadId === oldWithTask.lead.id)).toBe(false);

    // The sales panel's "primeiro contato atrasado" counts the new deal only.
    const board = await salesDashboardOf(db, {
      pipeline: 'formatacao',
      period: 'month',
      now: FAR,
      spendVisible: false,
    });
    expect(board.actions.firstContactOverdue).toBe(1);
  });

  it("raises the overdue alert for new deals and a person's follow-up, never for history", async () => {
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const oldWithTask = await born(seller.id, BEFORE);
    const fresh = await born(seller.id, new Date(START.getTime() + 120_000));
    await db.insert(leadTasks).values({
      leadId: oldWithTask.lead.id,
      kind: 'first_contact',
      title: 'Primeiro contato com o lead',
      dueAt: new Date(BEFORE.getTime() + 3_600_000),
      assigneeEmployeeId: seller.id,
      auto: true,
      createdAt: BEFORE,
    });
    await runCrmAlerts(db, { stageStuckDays: 0 }, FAR);
    const alertsOf = (leadId: string) =>
      db
        .select()
        .from(crmNotifications)
        .where(
          and(
            eq(crmNotifications.leadId, leadId),
            eq(crmNotifications.kind, 'first_contact_overdue'),
          ),
        );
    expect(await alertsOf(oldWithTask.lead.id)).toHaveLength(0);
    expect((await alertsOf(fresh.lead.id)).length).toBeGreaterThan(0);
  });

  it('a by-hand reopen of an old form (force) still gets its task, and that task counts', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const reopened = await born(seller.id, BEFORE);
    expect(
      await db.query.leadTasks.findFirst({ where: eq(leadTasks.leadId, reopened.lead.id) }),
    ).toBeUndefined();
    await ensureFirstContactTask(
      db,
      { id: reopened.lead.id, ownerEmployeeId: seller.id },
      null,
      new Date(),
      {
        force: true,
      },
    );
    expect(
      await db.query.leadTasks.findFirst({ where: eq(leadTasks.leadId, reopened.lead.id) }),
    ).toMatchObject({
      kind: 'first_contact',
    });
    const overdue = await listTasks(db, {
      assigneeEmployeeId: seller.id,
      status: 'overdue',
      now: FAR,
    });
    expect(overdue.map((task) => task.leadId)).toContain(reopened.lead.id);
  });
});
