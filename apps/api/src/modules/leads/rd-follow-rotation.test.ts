import { WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  crmDistributionMembers,
  crmNotifications,
  leadEvents,
  leadTasks,
  leads,
  rdUserMap,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import {
  importRdDeals,
  rdOwnerAllowlist,
  undoRdImportBatch,
  type RdContactRow,
  type RdCrmReader,
  type RdDealRow,
  type RdPipelineRow,
} from './rd-import.js';
import { STALE_ARRIVAL_HOURS, upsertLead } from './service.js';

/**
 * The hourly RD follow-up (`distributeNew`): the new, recent, open deals with
 * no owner from RD join the funnel's rotation, with the first-contact task and
 * the "Novo lead para você" notice. Everything else is left as RD says.
 */

let harness: TestDatabase;
let db: Database;
let keeperId: string;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const keeper = await createEmployee(db, { role: 'vendedor_expansao' });
  keeperId = keeper.id;
  await db
    .insert(rdUserMap)
    .values({ rdUserId: 'rd-keep', rdName: 'Dono liberado', employeeId: keeper.id });
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const PIPELINES: RdPipelineRow[] = [
  { name: 'Formatação', deal_stages: [{ id: 'f1', name: 'Sem contato' }] },
  { name: 'Expansão', deal_stages: [{ id: 'e1', name: 'Novo Contato' }] },
  { name: 'Consultoria', deal_stages: [{ id: 'c1', name: 'Novo' }] },
  { name: 'Negócios perdidos - Formatação', deal_stages: [{ id: 'x1', name: 'Com motivo' }] },
];

const HOUR = 3_600_000;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

let counter = 0;
/** A fictional deal with its own contact (phone and e-mail on example.com). */
function newDeal(stage: string, overrides: Partial<RdDealRow> = {}) {
  counter += 1;
  const id = `deal-${counter}`;
  const contact: RdContactRow = {
    id: `contact-${counter}`,
    name: `Pessoa ${counter}`,
    emails: [{ email: `pessoa${counter}@example.com` }],
    phones: [{ phone: `(11) 94${String(counter).padStart(3, '0')}-0001` }],
  };
  const deal: RdDealRow = {
    id,
    win: null,
    created_at: hoursAgo(1),
    deal_stage: { id: stage },
    contacts: [contact],
    ...overrides,
  };
  return { id, deal, contact };
}

function fakeRd(deals: RdDealRow[]): RdCrmReader {
  return {
    pipelines: async () => PIPELINES,
    users: async () => [],
    deals: async () => deals,
    dealContacts: async () => [],
    deal: async () => ({}),
  };
}

/** One hourly cycle, as ingest-cli runs it (the only caller that asks to distribute). */
const follow = (deals: RdDealRow[], options: { distributeNew?: boolean } = {}) =>
  importRdDeals(db, fakeRd(deals), {
    apply: true,
    since: new Date(Date.now() - 3 * 24 * HOUR),
    window: { since: new Date(Date.now() - 3 * 24 * HOUR), until: new Date() },
    histories: false,
    onlyMissing: true,
    ownerRdUserIds: rdOwnerAllowlist('rd-keep'),
    batchId: `rd-crm-sync-test-${counter}`,
    distributeNew: options.distributeNew ?? true,
  });

async function setRotation(pipeline: 'formatacao' | 'expansao', employeeIds: string[]) {
  await db.delete(crmDistributionMembers).where(eq(crmDistributionMembers.pipeline, pipeline));
  // One statement each, so every member has its own updatedAt.
  for (const employeeId of employeeIds)
    await db.insert(crmDistributionMembers).values({ pipeline, employeeId, active: true });
}

const leadOf = (dealId: string) => db.query.leads.findFirst({ where: eq(leads.rdDealId, dealId) });
const noticesOf = (leadId: string) =>
  db.select().from(crmNotifications).where(eq(crmNotifications.leadId, leadId));
const tasksOf = (leadId: string) => db.select().from(leadTasks).where(eq(leadTasks.leadId, leadId));
const eventsOf = (leadId: string) =>
  db.select().from(leadEvents).where(eq(leadEvents.leadId, leadId));
const eventKinds = async (leadId: string) => (await eventsOf(leadId)).map((e) => e.kind);
const rotationClock = async () =>
  (await db.select().from(crmDistributionMembers))
    .map((m) => `${m.pipeline}:${m.employeeId}:${m.lastAssignedAt?.toISOString() ?? '-'}`)
    .sort();

describe('the RD follow-up gives new recent deals to the rotation', () => {
  let sellerA: string;
  let sellerB: string;
  let board: string;

  beforeAll(async () => {
    sellerA = (await createEmployee(db, { role: 'vendedor_formatacao' })).id;
    sellerB = (await createEmployee(db, { role: 'vendedor_formatacao' })).id;
    board = (await createEmployee(db, { role: 'diretoria', sector: 'diretoria' })).id;
  });

  beforeEach(async () => {
    await setRotation('formatacao', [sellerA, sellerB]);
    await setRotation('expansao', [sellerA]);
  });

  it('alternates new Formatação deals between two members, with task, event and notice', async () => {
    const deals = [
      newDeal('f1', { created_at: hoursAgo(3) }),
      newDeal('f1', { created_at: hoursAgo(2) }),
      newDeal('f1', { created_at: hoursAgo(1) }),
    ];
    const result = await follow(deals.map((d) => d.deal));
    expect(result).toMatchObject({
      created: 3,
      rotation: { assigned: 3, empty: 0 },
      failed: 0,
    });

    const rows = await Promise.all(deals.map((d) => leadOf(d.id)));
    const owners = rows.map((row) => row?.ownerEmployeeId);
    expect(new Set(owners)).toEqual(new Set([sellerA, sellerB]));
    expect(owners[1]).not.toBe(owners[0]);
    expect(owners[2]).toBe(owners[0]);

    for (const row of rows) {
      // Born from the RD copy: still run by RD's follow-up, its stage mirrored.
      expect(row).toMatchObject({
        source: 'rd_crm',
        managedBy: 'rd',
        pipeline: 'formatacao',
        stage: 'Sem contato',
        won: null,
      });
      const tasks = await tasksOf(row!.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        kind: 'first_contact',
        assigneeEmployeeId: row!.ownerEmployeeId,
      });
      const kinds = await eventKinds(row!.id);
      expect(kinds.filter((kind) => kind === 'lead.owner_changed')).toHaveLength(1);
      const notices = await noticesOf(row!.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        recipientEmployeeId: row!.ownerEmployeeId,
        kind: 'new_lead',
      });
      expect(notices[0]?.message).toMatch(/^Novo lead para você\./);
      expect(notices[0]?.message).toContain('1 hora útil');
      expect(notices[0]?.message).not.toContain('Pessoa');
    }

    const ownerEvent = (await eventsOf(rows[0]!.id)).find(
      (event) => event.kind === 'lead.owner_changed',
    );
    expect(ownerEvent?.detail).toEqual({ from: null, to: owners[0], source: 'rotation' });
  });

  it('gives every Expansão deal to the only member of its rotation', async () => {
    const deals = [newDeal('e1'), newDeal('e1'), newDeal('e1')];
    const result = await follow(deals.map((d) => d.deal));
    expect(result.rotation).toEqual({ assigned: 3, empty: 0 });
    for (const d of deals) {
      expect(await leadOf(d.id)).toMatchObject({ ownerEmployeeId: sellerA, pipeline: 'expansao' });
    }
  });

  it('leaves out a deal 5 days old, a closed one, an archived one, a test one and a Consultoria one', async () => {
    const old = newDeal('f1', { created_at: hoursAgo(5 * 24) });
    const justOver = newDeal('f1', { created_at: hoursAgo(STALE_ARRIVAL_HOURS + 1) });
    const lost = newDeal('f1', { win: false, deal_lost_reason: { name: 'Preço' } });
    const won = newDeal('f1', { win: true });
    const archived = newDeal('x1');
    const testName = newDeal('f1', { name: 'Teste X' });
    const testEmail = newDeal('f1');
    testEmail.contact.emails = [{ email: 'teste@example.com' }];
    const consulting = newDeal('c1');
    const before = await rotationClock();

    const result = await follow(
      [old, justOver, lost, won, archived, testName, testEmail, consulting].map((d) => d.deal),
    );
    expect(result.rotation).toEqual({ assigned: 0, empty: 0 });
    expect(result.testDeals).toBe(2);
    expect(await rotationClock()).toEqual(before);

    for (const d of [old, justOver, lost, won, archived, consulting]) {
      const row = await leadOf(d.id);
      expect(row, d.id).toBeTruthy();
      expect(row?.ownerEmployeeId, d.id).toBeNull();
      expect(await tasksOf(row!.id), d.id).toEqual([]);
      expect(await noticesOf(row!.id), d.id).toEqual([]);
      expect(await eventKinds(row!.id), d.id).not.toContain('lead.owner_changed');
    }
    // A test deal is not even a lead.
    expect(await leadOf(testName.id)).toBeUndefined();
    expect(await leadOf(testEmail.id)).toBeUndefined();
  });

  it('lets a listed RD owner keep the deal, outside the rotation', async () => {
    const owned = newDeal('f1', { user: { id: 'rd-keep' } });
    const before = await rotationClock();
    const result = await follow([owned.deal]);
    expect(result.rotation).toEqual({ assigned: 0, empty: 0 });
    const row = await leadOf(owned.id);
    expect(row?.ownerEmployeeId).toBe(keeperId);
    expect(await rotationClock()).toEqual(before);
    expect(await eventKinds(row!.id)).not.toContain('lead.owner_changed');
    expect(await tasksOf(row!.id)).toEqual([]);
    expect(await noticesOf(row!.id)).toEqual([]);
  });

  it('with nobody active in the rotation, the lead stays ownerless and the board is told', async () => {
    await db
      .update(crmDistributionMembers)
      .set({ active: false })
      .where(eq(crmDistributionMembers.pipeline, 'formatacao'));
    const born = newDeal('f1');
    const result = await follow([born.deal]);
    expect(result.rotation).toEqual({ assigned: 0, empty: 1 });
    const row = await leadOf(born.id);
    expect(row?.ownerEmployeeId).toBeNull();
    expect(await tasksOf(row!.id)).toEqual([]);
    const notices = await noticesOf(row!.id);
    const toBoard = notices.find((notice) => notice.recipientEmployeeId === board);
    expect(toBoard).toMatchObject({ kind: 'lead_unassigned' });
    expect(notices.every((notice) => notice.kind === 'lead_unassigned')).toBe(true);
    expect(notices.some((notice) => notice.message.includes('Pessoa'))).toBe(false);
    expect(notices.some((notice) => notice.recipientEmployeeId === sellerA)).toBe(false);
  });

  it('running the follow-up twice distributes once', async () => {
    const deals = [newDeal('f1', { created_at: hoursAgo(2) }), newDeal('f1')].map((d) => d.deal);
    const first = await follow(deals);
    expect(first.rotation.assigned).toBe(2);
    const rows = await Promise.all(deals.map((deal) => leadOf(deal.id!)));
    const clock = await rotationClock();
    const owners = rows.map((row) => row?.ownerEmployeeId);

    const second = await follow(deals);
    expect(second).toMatchObject({ created: 0, merged: 0, rotation: { assigned: 0, empty: 0 } });
    expect(await rotationClock()).toEqual(clock);
    for (const [index, row] of rows.entries()) {
      expect((await leadOf(deals[index]!.id!))?.ownerEmployeeId).toBe(owners[index]);
      expect(await tasksOf(row!.id)).toHaveLength(1);
      expect(await noticesOf(row!.id)).toHaveLength(1);
      expect((await eventKinds(row!.id)).filter((k) => k === 'lead.owner_changed')).toHaveLength(1);
    }
  });

  it('undoing the follow-up batch takes a distributed lead back with its task and notice', async () => {
    const born = newDeal('f1');
    await follow([born.deal]);
    const row = await leadOf(born.id);
    expect(row?.ownerEmployeeId).not.toBeNull();
    const batchId = (await eventsOf(row!.id)).find((e) => e.kind === 'lead.imported.rd_crm')
      ?.detail as { batchId: string };
    const undone = await undoRdImportBatch(db, { batchId: batchId.batchId, apply: true });
    expect(undone.created).toBe(1);
    expect(await leadOf(born.id)).toBeUndefined();
    expect(await noticesOf(row!.id)).toEqual([]);
    expect(await tasksOf(row!.id)).toEqual([]);
  });

  it('an import (without distributeNew) still brings the deal in with no owner and no notice', async () => {
    const imported = newDeal('f1');
    const before = await rotationClock();
    const result = await follow([imported.deal], { distributeNew: false });
    expect(result).toMatchObject({ created: 1, rotation: { assigned: 0, empty: 0 } });
    const row = await leadOf(imported.id);
    expect(row?.ownerEmployeeId).toBeNull();
    expect(await rotationClock()).toEqual(before);
    expect(await tasksOf(row!.id)).toEqual([]);
    expect(await noticesOf(row!.id)).toEqual([]);
    expect(await eventKinds(row!.id)).not.toContain('lead.owner_changed');
  });

  it('a deal that joins a lead already there is not distributed', async () => {
    const joined = newDeal('f1');
    const phone = joined.contact.phones![0]!.phone!;
    const existing = await upsertLead(db, {
      source: 'manual',
      phone,
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      skipResearch: true,
      distribute: false,
      event: { kind: 'lead.created_manually' },
    });
    const before = await rotationClock();
    const result = await follow([joined.deal]);
    expect(result).toMatchObject({ created: 0, merged: 1, rotation: { assigned: 0, empty: 0 } });
    expect(await rotationClock()).toEqual(before);
    const row = await db.query.leads.findFirst({ where: eq(leads.id, existing.lead.id) });
    expect(row).toMatchObject({ rdDealId: joined.id, ownerEmployeeId: null });
    expect(await tasksOf(existing.lead.id)).toEqual([]);
    expect(await noticesOf(existing.lead.id)).toEqual([]);
  });
});
