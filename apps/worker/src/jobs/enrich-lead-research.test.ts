import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LeadWebResearch } from '@wings/shared';
import {
  reserveSpend,
  type LeadResearchFinding,
  type LeadResearchInput,
  type LeadResearchProvider,
} from '../lib/enrichment.js';
import { baseContext } from '../test/context.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { researchFailureReasonOf, runEnrichLeadJob, type EnrichLeadOutput } from './enrich-lead.js';

describe('researchFailureReasonOf', () => {
  it('tells a refused key, no credit, a rate limit, another status and no answer apart, naming none of them by key', () => {
    expect(researchFailureReasonOf('OpenRouter answered 401')).toMatch(/recusou a chave do worker \(401\/403\)/);
    expect(researchFailureReasonOf('OpenRouter answered 403')).toMatch(/recusou a chave/);
    expect(researchFailureReasonOf('OpenRouter answered 402')).toMatch(/sem crédito \(402\)/);
    expect(researchFailureReasonOf('OpenRouter answered 429')).toMatch(/limitou as chamadas \(429\)/);
    expect(researchFailureReasonOf('OpenRouter answered 503')).toMatch(/respondeu com erro \(503\)/);
    expect(researchFailureReasonOf('OpenRouter did not answer (TimeoutError)')).toBe(
      'A pesquisa não terminou (o provedor não respondeu); nada foi inventado',
    );
    expect(researchFailureReasonOf('OpenRouter answered without the JSON that was asked for')).toMatch(
      /não no formato pedido/,
    );
  });
});

const WINGS_CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';
// A valid CNPJ (check digits computed): 11.222.333/0001-81.
const CNPJ = '11.222.333/0001-81';

const FINDING: LeadResearchFinding = {
  fields: [
    { key: 'activity', value: 'Rede de açaí', reason: null },
    { key: 'location', value: 'Campinas/SP', reason: null },
    { key: 'size', value: null, reason: 'Nenhuma página fala do porte' },
    { key: 'time_in_market', value: 'Desde 2015', reason: null },
    { key: 'online_presence', value: null, reason: 'As páginas encontradas não dizem isso' },
  ],
  sources: [{ url: 'https://acai.example.com.br/sobre', title: 'Sobre' }],
  model: 'anthropic/claude-haiku-4.5',
  costUsdMicro: 31_000,
};

function fakeProvider(
  options: { finding?: LeadResearchFinding; fail?: boolean; reserveUsdMicro?: number } = {},
) {
  const inputs: LeadResearchInput[] = [];
  const provider: LeadResearchProvider = {
    name: 'fake',
    reserveUsdMicro: options.reserveUsdMicro ?? 60_000,
    async research(input) {
      inputs.push(input);
      if (options.fail) throw new Error('OpenRouter answered 500');
      return options.finding ?? FINDING;
    },
  };
  return { provider, inputs };
}

describe('the company research step of enrich_lead', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, 60_000);
  afterAll(() => database.drop());

  async function insertLead(fields: Record<string, unknown>) {
    const columns = Object.keys(fields);
    const result = await database.pool.query<{ id: string }>(
      `insert into leads (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      Object.values(fields),
    );
    return result.rows[0]?.id as string;
  }
  async function insertJob(leadId: string) {
    const result = await database.pool.query<{ id: string }>(
      `insert into jobs (type, input) values ('enrich_lead', $1) returning id`,
      [JSON.stringify({ leadId })],
    );
    return {
      id: result.rows[0]?.id as string,
      type: 'enrich_lead' as const,
      input: { leadId },
      attempts: 1,
    };
  }
  const leadRow = async (id: string) =>
    (await database.pool.query(`select * from leads where id = $1`, [id])).rows[0] as Record<
      string,
      unknown
    >;
  const ledger = async (id: string) =>
    (
      await database.pool.query(
        `select step, status, usd_micro, detail from lead_enrichment_ledger where lead_id = $1 order by created_at, id`,
        [id],
      )
    ).rows as {
      step: string;
      status: string;
      usd_micro: number;
      detail: Record<string, unknown>;
    }[];
  const researchOf = async (id: string) =>
    ((await leadRow(id)).enrichment_facts as { webResearch?: LeadWebResearch }).webResearch;

  const companyLead = (extra: Record<string, unknown> = {}) =>
    insertLead({
      client_id: WINGS_CLIENT_ID,
      name: 'Ana Souza',
      email: 'ana@gmail.com',
      phone: '5519999998888',
      source: 'meta_lead_ads',
      company_name: 'Açaí da Fila',
      website: 'https://acai.example.com.br/',
      instagram: 'acai.da.fila',
      company_cnpj: CNPJ,
      ...extra,
    });

  function run(
    leadId: string,
    research: LeadResearchProvider | null,
    researchDailyUsd = 1,
    researchSince: Date | null = null,
  ) {
    return insertJob(leadId).then(
      (job) =>
        runEnrichLeadJob(
          job,
          baseContext({
            db: database.pool,
            enrichment: {
              zapi: null,
              search: null,
              cnpj: { lookup: async () => null },
              budget: { dailyUsd: 2, searchUsdPerQuery: 0.005, researchDailyUsd },
              research,
              researchSince,
            },
          }),
        ) as Promise<EnrichLeadOutput>,
    );
  }

  it('sends the provider the company fields only, and writes the finding with its sources and date', async () => {
    const leadId = await companyLead();
    const { provider, inputs } = fakeProvider();
    const output = await run(leadId, provider);

    // Not the person's name, phone or e-mail: the input has no place for them.
    expect(inputs).toEqual([
      {
        leadId,
        companyName: 'Açaí da Fila',
        website: 'https://acai.example.com.br/',
        instagram: 'acai.da.fila',
        // A gmail address says nothing about the company: no domain either.
        emailDomain: null,
      },
    ]);
    expect(JSON.stringify(inputs)).not.toMatch(/Ana|ana@|5519/);
    // The lead has a CNPJ on file; it is never part of what is sent.
    expect(JSON.stringify(inputs)).not.toMatch(/11\.?222\.?333|cnpj/i);

    const research = await researchOf(leadId);
    expect(research).toMatchObject({
      status: 'done',
      reason: null,
      model: 'anthropic/claude-haiku-4.5',
    });
    expect(research?.sources).toEqual(FINDING.sources);
    expect(research?.fields.find((f) => f.key === 'size')).toEqual({
      key: 'size',
      value: null,
      reason: 'Nenhuma página fala do porte',
    });
    expect(new Date(research?.at ?? '').getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await leadRow(leadId)).enrichment_state).toBe('done');
    expect(output.steps.web_research).toBe('done');
    // The reservation (60,000) is settled to what the call really cost (31,000): a second row of -29,000.
    expect(output.costUsdMicro).toBe(31_000);
    expect(await ledger(leadId)).toEqual([
      expect.objectContaining({ step: 'ai_research', status: 'started', usd_micro: 60_000 }),
      expect.objectContaining({
        step: 'ai_research',
        status: 'done',
        usd_micro: -29_000,
        detail: { actualUsdMicro: 31_000, sources: 1, answered: 3 },
      }),
    ]);
  });

  it('settles the reservation to the real cost, above it as well', async () => {
    const leadId = await companyLead();
    const { provider } = fakeProvider({ finding: { ...FINDING, costUsdMicro: 100_000 } });
    const output = await run(leadId, provider);
    expect(output.costUsdMicro).toBe(100_000);
    expect((await ledger(leadId)).map((row) => [row.status, row.usd_micro])).toEqual([
      ['started', 60_000],
      ['done', 40_000],
    ]);
  });

  it('refuses at its own ceiling without calling the provider, and says so on the lead', async () => {
    const leadId = await companyLead();
    const { provider, inputs } = fakeProvider({ reserveUsdMicro: 60_000 });
    // US$ 0.05 a day cannot fit one reservation of US$ 0.06 (and earlier tests spent today's).
    const output = await run(leadId, provider, 0.05);
    expect(inputs).toHaveLength(0);
    expect(output.steps.web_research).toBe('refused');
    expect(output.costUsdMicro).toBe(0);
    expect(await researchOf(leadId)).toMatchObject({
      status: 'refused',
      reason: 'O teto diário da pesquisa foi atingido; nenhuma chamada foi feita',
      fields: [],
      sources: [],
    });
    expect((await ledger(leadId)).map((row) => [row.step, row.status, row.usd_micro])).toEqual([
      ['ai_research', 'refused', 0],
    ]);
    expect((await leadRow(leadId)).enrichment_state).toBe('done');
  });

  it('counts the research against its own ceiling only, and the searches against theirs', async () => {
    const leadId = await companyLead();
    const job = await insertJob(leadId);
    const now = new Date();
    const base = { leadId, jobId: job.id, now };
    const sumOf = async (research: boolean) =>
      Number(
        (
          await database.pool.query<{ total: string }>(
            `select coalesce(sum(usd_micro), 0)::bigint as total from lead_enrichment_ledger where (step = 'ai_research') = $1`,
            [research],
          )
        ).rows[0]?.total,
      );
    // Research spend of its own, put here so this test does not depend on the ones above: a
    // search reservation under a ceiling smaller than that sum still fits, so it does not see it.
    expect(
      await reserveSpend(database.pool, {
        ...base,
        step: 'ai_research',
        usdMicro: 50_000,
        dailyUsd: 100,
      }),
    ).toBe(true);
    expect(await sumOf(true)).toBeGreaterThanOrEqual(50_000);
    expect(
      await reserveSpend(database.pool, {
        ...base,
        step: 'web_search',
        usdMicro: 1000,
        dailyUsd: 0.002,
      }),
    ).toBe(true);
    // And the research ceiling does not see the search row: it fits exactly up to its own sum.
    const own = await sumOf(true);
    expect(
      await reserveSpend(database.pool, {
        ...base,
        step: 'ai_research',
        usdMicro: 1000,
        dailyUsd: (own + 1000) / 1_000_000,
      }),
    ).toBe(true);
    expect(
      await reserveSpend(database.pool, {
        ...base,
        step: 'ai_research',
        usdMicro: 1000,
        dailyUsd: (own + 1000) / 1_000_000,
      }),
    ).toBe(false);
  });

  it('skips with the reason, and spends nothing, when the form brought no company data', async () => {
    const leadId = await companyLead({
      company_name: null,
      website: null,
      instagram: null,
      company_cnpj: null,
    });
    const { provider, inputs } = fakeProvider();
    const output = await run(leadId, provider);
    expect(inputs).toHaveLength(0);
    expect(output.steps.web_research).toBe('skipped');
    expect(output.costUsdMicro).toBe(0);
    expect(await researchOf(leadId)).toMatchObject({
      status: 'skipped',
      reason: 'O formulário não trouxe dado da empresa (nome, site, Instagram ou e-mail corporativo)',
    });
    expect((await ledger(leadId)).map((row) => [row.status, row.usd_micro])).toEqual([
      ['skipped', 0],
    ]);
  });

  it('keeps the reserved cost when the provider fails, says nothing was invented, and finishes the job', async () => {
    const leadId = await companyLead();
    const { provider } = fakeProvider({ fail: true });
    const output = await run(leadId, provider);
    expect(output.steps.web_research).toBe('failed');
    expect(output.costUsdMicro).toBe(60_000);
    expect(await researchOf(leadId)).toMatchObject({
      status: 'failed',
      reason: 'A pesquisa não terminou: o OpenRouter respondeu com erro (500); nada foi inventado',
      fields: [],
      sources: [],
    });
    expect((await ledger(leadId)).map((row) => [row.status, row.usd_micro])).toEqual([
      ['started', 60_000],
      ['failed', 0],
    ]);
    expect(JSON.stringify((await ledger(leadId)).map((row) => row.detail))).not.toMatch(
      /Açaí|acai\.example|Ana/,
    );
    expect((await leadRow(leadId)).enrichment_state).toBe('done');
  });

  it('does nothing and writes no research when no provider is configured', async () => {
    const leadId = await companyLead();
    const output = await run(leadId, null);
    expect(output.steps.web_research).toBeUndefined();
    expect(await researchOf(leadId)).toBeUndefined();
    expect(await ledger(leadId)).toEqual([]);
  });

  it('keeps a finished research on a re-run: no second call, no second payment, no overwrite', async () => {
    const leadId = await companyLead();
    const { provider, inputs } = fakeProvider();
    await run(leadId, provider);
    const first = await researchOf(leadId);
    const second = await run(leadId, provider);
    expect(inputs).toHaveLength(1);
    expect(second.steps.web_research).toBe('skipped');
    expect(second.costUsdMicro).toBe(0);
    expect(await researchOf(leadId)).toEqual(first);
    expect((await ledger(leadId)).at(-1)).toMatchObject({
      step: 'ai_research',
      status: 'skipped',
      usd_micro: 0,
      detail: { reason: 'already_done' },
    });
  });

  it('keeps what an earlier run found when the provider is switched off, and does not let a refusal overwrite it', async () => {
    const leadId = await companyLead();
    await run(leadId, fakeProvider().provider);
    const first = await researchOf(leadId);
    await run(leadId, null);
    expect(await researchOf(leadId)).toEqual(first);
    // At a ceiling that refuses everything, the finished research is still not replaced.
    await run(leadId, fakeProvider().provider, 0.01);
    expect(await researchOf(leadId)).toEqual(first);
  });

  it('searches again when the earlier result brought no page', async () => {
    const leadId = await companyLead();
    const empty: LeadResearchFinding = {
      ...FINDING,
      sources: [],
      fields: FINDING.fields.map((f) => ({
        ...f,
        value: null,
        reason: 'A busca não trouxe páginas para confirmar',
      })),
    };
    await run(leadId, fakeProvider({ finding: empty }).provider);
    const { provider, inputs } = fakeProvider();
    await run(leadId, provider);
    expect(inputs).toHaveLength(1);
    expect((await researchOf(leadId))?.sources).toEqual(FINDING.sources);
  });

  it('never sends the person name as the company, and a site the URL parser rejects does not fail the job', async () => {
    const leadId = await companyLead({
      company_name: 'ana souza',
      website: 'empresa.com.br:99999',
      instagram: null,
      company_cnpj: null,
    });
    const { provider, inputs } = fakeProvider();
    const output = await run(leadId, provider);
    // The only thing left is nothing: the name is the person's and the site is unusable.
    expect(inputs).toHaveLength(0);
    expect(output.steps.web_research).toBe('skipped');
    expect((await leadRow(leadId)).enrichment_state).toBe('done');
  });
  it('sends the domain of a corporate e-mail, never the address, and researches with it alone', async () => {
    const leadId = await companyLead({
      email: 'ana.souza@acaidafila.com.br',
      company_name: null,
      website: null,
      instagram: null,
    });
    const { provider, inputs } = fakeProvider();
    const output = await run(leadId, provider);
    expect(inputs).toEqual([
      { leadId, companyName: null, website: null, instagram: null, emailDomain: 'acaidafila.com.br' },
    ]);
    expect(JSON.stringify(inputs)).not.toMatch(/ana\.souza|@|11\.?222/);
    expect(output.steps.web_research).toBe('done');
  });

  it('researches only leads that arrived from the cut-off on: an older lead, even one converting again, is not', async () => {
    const since = new Date('2026-10-14T03:00:00Z'); // 00:00 of 14/10 in São Paulo
    const old = await companyLead({ created_at: new Date('2026-10-14T02:59:00Z') });
    const imported = await companyLead({
      created_at: new Date('2026-10-14T15:00:00Z'),
      entered_at: new Date('2026-09-20T12:00:00Z'),
    });
    const fresh = await companyLead({ created_at: new Date('2026-10-14T03:00:00Z') });
    const { provider, inputs } = fakeProvider();

    for (const leadId of [old, imported]) {
      const output = await run(leadId, provider, 1, since);
      expect(output.steps.web_research).toBe('skipped');
      expect(output.costUsdMicro).toBe(0);
      expect(await researchOf(leadId)).toMatchObject({
        status: 'skipped',
        reason:
          'Lead anterior a 14/10/2026: a pesquisa só roda para leads que chegaram a partir dessa data',
      });
      expect(await ledger(leadId)).toEqual([
        expect.objectContaining({
          step: 'ai_research',
          status: 'skipped',
          usd_micro: 0,
          detail: { reason: 'before_cutoff' },
        }),
      ]);
      // A second arrival (a reconversion queues the same job) still does not research it.
      await run(leadId, provider, 1, since);
    }
    expect(inputs).toHaveLength(0);

    const output = await run(fresh, provider, 1, since);
    expect(output.steps.web_research).toBe('done');
    expect(inputs.map((input) => input.leadId)).toEqual([fresh]);
  });
});
