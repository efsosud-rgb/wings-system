import {
  PROSPECT_DEFAULT_FOLLOW_UP_TITLE,
  PROSPECT_FOLLOW_UP_TITLE,
  PROSPECT_LEAD_STAGE,
  prospectLeadSchema,
  WINGS_CLIENT_ID,
  type Actor,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { crmStages, leads, leadTasks, prospects } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { ensureStage } from '../leads/crm.js';
import { upsertLead } from '../leads/service.js';
import { convertProspect, type ProspectRow } from './service.js';

/**
 * Criar lead from a prospect (t087): the lead lands in Formatação / "Sem contato", owned by who
 * reserved the company (not by whoever clicked), with a follow-up task for that owner, and keeps
 * what the seller confirmed in the form. Made-up companies only.
 */

// A fixed clock: nothing here depends on today's date.
const NOW = new Date('2026-11-04T12:00:00.000Z');
const DAY = 24 * 3_600_000;

let harness: TestDatabase;
let db: Database;
let owner: string;
let manager: Actor;
let seq = 0;

async function reserved(ownerId: string | null = owner): Promise<ProspectRow> {
  seq += 1;
  const [row] = await db
    .insert(prospects)
    .values({
      placeId: `ChIJ_t087_place_${seq}`,
      status: 'reservado',
      ownerEmployeeId: ownerId,
      createdBy: ownerId,
    })
    .returning();
  return row!;
}

const form = (extra: Record<string, unknown> = {}) =>
  prospectLeadSchema.parse({
    companyName: 'Empresa Teste Oitenta e Sete',
    contactName: 'Contato Teste',
    phone: `2199000${String(9000 + seq)}`,
    whatsappOptIn: false,
    ...extra,
  });

async function convert(row: ProspectRow, extra: Record<string, unknown> = {}) {
  const outcome = await convertProspect(db, manager, row, form(extra), NOW);
  if (!outcome.ok) throw new Error(`refused: ${outcome.error}`);
  const lead = (await db.query.leads.findFirst({ where: eq(leads.id, outcome.leadId) }))!;
  const tasks = await db.select().from(leadTasks).where(eq(leadTasks.leadId, lead.id));
  return { outcome, lead, tasks };
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  owner = (await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' })).id;
  const boss = await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
  // The one who clicks is a manager, not the seller who reserved the company.
  manager = {
    employeeId: boss.id,
    role: 'gerente_comercial',
    sector: 'comercial',
    isSectorManager: true,
  };
});

afterAll(async () => {
  await harness.drop();
});

describe('Criar lead from a prospect: stage, owner and follow-up', () => {
  it('puts the lead in "Sem contato" even when the funnel only has other stages, and makes it once', async () => {
    await ensureStage(db, { pipeline: 'formatacao', name: 'Primeira ligação', position: 1 });
    const first = await convert(await reserved());
    expect(first.lead).toMatchObject({
      pipeline: 'formatacao',
      stage: PROSPECT_LEAD_STAGE,
      source: 'google_places',
    });
    const second = await convert(await reserved());
    expect(second.lead.stageId).toBe(first.lead.stageId);
    const entry = await db
      .select()
      .from(crmStages)
      .where(and(eq(crmStages.pipeline, 'formatacao'), eq(crmStages.name, PROSPECT_LEAD_STAGE)));
    expect(entry).toHaveLength(1);
    expect(entry[0]?.active).toBe(true);
  });

  it('gives the lead to the one who reserved the company, not to who clicked', async () => {
    const { lead } = await convert(await reserved());
    expect(lead.ownerEmployeeId).toBe(owner);
    expect(lead.ownerEmployeeId).not.toBe(manager.employeeId);
  });

  it('opens a follow-up for the owner on the next day when no return was agreed', async () => {
    const { tasks } = await convert(await reserved());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: 'follow_up',
      title: PROSPECT_DEFAULT_FOLLOW_UP_TITLE,
      assigneeEmployeeId: owner,
    });
    expect(tasks[0]!.dueAt.getTime()).toBe(NOW.getTime() + DAY);
  });

  it('keeps the return the company agreed to, and opens no second task', async () => {
    const followUpAt = '2027-03-10T13:00:00.000Z';
    const { tasks } = await convert(await reserved(), { followUpAt });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: PROSPECT_FOLLOW_UP_TITLE, assigneeEmployeeId: owner });
    expect(tasks[0]!.dueAt.toISOString()).toBe(followUpAt);
  });

  it('uses the stage the seller picked instead of "Sem contato"', async () => {
    const other = await ensureStage(db, {
      pipeline: 'formatacao',
      name: 'Em conversa',
      position: 3,
    });
    const { lead } = await convert(await reserved(), { stageId: other.id });
    expect(lead).toMatchObject({ stageId: other.id, stage: 'Em conversa' });
  });

  it('saves what the seller confirmed: company, site and Instagram (the Origem of the card)', async () => {
    const { lead } = await convert(await reserved(), {
      website: 'https://www.empresa-teste-87.com.br/',
      instagram: '@empresateste87',
      email: 'contato@empresa-teste-87.com.br',
    });
    expect(lead).toMatchObject({
      companyName: 'Empresa Teste Oitenta e Sete',
      website: 'https://www.empresa-teste-87.com.br/',
      instagram: 'empresateste87',
      email: 'contato@empresa-teste-87.com.br',
    });
  });

  it('joins a deal the owner already has without a second task or a stage change', async () => {
    const existing = await upsertLead(db, {
      source: 'manual',
      name: 'Pessoa Teste Existente',
      phone: '21990008787',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline: 'formatacao',
      ownerEmployeeId: owner,
      distribute: false,
      skipResearch: true,
      event: { kind: 'lead.created_manually' },
    });
    const other = await ensureStage(db, {
      pipeline: 'formatacao',
      name: 'Em conversa',
      position: 3,
    });
    const { outcome, lead, tasks } = await convert(await reserved(), {
      phone: '21990008787',
      stageId: other.id,
    });
    expect(outcome.created).toBe(false);
    expect(lead.id).toBe(existing.lead.id);
    expect(lead.stageId).toBe(existing.lead.stageId);
    expect(tasks).toHaveLength(0);
  });
});
