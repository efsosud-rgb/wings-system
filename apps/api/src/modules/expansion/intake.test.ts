import { describe, expect, it } from 'vitest';
import { memoryLedger, runExpansionIntake, type LandingPageRule } from './intake.js';
import type { Conversion, CrmContact, CrmMap, NewDeal, RdCrm, RdMarketing } from './rd.js';

const rules: LandingPageRule[] = [{ identifier: 'lp-x', brand: 'Marca X' }];
const at = (iso: string) => new Date(iso);

function conversion(over: Partial<Conversion>): Conversion {
  return {
    contactUuid: 'u1',
    identifier: 'lp-x',
    occurredAt: at('2026-09-28T12:00:00Z'),
    name: 'Fulano',
    email: 'fulano@example.com',
    phone: '11999990000',
    company: null,
    utms: { source: 'meta', medium: 'cpc', campaign: 'c1', content: null },
    page: 'lp.example.com/x',
    ...over,
  };
}

const map: CrmMap = {
  pipelines: new Map([
    ['Expansão', { id: 'p1', stages: new Map([['Tentando contato', 's-exp']]) }],
    ['Formatação', { id: 'p2', stages: new Map([['Sem contato', 's-for']]) }],
  ]),
  customFields: new Map([
    ['Nome da Marca', 'cf-brand'],
    ['OBS', 'cf-obs'],
  ]),
  sources: new Map([['Contato pelo Site', 'src-site']]),
  campaigns: new Map([['LP/LE Marca X - Fluxo Expansão', 'camp-x']]),
};

function harness(conversions: Conversion[], contacts: Record<string, CrmContact | null> = {}) {
  const created: NewDeal[] = [];
  const marketing = {
    contactsConvertedSince: async () => [...new Set(conversions.map((c) => c.contactUuid))],
    conversionsOf: async (uuid: string) => conversions.filter((c) => c.contactUuid === uuid),
  } as unknown as RdMarketing;
  const crm = {
    map: async () => map,
    findContact: async (email: string | null) => contacts[email ?? ''] ?? null,
    dealCreatedAt: async () => at('2026-01-01T00:00:00Z'),
    createDeal: async (deal: NewDeal) => {
      created.push(deal);
      return `deal-${created.length}`;
    },
    checkDeal: async () => ({ hasContact: true, hasSource: true }),
  } as unknown as RdCrm;
  const ledger = memoryLedger();
  const run = (dryRun = false) =>
    runExpansionIntake({
      marketing,
      crm,
      ledger,
      rules,
      since: at('2026-09-01T00:00:00Z'),
      dryRun,
    });
  return { created, ledger, run };
}

describe('expansion intake', () => {
  it('creates an Expansão deal in "Tentando contato" with brand and UTM', async () => {
    const h = harness([conversion({})]);
    const result = await h.run();
    expect(result.created).toEqual({ 'expansao:Marca X': 1 });
    expect(h.created[0]).toMatchObject({ stageId: 's-exp', campaignId: 'camp-x' });
    expect(h.created[0]!.customFields).toEqual([
      { id: 'cf-brand', value: 'Marca X' },
      { id: 'cf-obs', value: expect.stringContaining('campaign=c1') },
    ]);
  });

  it('routes the site form to Formatação / "Sem contato" and leaves other identifiers alone', async () => {
    const h = harness([
      conversion({ identifier: 'wings-company-form-site' }),
      conversion({ contactUuid: 'u2', email: 'b@example.com', identifier: 'RD Station CRM' }),
    ]);
    const result = await h.run();
    expect(result.created).toEqual({ formatacao: 1 });
    expect(result.ignored).toEqual({ 'RD Station CRM': 1 });
    expect(h.created[0]).toMatchObject({ stageId: 's-for', sourceId: 'src-site' });
  });

  it('does not duplicate when the contact has an open deal in any funnel', async () => {
    const h = harness([conversion({})], {
      'fulano@example.com': { id: 'c1', deals: [{ id: 'd1', win: null }] },
    });
    const result = await h.run();
    expect(result.existingDeal).toBe(1);
    expect(h.created).toHaveLength(0);
  });

  it('treats a deal made after the conversion as covering it, even if closed', async () => {
    const h = harness([conversion({ occurredAt: at('2025-12-01T00:00:00Z') })], {
      'fulano@example.com': { id: 'c1', deals: [{ id: 'd1', win: false }] },
    });
    expect((await h.run()).existingDeal).toBe(1);
  });

  it('creates when the contact only has an older closed deal', async () => {
    const h = harness([conversion({})], {
      'fulano@example.com': { id: 'c1', deals: [{ id: 'd1', win: true }] },
    });
    expect((await h.run()).created).toEqual({ 'expansao:Marca X': 1 });
  });

  it('makes one deal for a contact that converted three times', async () => {
    const h = harness([
      conversion({ occurredAt: at('2026-09-28T12:00:00Z') }),
      conversion({ occurredAt: at('2026-09-28T12:20:00Z') }),
      conversion({ occurredAt: at('2026-09-28T12:40:00Z') }),
    ]);
    const result = await h.run();
    expect(h.created).toHaveLength(1);
    expect(result.existingDeal).toBe(2);
  });

  it('is idempotent through the ledger and writes nothing on a dry run', async () => {
    const dry = harness([conversion({})]);
    expect((await dry.run(true)).created).toEqual({ 'expansao:Marca X': 1 });
    expect(dry.created).toHaveLength(0);
    expect(dry.ledger.entries.size).toBe(0);

    const h = harness([conversion({})]);
    await h.run();
    const again = await h.run();
    expect(again.alreadyDecided).toBe(1);
    expect(h.created).toHaveLength(1);
  });

  it('counts a conversion with no e-mail and no phone instead of creating a deal', async () => {
    const h = harness([conversion({ email: null, phone: null })]);
    const result = await h.run();
    expect(result.noContactData).toBe(1);
    expect(h.created).toHaveLength(0);
  });
});
