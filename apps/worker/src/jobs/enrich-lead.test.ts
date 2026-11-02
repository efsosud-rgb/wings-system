import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CnpjRecord, SearchResult, ZapiProfile } from '../lib/enrichment.js';
import { reserveSpend, saoPauloDayStart, spentTodayUsdMicro } from '../lib/enrichment.js';
import { baseContext } from '../test/context.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { cnpjCandidatesOf, companyOf, nameMatches, profileLinksOf, runEnrichLeadJob, type EnrichLeadOutput } from './enrich-lead.js';

const WINGS_CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';

describe('reading public results', () => {
  it('matches a name by its first and last tokens, accent-blind', () => {
    expect(nameMatches('Ana Souza', 'ANA CLARA DE SOUZA')).toBe(true);
    expect(nameMatches('José Silva', 'jose da silva')).toBe(true);
    expect(nameMatches('Ana Souza', 'Ana Lima')).toBe(false);
    expect(nameMatches('', 'Ana')).toBe(false);
  });

  it('keeps only LinkedIn and Instagram pages that name the lead, one of each', () => {
    const results: SearchResult[] = [
      { title: 'Ana Souza - Diretora - Aurora | LinkedIn', url: 'https://br.linkedin.com/in/ana-souza', snippet: 'Diretora comercial.' },
      { title: 'Outra Pessoa | LinkedIn', url: 'https://www.linkedin.com/in/outra', snippet: 'Nada a ver com Ana.' },
      { title: 'Ana Souza (@anasouza)', url: 'https://www.instagram.com/anasouza/', snippet: 'Fotos' },
      { title: 'Ana Souza', url: 'https://www.instagram.com/p/abc123/', snippet: 'Um post' },
      { title: 'Ana Souza - Aurora', url: 'https://aurora.com.br/equipe', snippet: 'Site da empresa' },
    ];
    const links = profileLinksOf('Ana Souza', results);
    expect(links.map((l) => [l.kind, l.url])).toEqual([
      ['linkedin', 'https://br.linkedin.com/in/ana-souza'],
      ['instagram', 'https://www.instagram.com/anasouza/'],
    ]);
  });

  it('pulls CNPJ numbers out of text, in any of their spellings', () => {
    expect(cnpjCandidatesOf(['CNPJ 12.345.678/0001-90 da empresa', 'outro: 12345678000190', 'nada 123'])).toEqual(['12345678000190']);
  });

  it('ties a company to the lead only as partner or through the e-mail domain, and only while active', () => {
    const record: CnpjRecord = {
      cnpj: '12.345.678/0001-90',
      legalName: 'AURORA ALIMENTOS LTDA',
      tradeName: 'Padaria Aurora',
      capitalSocialBrl: 250000,
      openedAt: '2015-03-01',
      mainActivity: 'Padaria',
      size: 'EPP',
      city: 'Campinas',
      uf: 'SP',
      status: 'ATIVA',
      partners: ['ANA CLARA DE SOUZA', 'JOAO PEDRO LIMA'],
    };
    expect(companyOf(record, { name: 'Ana Souza', emailDomain: 'gmail.com' })).toMatchObject({ leadIsPartner: true, matchedBy: 'partner', name: 'Padaria Aurora' });
    expect(companyOf(record, { name: 'Carlos Dias', emailDomain: 'aurora.com.br' })).toMatchObject({ leadIsPartner: false, matchedBy: 'email_domain' });
    expect(companyOf(record, { name: 'Carlos Dias', emailDomain: 'gmail.com' })).toBeNull();
    expect(companyOf({ ...record, status: 'BAIXADA' }, { name: 'Ana Souza', emailDomain: null })).toBeNull();
  });
});

describe('the enrich_lead job', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, 60_000);
  afterAll(() => database.drop());

  async function insertLead(fields: Record<string, unknown>) {
    const columns = Object.keys(fields);
    const values = Object.values(fields);
    const result = await database.pool.query<{ id: string }>(
      `insert into leads (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      values,
    );
    return result.rows[0]?.id as string;
  }
  async function insertJob(leadId: string) {
    const result = await database.pool.query<{ id: string }>(
      `insert into jobs (type, input) values ('enrich_lead', $1) returning id`,
      [JSON.stringify({ leadId })],
    );
    return { id: result.rows[0]?.id as string, type: 'enrich_lead' as const, input: { leadId }, attempts: 1 };
  }
  const leadRow = async (id: string) =>
    (await database.pool.query(`select * from leads where id = $1`, [id])).rows[0] as Record<string, unknown>;
  const ledgerRows = async (id: string) =>
    (await database.pool.query(`select step, status, usd_micro, detail from lead_enrichment_ledger where lead_id = $1 order by created_at`, [id]))
      .rows as { step: string; status: string; usd_micro: number; detail: Record<string, unknown> }[];

  it('collects the facts with fakes, scores them against the client area and writes five lines on the lead', async () => {
    await database.pool.query(`update clients set expansion_area = $1 where id = $2`, [
      JSON.stringify([{ uf: 'SP', city: 'Campinas' }]),
      WINGS_CLIENT_ID,
    ]);
    const leadId = await insertLead({
      client_id: WINGS_CLIENT_ID,
      name: 'Ana Souza',
      email: 'ana@aurora.com.br',
      phone: '5519999998888',
      source: 'rd_station',
    });
    const job = await insertJob(leadId);
    const queries: string[] = [];
    const zapiCalls: string[] = [];
    const cnpjCalls: string[] = [];

    const output = (await runEnrichLeadJob(
      job,
      baseContext({
        db: database.pool,
        enrichment: {
          zapi: {
            profileOf: async (phone): Promise<ZapiProfile> => {
              zapiCalls.push(phone);
              return { profileName: 'Ana S.', photoUrl: 'https://pps.whatsapp.net/ana.jpg' };
            },
          },
          search: {
            search: async (query) => {
              queries.push(query);
              if (query.includes('linkedin')) {
                return [
                  { title: 'Ana Souza - Sócia-diretora - Aurora | LinkedIn', url: 'https://www.linkedin.com/in/ana-souza', snippet: 'Sócia e diretora da Aurora Alimentos, CNPJ 12.345.678/0001-90.' },
                ];
              }
              return [{ title: 'Ana Souza (@ana.souza)', url: 'https://www.instagram.com/ana.souza/', snippet: 'Empreendedora' }];
            },
          },
          cnpj: {
            lookup: async (cnpj) => {
              cnpjCalls.push(cnpj);
              return {
                cnpj: '12.345.678/0001-90',
                legalName: 'AURORA ALIMENTOS LTDA',
                tradeName: 'Aurora Alimentos',
                capitalSocialBrl: 250000,
                openedAt: '2015-03-01',
                mainActivity: 'Fabricação de produtos de padaria',
                size: 'EPP',
                city: 'Campinas',
                uf: 'SP',
                status: 'ATIVA',
                partners: ['ANA CLARA DE SOUZA'],
              };
            },
          },
          budget: { dailyUsd: 2, searchUsdPerQuery: 0.005, researchDailyUsd: 1 },
        },
      }),
    )) as EnrichLeadOutput;

    expect(output).toMatchObject({ leadId, score: 100, searches: 2, linksFound: 2, companyFound: true, costUsdMicro: 10_000 });
    expect(zapiCalls).toEqual(['5519999998888']);
    // The client's name is nowhere in a query: only the person and the region.
    expect(queries).toEqual(['"Ana Souza" Campinas SP linkedin', '"Ana Souza" Campinas SP instagram']);
    expect(cnpjCalls).toEqual(['12345678000190']);

    const row = await leadRow(leadId);
    expect(row.enrichment_state).toBe('done');
    expect(row.enrichment_score).toBe(100);
    expect(String(row.enrichment_summary).split('\n')).toHaveLength(5);
    expect(row.enrichment_summary).toContain('Empresa: Aurora Alimentos (CNPJ 12.345.678/0001-90), capital social R$ 250.000, desde 2015');
    expect(row.whatsapp_profile_name).toBe('Ana S.');
    expect((row.enrichment_criteria as { key: string; points: number }[]).map((c) => [c.key, c.points])).toEqual([
      ['capital', 40],
      ['management', 30],
      ['location', 30],
    ]);
    expect((row.enrichment_links as { kind: string }[]).map((l) => l.kind)).toEqual(['linkedin', 'instagram']);

    const ledger = await ledgerRows(leadId);
    expect(ledger.map((r) => [r.step, r.status, r.usd_micro])).toEqual([
      ['zapi_profile', 'done', 0],
      ['web_search', 'started', 5000],
      ['web_search', 'done', 0],
      ['web_search', 'started', 5000],
      ['web_search', 'done', 0],
      ['brasilapi_cnpj', 'done', 0],
    ]);
    // Nothing personal in the ledger or on the timeline.
    const events = (await database.pool.query(`select kind, detail from lead_events where lead_id = $1 order by at`, [leadId])).rows;
    expect(events.map((e) => e.kind)).toEqual(['research.started', 'research.done']);
    expect(JSON.stringify([ledger, events])).not.toMatch(/Ana|aurora\.com|99999/);
  });

  it('refuses the paid searches once the daily ceiling is reached and still finishes with what is free', async () => {
    const leadId = await insertLead({ client_id: WINGS_CLIENT_ID, name: 'Bruno Lima', email: 'bruno@gmail.com', phone: '5531977776666', source: 'manual' });
    const job = await insertJob(leadId);
    let searched = 0;
    const output = (await runEnrichLeadJob(
      job,
      baseContext({
        db: database.pool,
        enrichment: {
          zapi: null,
          search: {
            search: async () => {
              searched += 1;
              return [];
            },
          },
          cnpj: { lookup: async () => null },
          // Two cents a day, and the first test already spent one cent.
          budget: { dailyUsd: 0.01, searchUsdPerQuery: 0.005, researchDailyUsd: 1 },
        },
      }),
    )) as EnrichLeadOutput;
    expect(searched).toBe(0);
    expect(output.steps).toMatchObject({ zapi_profile: 'skipped', web_search: 'refused', brasilapi_cnpj: 'skipped' });
    expect(output.costUsdMicro).toBe(0);
    const row = await leadRow(leadId);
    expect(row.enrichment_state).toBe('done');
    expect(row.enrichment_summary).toContain('Busca web não realizada.');
    expect(row.enrichment_summary).toContain('Belo Horizonte/MG pelo DDD 31');
    const ledger = await ledgerRows(leadId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ step: 'web_search', status: 'refused', usd_micro: 0 });
    expect(ledger[0]?.detail).toMatchObject({ spentTodayUsdMicro: 10_000, ceilingUsdMicro: 10_000 });
  });

  it('keeps going when Z-API fails, keeps the reserved cost when a search fails, and never sends a query without a name', async () => {
    const leadId = await insertLead({ client_id: WINGS_CLIENT_ID, name: 'Carla Dias', phone: '5541988887777', source: 'whatsapp_link' });
    const job = await insertJob(leadId);
    const output = (await runEnrichLeadJob(
      job,
      baseContext({
        db: database.pool,
        enrichment: {
          zapi: {
            profileOf: async () => {
              throw new Error('Z-API answered 500');
            },
          },
          search: {
            search: async () => {
              throw new Error('Brave Search answered 429');
            },
          },
          cnpj: { lookup: async () => null },
          budget: { dailyUsd: 5, searchUsdPerQuery: 0.005, researchDailyUsd: 1 },
        },
      }),
    )) as EnrichLeadOutput;
    expect(output.steps).toMatchObject({ zapi_profile: 'failed', web_search: 'done', brasilapi_cnpj: 'skipped' });
    expect(output.costUsdMicro).toBe(10_000);
    const ledger = await ledgerRows(leadId);
    expect(ledger.map((r) => [r.step, r.status, r.usd_micro])).toEqual([
      ['zapi_profile', 'failed', 0],
      ['web_search', 'started', 5000],
      ['web_search', 'failed', 0],
      ['web_search', 'started', 5000],
      ['web_search', 'failed', 0],
    ]);
    expect(JSON.stringify(ledger)).not.toContain('Carla');

    const nameless = await insertLead({ client_id: WINGS_CLIENT_ID, phone: '5541988880000', source: 'whatsapp_link' });
    const output2 = (await runEnrichLeadJob(
      await insertJob(nameless),
      baseContext({
        db: database.pool,
        enrichment: {
          zapi: null,
          search: {
            search: async () => {
              throw new Error('must not be called');
            },
          },
          cnpj: { lookup: async () => null },
          budget: { dailyUsd: 5, searchUsdPerQuery: 0.005, researchDailyUsd: 1 },
        },
      }),
    )) as EnrichLeadOutput;
    expect(output2.steps.web_search).toBe('skipped');
    expect(output2.searches).toBe(0);
  });

  it('marks the lead failed, with a message and no retry, when something unexpected breaks', async () => {
    const leadId = await insertLead({ client_id: WINGS_CLIENT_ID, name: 'Erro Total', phone: '5511911112222', source: 'manual' });
    const job = await insertJob(leadId);
    const broken = { ...database.pool, query: database.pool.query.bind(database.pool) } as typeof database.pool;
    let calls = 0;
    broken.query = ((...args: unknown[]) => {
      calls += 1;
      // The fourth statement is the client's expansion area read: make it explode.
      if (calls === 4) return Promise.reject(new Error('connection lost'));
      return (database.pool.query as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof database.pool.query;
    await expect(
      runEnrichLeadJob(
        job,
        baseContext({
          db: broken,
          enrichment: { zapi: null, search: null, cnpj: { lookup: async () => null }, budget: { dailyUsd: 5, searchUsdPerQuery: 0.005, researchDailyUsd: 1 } },
        }),
      ),
    ).rejects.toThrow('connection lost');
    const row = await leadRow(leadId);
    expect(row.enrichment_state).toBe('failed');
    expect(row.enrichment_error).toBe('connection lost');
  });

  it('sums today in São Paulo under a lock', async () => {
    const start = saoPauloDayStart(new Date('2026-09-23T01:30:00Z'));
    // 01:30 UTC is still the 22nd in São Paulo.
    expect(start.toISOString()).toBe('2026-09-22T03:00:00.000Z');
    const leadId = await insertLead({ client_id: WINGS_CLIENT_ID, name: 'Teto', phone: '5511933334444', source: 'manual' });
    const job = await insertJob(leadId);
    // One instant for the three calls: a midnight between two new Date() would sum another day.
    const now = new Date();
    const before = await spentTodayUsdMicro(database.pool, now);
    const ok = await reserveSpend(database.pool, { leadId, jobId: job.id, step: 'web_search', usdMicro: 1000, dailyUsd: 100, now });
    expect(ok).toBe(true);
    expect(await spentTodayUsdMicro(database.pool, now)).toBe(before + 1000);
  });
});
