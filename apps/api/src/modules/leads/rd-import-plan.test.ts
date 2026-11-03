import { WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { clients, crmDistributionMembers, leads, rdUserMap } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { formatPlan } from '../../scripts/leads-import-rd.js';
import {
  EMPTY_ROTATION,
  importRdDeals,
  type RdContactRow,
  type RdCrmReader,
  type RdDealRow,
  type RdPipelineRow,
} from './rd-import.js';
import { upsertLead } from './service.js';

/**
 * The simulation tells the Eric, before anything is written, how many deals would enter per funnel
 * and brand and to whom the rotation would give them. The proof is the real run: the same options
 * on the same database must put the same number of leads on the same employees.
 */

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const PIPELINES: RdPipelineRow[] = [
  {
    name: 'Expansão',
    deal_stages: [
      { id: 'e1', name: 'Novo Contato' },
      { id: 'e2', name: 'Tentando contato' },
    ],
  },
  {
    name: 'Formatação',
    deal_stages: [
      { id: 'f1', name: 'Sem contato' },
      { id: 'f2', name: 'Identificação de interesse' },
    ],
  },
  { name: 'Parcerias', deal_stages: [{ id: 'p1', name: 'Novo' }] },
];

const brandField = (value: string) => ({ value, custom_field: { label: 'Nome da Marca' } });
const emailOf = (n: string) => [
  { id: `c-${n}`, name: `Pessoa ${n}`, emails: [{ email: `plano.${n}@example.com` }] },
];

const rdWith = (deals: RdDealRow[], contacts: Record<string, RdContactRow[]>): RdCrmReader => ({
  pipelines: async () => PIPELINES,
  users: async () => [{ id: 'u-keep', name: 'Vendedor', email: 'keep@example.com' }],
  deals: async () => deals,
  dealContacts: async (id) => contacts[id] ?? [],
  deal: async () => ({}),
});

const since = new Date('2026-06-30T03:00:00Z');
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}T10:00:00-03:00`;

describe('the simulation plan of the RD import', () => {
  // Order matters: the last test applies the import, after which `onlyMissing` skips every deal.
  let sellers: string[];
  let keeper: string;
  let rd: RdCrmReader;

  beforeAll(async () => {
    const [first, second, kept] = await Promise.all([
      createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' }),
      createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' }),
      createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' }),
    ]);
    sellers = [first.id, second.id];
    keeper = kept.id;
    // Two sellers in the Formatação rotation; the Expansão rotation has nobody.
    await db
      .insert(crmDistributionMembers)
      .values(
        sellers.map((employeeId) => ({
          pipeline: 'formatacao' as const,
          employeeId,
          active: true,
        })),
      );
    await db
      .insert(rdUserMap)
      .values({ rdUserId: 'u-keep', rdName: 'Vendedor', employeeId: keeper });
    await db
      .insert(clients)
      .values({ name: 'Casal do Churros', slug: 'casal-do-churros', number: 7 });
    // The Funil already knows one person by phone (no RD deal yet) and one RD deal.
    await upsertLead(db, {
      source: 'rd_station',
      name: 'Pessoa Conhecida',
      phone: '5511911112001',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      event: { kind: 'lead.received.rd_station' },
    });
    const [deal] = await db
      .insert(leads)
      .values({
        clientId: WINGS_CLIENT_ID,
        source: 'rd_crm',
        name: 'Já tem negócio',
        rdDealId: 'd-have',
      })
      .returning();
    expect(deal).toBeDefined();

    rd = rdWith(
      [
        // Formatação, open, no owner: five go to the rotation, two sellers.
        ...[1, 2, 3, 4, 5].map((n) => ({
          id: `d-f${n}`,
          win: null,
          created_at: day(n),
          deal_stage: { id: 'f1' },
        })),
        { id: 'd-f-lost', win: false, created_at: day(6), deal_stage: { id: 'f2' } },
        // Expansão, open, no owner: the rotation is empty.
        {
          id: 'd-e1',
          win: null,
          created_at: day(7),
          deal_stage: { id: 'e1' },
          deal_custom_fields: [brandField('Casal do Churros')],
        },
        {
          id: 'd-e2',
          win: null,
          created_at: day(8),
          deal_stage: { id: 'e1' },
          deal_custom_fields: [brandField('Casal do Churros')],
        },
        {
          id: 'd-e3',
          win: null,
          created_at: day(9),
          deal_stage: { id: 'e2' },
          campaign: { name: 'LP Marca Nova - Fluxo Expansão' },
        },
        // Expansão with an owner the RD gave: keeps them.
        {
          id: 'd-e-owned',
          win: null,
          created_at: day(10),
          deal_stage: { id: 'e1' },
          user: { id: 'u-keep' },
          deal_custom_fields: [brandField('Casal do Churros')],
        },
        // A person the Funil has by phone: linked, not created.
        { id: 'd-f-known', win: null, created_at: day(11), deal_stage: { id: 'f1' } },
        // A deal the Funil has: skipped by `onlyMissing`.
        { id: 'd-have', win: null, created_at: day(12), deal_stage: { id: 'f1' } },
        // A funnel the Funil does not have.
        { id: 'd-p', win: null, created_at: day(13), deal_stage: { id: 'p1' } },
      ],
      {
        ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`d-f${n}`, emailOf(`f${n}`)])),
        'd-f-lost': emailOf('lost'),
        'd-e1': emailOf('e1'),
        'd-e2': emailOf('e2'),
        'd-e3': emailOf('e3'),
        'd-e-owned': emailOf('owned'),
        'd-f-known': [
          { id: 'c-known', name: 'Pessoa Conhecida', phones: [{ phone: '(11) 91111-2001' }] },
        ],
      },
    );
  });

  const options = {
    since,
    histories: false,
    onlyMissing: true,
    distributeNew: true,
    rotateOld: true,
  } as const;
  const snapshot = async () => ({
    leads: (await db.select().from(leads)).length,
    turns: await db.select().from(crmDistributionMembers),
  });

  it('counts per funnel and brand, projects the rotation by employee id, and writes nothing', async () => {
    const before = await snapshot();
    const result = await importRdDeals(db, rd, { ...options, apply: false });
    expect(await snapshot()).toEqual(before);

    expect(result.plan.create).toEqual({
      expansao: { 'Casal do Churros': 3, 'Marca Nova': 1 },
      formatacao: { '—': 6 },
      consultoria: {},
    });
    expect(result.plan.link).toEqual({
      expansao: {},
      formatacao: { '—': 1 },
      consultoria: {},
    });
    // The five open Formatação leads alternate between the two sellers, served in turn order.
    expect(result.plan.rotation.formatacao).toEqual({ [sellers[0]!]: 3, [sellers[1]!]: 2 });
    // Expansão has nobody in its rotation; the one with an RD owner and the closed one stay out of it.
    expect(result.plan.rotation.expansao).toEqual({ [EMPTY_ROTATION]: 3 });
    expect(result.plan.outsideRotation).toEqual({
      ownerFromRd: 1,
      closed: 1,
      archive: 0,
      tooOld: 0,
      rotationOff: 0,
      otherFunnel: 0,
    });
    const lines = formatPlan(result.plan);
    expect(lines.every((line) => line.startsWith('plano:'))).toBe(true);
    expect(lines).toContain('plano:   formatacao · —: 6');
    expect(lines.join('\n')).not.toMatch(/@|\+?\d{10,}/);
  });

  it('says the rotation is off when the import is not asked to rotate', async () => {
    const result = await importRdDeals(db, rd, {
      since,
      histories: false,
      onlyMissing: true,
      apply: false,
    });
    expect(result.plan.rotation).toEqual({ expansao: {}, formatacao: {}, consultoria: {} });
    expect(result.created).toBeGreaterThan(0);
    expect(result.plan.outsideRotation.rotationOff).toBe(result.created);
  });

  it('is what the real run then does: the same leads on the same employees', async () => {
    const simulated = await importRdDeals(db, rd, { ...options, apply: false });
    const applied = await importRdDeals(db, rd, {
      ...options,
      apply: true,
      batchId: 'rd-crm-plan-test',
    });
    expect(applied.created).toBe(simulated.created);
    expect(applied.merged).toBe(simulated.merged);

    const created = await db
      .select()
      .from(leads)
      .where(eq(leads.importBatchId, 'rd-crm-plan-test'));
    const owners: Record<string, number> = {};
    for (const lead of created) {
      if (lead.pipeline !== 'formatacao' || lead.won !== null || !lead.ownerEmployeeId) continue;
      owners[lead.ownerEmployeeId] = (owners[lead.ownerEmployeeId] ?? 0) + 1;
    }
    expect(owners).toEqual(simulated.plan.rotation.formatacao);
    expect(applied.rotation).toEqual({
      assigned: 5,
      empty: simulated.plan.rotation.expansao[EMPTY_ROTATION],
    });
    // An applied run leaves the plan empty: it has the real numbers.
    expect(applied.plan.create).toEqual({ expansao: {}, formatacao: {}, consultoria: {} });
  });
});
