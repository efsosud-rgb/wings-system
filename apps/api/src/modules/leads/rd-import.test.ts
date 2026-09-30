import { WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { clients, jobs, leadEvents, leads, rdUserMap } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { recordDealOnLead } from '../expansion/service.js';
import {
  brandOfDeal,
  followRdStages,
  importRdDeals,
  refreshStageTimes,
  stageTimesOf,
  type RdContactRow,
  type RdCrmReader,
  type RdDealDetail,
  type RdDealRow,
  type RdPipelineRow,
} from './rd-import.js';
import { upsertLead } from './service.js';

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
      { id: 'e3', name: 'Reunião agendada' },
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

function fakeRd(input: {
  deals: RdDealRow[];
  contacts: Record<string, RdContactRow[]>;
  details?: Record<string, RdDealDetail>;
  users?: { id: string; name: string; email: string }[];
}): RdCrmReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pipelines: async () => PIPELINES,
    users: async () => input.users ?? [],
    deals: async () => input.deals,
    dealContacts: async (id) => {
      calls.push(`contacts:${id}`);
      return input.contacts[id] ?? [];
    },
    deal: async (id) => {
      calls.push(`deal:${id}`);
      const detail = input.details?.[id];
      if (!detail) throw new Error('RD CRM /deals/:id answered 404');
      return detail;
    },
  };
}

describe('pure helpers', () => {
  it('reads the brand from "Nome da Marca", else from the Expansão campaign', () => {
    expect(
      brandOfDeal({
        win: null,
        created_at: '',
        deal_custom_fields: [brandField(' Açaí da Fila ')],
      }),
    ).toBe('Açaí da Fila');
    expect(
      brandOfDeal({
        win: null,
        created_at: '',
        campaign: { name: 'LP/LE Casal dos Churros - Fluxo Expansão' },
      }),
    ).toBe('Casal dos Churros');
    expect(brandOfDeal({ win: null, created_at: '', campaign: { name: 'META ADS' } })).toBeNull();
  });

  it('reads stage histories in the shapes RD may use, guessing nothing', () => {
    const times = stageTimesOf(
      [
        { deal_stage_id: 'e1', start_date: '2026-09-01T10:00:00-03:00' },
        { deal_stage: { _id: 'e2' }, started_at: '2026-09-01T11:30:00-03:00' },
        { stage_id: 'e3', created_at: '2026-09-03T09:00:00-03:00' },
        { deal_stage_id: 'e2' },
      ],
      { currentStageId: 'e3', firstStageId: 'e1' },
    );
    expect(times.firstContactAt?.toISOString()).toBe('2026-09-01T14:30:00.000Z');
    expect(times.stageChangedAt?.toISOString()).toBe('2026-09-03T12:00:00.000Z');
    expect(stageTimesOf(undefined, { currentStageId: 'e1', firstStageId: 'e1' })).toEqual({
      firstContactAt: null,
      stageChangedAt: null,
    });
  });
});

describe('importRdDeals', () => {
  const since = new Date('2026-06-30T03:00:00Z');
  let ownerId: string;
  let rd: ReturnType<typeof fakeRd>;
  let brandClientId: string;

  beforeAll(async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao' });
    ownerId = owner.id;
    const [client] = await db
      .insert(clients)
      .values({ name: 'Casal do Churros', slug: 'casal-do-churros', number: 1 })
      .returning();
    brandClientId = client!.id;
    // A lead that came in by the site before: the RD deal joins it.
    await upsertLead(db, {
      source: 'rd_station',
      name: 'Pessoa Um',
      phone: '5511911110001',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      event: { kind: 'lead.received.rd_station' },
    });
    rd = fakeRd({
      users: [{ id: 'u1', name: 'Vendedor', email: owner.email.toUpperCase() }],
      deals: [
        {
          id: 'd-exp',
          win: null,
          created_at: '2026-09-01T10:00:00-03:00',
          deal_stage: { id: 'e3' },
          user: { id: 'u1' },
          deal_custom_fields: [brandField('Casal dos Churros')],
        },
        {
          id: 'd-fmt',
          win: false,
          created_at: '2026-09-10T10:00:00-03:00',
          closed_at: '2026-09-20T10:00:00-03:00',
          deal_stage: { id: 'f2' },
          user: { id: 'u9' },
          deal_lost_reason: { name: 'Preço' },
        },
        {
          id: 'd-old-closed',
          win: false,
          created_at: '2026-01-10T10:00:00-03:00',
          deal_stage: { id: 'e1' },
        },
        {
          id: 'd-old-open',
          win: null,
          created_at: '2026-02-10T10:00:00-03:00',
          deal_stage: { id: 'e2' },
          campaign: { name: 'LP Marca Nova - Fluxo Expansão' },
        },
        {
          id: 'd-parceria',
          win: null,
          created_at: '2026-09-10T10:00:00-03:00',
          deal_stage: { id: 'p1' },
        },
        // Same person twice: an older closed deal, then an open one.
        {
          id: 'd-twice-1',
          win: false,
          created_at: '2026-07-01T10:00:00-03:00',
          deal_stage: { id: 'f1' },
        },
        {
          id: 'd-twice-2',
          win: null,
          created_at: '2026-08-01T10:00:00-03:00',
          deal_stage: { id: 'f1' },
        },
      ],
      contacts: {
        'd-exp': [{ id: 'c1', name: 'Pessoa Um', phones: [{ phone: '(11) 91111-0001' }] }],
        'd-fmt': [{ id: 'c2', name: 'Pessoa Dois', emails: [{ email: 'Dois@Example.com' }] }],
        'd-old-open': [],
        'd-twice-1': [{ id: 'c3', name: 'Pessoa Três', emails: [{ email: 'tres@example.com' }] }],
        'd-twice-2': [{ id: 'c3', name: 'Pessoa Três', emails: [{ email: 'tres@example.com' }] }],
      },
      details: {
        'd-exp': {
          deal_stage_histories: [
            { deal_stage_id: 'e1', start_date: '2026-09-01T10:00:00-03:00' },
            { deal_stage_id: 'e2', start_date: '2026-09-02T09:00:00-03:00' },
            { deal_stage_id: 'e3', start_date: '2026-09-05T15:00:00-03:00' },
          ],
        },
      },
    });
  });

  it('simulates without writing anything', async () => {
    const before = await db.select().from(leads);
    const result = await importRdDeals(db, rd, { apply: false, since, histories: false });
    expect(result.inScope).toEqual({ expansao: 2, formatacao: 3 });
    expect(result.merged).toBe(2);
    expect(result.created).toBe(3);
    expect(await db.select().from(leads)).toHaveLength(before.length);
    expect(await db.select().from(rdUserMap)).toHaveLength(0);
  });

  it('brings the deals in with funnel, brand, stage, owner and first contact, without queuing research', async () => {
    const jobsBefore = (await db.select().from(jobs)).length;
    const result = await importRdDeals(db, rd, { apply: true, since, histories: true });
    expect(result).toMatchObject({
      created: 3,
      merged: 2,
      otherDealOfSamePerson: 1,
      noContactData: 1,
      rdUsers: { listed: 1, linkedByEmail: 1, linkedByName: 0 },
      histories: { read: 1, failed: 4, withFirstContact: 1 },
      unmatchedBrands: ['Marca Nova'],
      failed: 0,
    });
    expect(rd.calls).not.toContain('contacts:d-parceria');
    expect(rd.calls).not.toContain('contacts:d-old-closed');
    expect((await db.select().from(jobs)).length).toBe(jobsBefore);

    const expansion = await db.query.leads.findFirst({ where: eq(leads.rdDealId, 'd-exp') });
    expect(expansion).toMatchObject({
      source: 'rd_station', // the lead it joined keeps its own origin
      pipeline: 'expansao',
      brand: 'Casal dos Churros',
      clientId: brandClientId,
      clientMapped: true,
      stage: 'Reunião agendada',
      stageOrder: 3,
      ownerEmployeeId: ownerId,
      rdOwnerId: 'u1',
      won: null,
    });
    expect(expansion?.firstContactAt?.toISOString()).toBe('2026-09-02T12:00:00.000Z');
    expect(expansion?.stageChangedAt?.toISOString()).toBe('2026-09-05T18:00:00.000Z');

    const formatacao = await db.query.leads.findFirst({ where: eq(leads.rdDealId, 'd-fmt') });
    expect(formatacao).toMatchObject({
      source: 'rd_crm',
      email: 'dois@example.com',
      pipeline: 'formatacao',
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      won: false,
      lostReason: 'Preço',
      ownerEmployeeId: null,
      enrichmentState: 'none',
    });

    const twice = await db.query.leads.findFirst({ where: eq(leads.email, 'tres@example.com') });
    expect(twice?.rdDealId).toBe('d-twice-2');

    const unmatched = await db.query.leads.findFirst({ where: eq(leads.rdDealId, 'd-old-open') });
    expect(unmatched).toMatchObject({
      brand: 'Marca Nova',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
    });
  });

  it('is safe to run again', async () => {
    const count = (await db.select().from(leads)).length;
    const again = await importRdDeals(db, rd, { apply: true, since, histories: false });
    expect(again.created).toBe(0);
    expect((await db.select().from(leads)).length).toBe(count);
    const expansion = await db.query.leads.findFirst({ where: eq(leads.rdDealId, 'd-exp') });
    // Without reading the history this time, the known times stay.
    expect(expansion?.stageChangedAt?.toISOString()).toBe('2026-09-05T18:00:00.000Z');
  });

  it('follows a stage change hourly, forgetting the stage time until the history is read again', async () => {
    const moved = await followRdStages(db, {
      deals: [
        {
          id: 'd-exp',
          win: null,
          created_at: '2026-09-01T10:00:00-03:00',
          deal_stage: { id: 'e2' },
          user: { id: 'u1' },
        },
      ],
      pipelines: PIPELINES,
    });
    expect(moved).toEqual({ updated: 1, stageChanged: 1 });
    let lead = await db.query.leads.findFirst({ where: eq(leads.rdDealId, 'd-exp') });
    expect(lead).toMatchObject({ stage: 'Tentando contato', stageChangedAt: null });
    expect(lead?.firstContactAt).not.toBeNull();

    const refreshed = await refreshStageTimes(db, rd, { pipelines: PIPELINES, limit: 10 });
    expect(refreshed.read).toBeGreaterThanOrEqual(1);
    lead = await db.query.leads.findFirst({ where: eq(leads.rdDealId, 'd-exp') });
    expect(lead?.stageChangedAt?.toISOString()).toBe('2026-09-02T12:00:00.000Z');
  });
});

describe('recordDealOnLead (intake jobs)', () => {
  it('gives the Funil lead the deal the intake made, once', async () => {
    const { lead } = await upsertLead(db, {
      source: 'rd_station',
      email: 'intake@example.com',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      event: { kind: 'lead.received.rd_station' },
    });
    const conversion = {
      contactUuid: 'x',
      identifier: 'acai-da-fila',
      occurredAt: new Date(),
      name: null,
      email: 'INTAKE@example.com',
      phone: null,
      company: null,
      utms: null,
      page: null,
      eventType: 'CONVERSION',
      ads: null,
    };
    expect(
      await recordDealOnLead(db, {
        conversion,
        dealId: 'rd-new-1',
        target: 'expansao',
        brand: 'Açaí da Fila',
      }),
    ).toBe(true);
    expect(
      await recordDealOnLead(db, {
        conversion,
        dealId: 'rd-new-2',
        target: 'expansao',
        brand: 'Açaí da Fila',
      }),
    ).toBe(false);
    const row = await db.query.leads.findFirst({ where: eq(leads.id, lead.id) });
    expect(row).toMatchObject({
      rdDealId: 'rd-new-1',
      pipeline: 'expansao',
      brand: 'Açaí da Fila',
    });
    const events = await db.query.leadEvents.findMany({ where: eq(leadEvents.leadId, lead.id) });
    expect(events.map((event) => event.kind)).toContain('rd.deal_created');
  });
});
