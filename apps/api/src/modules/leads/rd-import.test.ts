import { WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  clients,
  crmStages,
  jobs,
  leadEvents,
  leadTasks,
  leads,
  rdUserMap,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { recordDealOnLead } from '../expansion/service.js';
import {
  brandOfDeal,
  followRdStages,
  importRdDeals,
  isArchiveFunnel,
  rdOwnerAllowlist,
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
  pipelines?: RdPipelineRow[];
}): RdCrmReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pipelines: async () => input.pipelines ?? PIPELINES,
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
          contacts: [{ id: 'c1', name: 'Pessoa Um', phones: [{ phone: '(11) 91111-0001' }] }],
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
    // Only the departed seller marked by migration 0056 is there before any import.
    expect(
      (await db.select().from(rdUserMap)).filter((row) => row.departedAt === null),
    ).toHaveLength(0);
  });

  it('brings the deals in with funnel, brand, stage, owner and first contact, without queuing research', async () => {
    const jobsBefore = (await db.select().from(jobs)).length;
    const result = await importRdDeals(db, rd, {
      apply: true,
      since,
      histories: true,
      batchId: 'rd-crm-test-1',
    });
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
    // The list already carried d-exp's contacts: no second call for them.
    expect(rd.calls).not.toContain('contacts:d-exp');
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
    expect(formatacao?.createdAt.toISOString()).toBe('2026-09-10T13:00:00.000Z');
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
    const again = await importRdDeals(db, rd, {
      apply: true,
      since,
      histories: false,
      batchId: 'rd-crm-test-2',
    });
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

describe('RD archive funnels', () => {
  const ARCHIVE_PIPELINES: RdPipelineRow[] = [
    { name: 'Expansão', deal_stages: [{ id: 'ae1', name: 'Novo Contato' }] },
    {
      name: 'Negócios perdidos - Expansão',
      deal_stages: [
        { id: 'ax1', name: 'Com motivo de perda' },
        { id: 'ax2', name: 'Novo Contato' },
      ],
    },
    { name: 'Vendidos | Expansão🏆', deal_stages: [{ id: 'av1', name: 'Vendidos' }] },
    { name: 'Lista de espera', deal_stages: [{ id: 'al1', name: 'Sem contato' }] },
  ];
  const deal = (id: string, stage: string, win: boolean | null): RdDealRow => ({
    id,
    win,
    created_at: '2024-03-01T10:00:00-03:00',
    deal_stage: { id: stage },
  });
  const phoneOf = (n: number) => [
    { id: `ac${n}`, name: 'Pessoa Arquivo', phones: [{ phone: `(21) 97777-000${n}` }] },
  ];

  it('tells an archive funnel from the pipeline own one', () => {
    expect(isArchiveFunnel('Expansão', 'expansao')).toBe(false);
    expect(isArchiveFunnel(' Formatação ', 'formatacao')).toBe(false);
    expect(isArchiveFunnel('Negócios perdidos - Expansão', 'expansao')).toBe(true);
    expect(isArchiveFunnel('Vendidos | Formatação🥇', 'formatacao')).toBe(true);
    expect(isArchiveFunnel('Parcerias', null)).toBe(false);
  });

  it('files archive deals as won or lost in the funnel of origin, with no stage, and keeps only the listed owners', async () => {
    const keeper = await createEmployee(db, { role: 'vendedor_expansao' });
    const other = await createEmployee(db, { role: 'vendedor_expansao' });
    await db.insert(rdUserMap).values([
      { rdUserId: 'rd-keep', rdName: 'Quem fica', employeeId: keeper.id },
      { rdUserId: 'rd-other', rdName: 'Quem não fica', employeeId: other.id },
    ]);
    const rd = fakeRd({
      pipelines: ARCHIVE_PIPELINES,
      deals: [
        deal('a-lost', 'ax1', false),
        // Filed in the archive without RD's own flag: the funnel decides.
        deal('a-lost-open', 'ax2', null),
        deal('a-won-open', 'av1', null),
        deal('a-wait', 'al1', null),
        { ...deal('a-owned', 'ae1', null), user: { id: 'rd-keep' } },
        { ...deal('a-other', 'ae1', null), user: { id: 'rd-other' } },
      ],
      contacts: {
        'a-lost': phoneOf(1),
        'a-lost-open': phoneOf(2),
        'a-won-open': phoneOf(3),
        'a-owned': phoneOf(4),
        'a-other': phoneOf(5),
      },
    });
    const since = new Date('2024-01-01T03:00:00Z');
    const ownerRdUserIds = rdOwnerAllowlist(' rd-keep ,');
    const simulated = await importRdDeals(db, rd, {
      apply: false,
      since,
      histories: false,
      ownerRdUserIds,
    });
    expect(simulated).toMatchObject({
      inArchive: 3,
      archiveOutcome: { won: 1, lost: 2 },
      outOfScope: { 'Lista de espera': 1 },
      owners: { mapped: 1, unmapped: 4 },
    });

    const applied = await importRdDeals(db, rd, {
      apply: true,
      since,
      histories: false,
      batchId: 'rd-crm-archive',
      ownerRdUserIds,
    });
    expect(applied).toMatchObject({ created: 5, inArchive: 3, failed: 0 });
    const names = (
      await db
        .select({ name: crmStages.name })
        .from(crmStages)
        .where(eq(crmStages.pipeline, 'expansao'))
    ).map((row) => row.name);
    expect(names).not.toContain('Com motivo de perda');
    expect(names).not.toContain('Vendidos');

    const byDeal = (id: string) => db.query.leads.findFirst({ where: eq(leads.rdDealId, id) });
    expect(await byDeal('a-lost')).toMatchObject({
      pipeline: 'expansao',
      stage: null,
      stageId: null,
      won: false,
      lostReason: 'Com motivo de perda',
      rdPipeline: 'Negócios perdidos - Expansão',
    });
    expect(await byDeal('a-lost-open')).toMatchObject({ won: false, stage: null, stageId: null });
    expect(await byDeal('a-won-open')).toMatchObject({
      won: true,
      lostReason: null,
      stage: null,
      stageId: null,
    });

    // Only a listed RD user keeps the owner; anyone else's deal waits with no owner, no task.
    expect((await byDeal('a-owned'))?.ownerEmployeeId).toBe(keeper.id);
    const unowned = await byDeal('a-other');
    expect(unowned?.ownerEmployeeId).toBeNull();
    expect(await db.select().from(leadTasks).where(eq(leadTasks.leadId, unowned!.id))).toEqual([]);

    // The hourly follow-up keeps all of it.
    await followRdStages(db, {
      deals: [
        deal('a-won-open', 'av1', null),
        { ...deal('a-other', 'ae1', null), user: { id: 'rd-other' } },
      ],
      pipelines: ARCHIVE_PIPELINES,
      ownerRdUserIds,
    });
    expect(await byDeal('a-won-open')).toMatchObject({ won: true, stage: null });
    expect((await byDeal('a-other'))?.ownerEmployeeId).toBeNull();
    expect(
      await db.query.crmStages.findFirst({
        where: and(eq(crmStages.pipeline, 'expansao'), eq(crmStages.name, 'Vendidos')),
      }),
    ).toBeUndefined();
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

describe('recordDealOnLead does not guess', () => {
  const conversionFor = (phone: string, occurredAt = new Date()) => ({
    contactUuid: 'y',
    identifier: 'wings-company-form-site',
    occurredAt,
    name: null,
    email: null,
    phone,
    company: null,
    utms: null,
    page: null,
    eventType: 'CONVERSION',
    ads: null,
  });

  it('links nothing when two leads of the funnel share the phone', async () => {
    for (const email of ['a@example.com', 'b@example.com']) {
      await db
        .insert(leads)
        .values({ source: 'manual', phone: '5521966660001', email, pipeline: 'formatacao' });
    }
    expect(
      await recordDealOnLead(db, {
        conversion: conversionFor('21 96666-0001'),
        dealId: 'rd-amb',
        target: 'formatacao',
        brand: null,
      }),
    ).toBe(false);
  });

  it('ignores a lead of the other funnel and one older than 30 days', async () => {
    await db
      .insert(leads)
      .values({ source: 'manual', phone: '5521966660002', pipeline: 'expansao' });
    await db.insert(leads).values({
      source: 'manual',
      phone: '5521966660003',
      createdAt: new Date(Date.now() - 40 * 86_400_000),
    });
    expect(
      await recordDealOnLead(db, {
        conversion: conversionFor('21 96666-0002'),
        dealId: 'rd-o1',
        target: 'formatacao',
        brand: null,
      }),
    ).toBe(false);
    expect(
      await recordDealOnLead(db, {
        conversion: conversionFor('21 96666-0003'),
        dealId: 'rd-o2',
        target: 'formatacao',
        brand: null,
      }),
    ).toBe(false);
  });
});

describe('the Funil list and summary over imported leads', () => {
  it('filters by funnel, stage, outcome and stale days, and sums per brand', async () => {
    const { listLeads, funnelSummary } = await import('./service.js');
    const expansion = await listLeads(db, { pipeline: 'expansao' });
    expect(expansion.leads.every((lead) => lead.pipeline === 'expansao')).toBe(true);
    expect(expansion.total).toBe(expansion.leads.length);

    const lost = await listLeads(db, { outcome: 'lost' });
    expect(lost.leads.map((lead) => lead.stage)).toContain('Identificação de interesse');

    const byStage = await listLeads(db, { stage: 'Tentando contato' });
    expect(byStage.leads.length).toBeGreaterThan(0);

    // d-exp entered its stage on 2026-09-02: stale for more than 7 days; unknown stage times never count.
    const stale = await listLeads(db, { staleDays: 7 });
    expect(stale.leads.every((lead) => lead.stageChangedAt !== null && lead.won === null)).toBe(
      true,
    );

    const summary = await funnelSummary(db, { days: 3650 });
    const casal = summary.rows.find((row) => row.label === 'Casal dos Churros');
    expect(casal).toMatchObject({ pipeline: 'expansao', arrived: 1, worked: 1 });
    expect(summary.rows.find((row) => row.label === 'Formatação')?.arrived).toBeGreaterThanOrEqual(
      2,
    );
    expect(summary.stages.some((stage) => stage.stage === 'Tentando contato')).toBe(true);
    expect(summary.syncedAt).not.toBeNull();
  });
});

describe('undoRdImportBatch', () => {
  it('removes the leads a run created and puts back the ones it changed, and nothing else', async () => {
    const { undoRdImportBatch } = await import('./rd-import.js');
    // A lead from before the run, which the run joins by phone and fills.
    const before = await upsertLead(db, {
      source: 'manual',
      phone: '5531955550001',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      skipResearch: true,
      event: { kind: 'lead.created_manually' },
    });
    const untouched = await upsertLead(db, {
      source: 'manual',
      phone: '5531955550009',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      skipResearch: true,
      event: { kind: 'lead.created_manually' },
    });
    const run = fakeRd({
      deals: [
        {
          id: 'u-join',
          win: null,
          created_at: '2026-09-25T10:00:00-03:00',
          deal_stage: { id: 'f2' },
        },
        {
          id: 'u-new',
          win: null,
          created_at: '2026-09-26T10:00:00-03:00',
          deal_stage: { id: 'f1' },
        },
      ],
      contacts: {
        'u-join': [{ id: 'k1', name: 'Pessoa Junta', phones: [{ phone: '31 95555-0001' }] }],
        'u-new': [{ id: 'k2', name: 'Pessoa Nova', phones: [{ phone: '31 95555-0002' }] }],
      },
    });
    await importRdDeals(db, run, {
      apply: true,
      since: new Date('2026-09-01T00:00:00Z'),
      histories: false,
      batchId: 'rd-crm-undo-1',
    });
    const joined = await db.query.leads.findFirst({ where: eq(leads.id, before.lead.id) });
    expect(joined).toMatchObject({
      rdDealId: 'u-join',
      name: 'Pessoa Junta',
      stage: 'Identificação de interesse',
    });

    const simulated = await undoRdImportBatch(db, { batchId: 'rd-crm-undo-1', apply: false });
    expect(simulated).toMatchObject({ created: 1, restored: 1 });
    expect(await db.query.leads.findFirst({ where: eq(leads.rdDealId, 'u-new') })).toBeTruthy();

    const undone = await undoRdImportBatch(db, { batchId: 'rd-crm-undo-1', apply: true });
    expect(undone).toMatchObject({ applied: true, created: 1, restored: 1 });
    expect(await db.query.leads.findFirst({ where: eq(leads.rdDealId, 'u-new') })).toBeUndefined();
    const restored = await db.query.leads.findFirst({ where: eq(leads.id, before.lead.id) });
    expect(restored).toMatchObject({
      rdDealId: null,
      name: null,
      stage: null,
      pipeline: null,
      phone: '5531955550001',
    });
    expect(await db.query.leads.findFirst({ where: eq(leads.id, untouched.lead.id) })).toBeTruthy();
  });
});
