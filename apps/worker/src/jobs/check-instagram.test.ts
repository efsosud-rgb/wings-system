import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SearchResult } from '../lib/enrichment.js';
import {
  createInstagramDiscovery,
  createInstagramJudge,
  judgeVerdictOf,
  outcomeOf,
  profilePageOf,
  type DiscoveryAnswer,
  type InstagramDiscovery,
  type InstagramJudge,
  type JudgeVerdict,
} from '../lib/instagram-check.js';
import { baseContext } from '../test/context.js';
import { createTestDatabase, type TestDatabase } from '../test/db.js';
import { runCheckInstagramJob } from './check-instagram.js';

const WINGS_CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';
const steps = (over: Partial<Parameters<typeof outcomeOf>[0]['steps']> = {}) => ({
  format: 'ok' as const,
  meta: 'skipped' as const,
  search: 'skipped' as const,
  ai: 'skipped' as const,
  ...over,
});

describe('what the steps mean together', () => {
  const none = { followers: null, posts: null };
  it('is fake only when Meta AND the search both looked and found nothing', () => {
    const both = outcomeOf({ steps: steps({ meta: 'not_found', search: 'not_found' }), found: 'nenhuma', ...none });
    expect(both).toMatchObject({ status: 'nao_encontrado', source: 'nenhuma', verdict: 'falso' });
    const metaOnly = outcomeOf({ steps: steps({ meta: 'not_found', search: 'skipped' }), found: 'nenhuma', ...none });
    expect(metaOnly).toMatchObject({ status: 'nao_encontrado', verdict: 'suspeito' });
    // The ceiling refusing the search is a look that did not happen too: suspect, never fake.
    const searchRefusedAfterMeta = outcomeOf({ steps: steps({ meta: 'not_found', search: 'refused' }), found: 'nenhuma', ...none });
    expect(searchRefusedAfterMeta).toMatchObject({ status: 'nao_encontrado', verdict: 'suspeito' });
  });

  it('never decides from a look that did not happen', () => {
    expect(outcomeOf({ steps: steps(), found: 'nenhuma', ...none })).toMatchObject({ status: 'erro', verdict: null });
    expect(outcomeOf({ steps: steps({ meta: 'error', search: 'error' }), found: 'nenhuma', ...none })).toMatchObject({ status: 'erro' });
    expect(outcomeOf({ steps: steps({ search: 'refused' }), found: 'nenhuma', ...none }).reason).toMatch(/teto diário/);
  });

  it('treats an invalid username as suspect, not fake (no look happened)', () => {
    expect(outcomeOf({ steps: steps({ format: 'invalid' }), found: 'nenhuma', ...none })).toMatchObject({
      status: 'nao_encontrado',
      verdict: 'suspeito',
    });
  });

  it('confirms a found profile unless the comparison says it is another company', () => {
    const found = { followers: 1200, posts: 80 };
    expect(outcomeOf({ steps: steps({ meta: 'found', ai: 'bate' }), found: 'meta', ...found })).toMatchObject({ status: 'confere', source: 'meta', followers: 1200 });
    expect(outcomeOf({ steps: steps({ search: 'found', ai: 'nao_bate' }), found: 'busca', ...none })).toMatchObject({ status: 'nao_bate', source: 'busca', verdict: null });
    expect(outcomeOf({ steps: steps({ meta: 'found', ai: 'error' }), found: 'meta', ...none })).toMatchObject({ status: 'confere' });
  });
});

describe('reading the providers', () => {
  const results: SearchResult[] = [
    { title: 'Aurora (@aurora.alimentos)', url: 'https://www.instagram.com/aurora.alimentos/', snippet: 'Padaria em Campinas' },
    { title: 'Post', url: 'https://www.instagram.com/p/abc/', snippet: 'x' },
    { title: 'Outro', url: 'https://aurora.com.br/instagram.com/aurora.alimentos', snippet: 'x' },
  ];
  it('takes only the profile page itself from a search', () => {
    expect(profilePageOf('aurora.alimentos', results)?.title).toBe('Aurora (@aurora.alimentos)');
    expect(profilePageOf('outra.pessoa', results)).toBeNull();
    expect(profilePageOf('p', results)).toBeNull();
  });

  it('reads Business Discovery: found, not visible, not authorised, rate limited', async () => {
    const answer = (status: number, body: unknown) =>
      createInstagramDiscovery({
        accountId: '1789',
        token: 'token-xyz',
        fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
      }).lookup('aurora');
    expect(
      await answer(200, { business_discovery: { username: 'aurora', name: 'Aurora', biography: 'Padaria', followers_count: 10, media_count: 3 } }),
    ).toMatchObject({ kind: 'found', name: 'Aurora', followers: 10, posts: 3 });
    expect(await answer(400, { error: { code: 110, message: 'Invalid user id' } })).toEqual({ kind: 'not_found' });
    expect(await answer(400, { error: { code: 100, error_subcode: 2207013 } })).toEqual({ kind: 'not_found' });
    expect(await answer(400, { error: { code: 190 } })).toMatchObject({ kind: 'error', reason: expect.stringMatching(/não está autorizada/) });
    expect(await answer(400, { error: { code: 4 } })).toMatchObject({ kind: 'error', reason: expect.stringMatching(/Limite/) });
  });

  it('puts the token in a header, never in the address', async () => {
    let seen: { url: string; auth: string | null } | null = null;
    await createInstagramDiscovery({
      accountId: '1789',
      token: 'token-xyz',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, auth: new Headers(init.headers).get('authorization') };
        return new Response('{}', { status: 400 });
      }) as unknown as typeof fetch,
    }).lookup('aurora');
    expect(seen).toMatchObject({ auth: 'Bearer token-xyz' });
    expect(seen!.url).not.toContain('token-xyz');
  });

  it('reads the model verdict strictly and prices it from the reported cost', async () => {
    expect(judgeVerdictOf('{"veredito":"bate"}')).toBe('bate');
    expect(judgeVerdictOf('{"veredito":"talvez"}')).toBeNull();
    let sent: string | null = null;
    const judge = createInstagramJudge({
      apiKey: 'k',
      model: 'anthropic/claude-haiku-4.5',
      reserveUsd: 0.004,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = String(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"veredito":"nao_bate"}' } }], usage: { cost: 0.0007 } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const answer = await judge.judge({
      profile: { name: 'Aurora', text: 'Padaria', website: null },
      companyName: 'Padaria Aurora',
      siteUrl: 'https://aurora.com.br',
    });
    expect(answer).toEqual({ verdict: 'nao_bate', costUsdMicro: 700 });
    // Only the company and the profile go out: no person, phone or e-mail field exists in the request.
    expect(sent).toContain('Padaria Aurora');
    expect(sent).toContain('data_collection');
  });
});

describe('the check_instagram job', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, 60_000);
  afterAll(() => database.drop());

  async function insertLead(fields: Record<string, unknown>) {
    const all = { client_id: WINGS_CLIENT_ID, name: 'Pessoa de Teste', source: 'site_form', ...fields };
    const columns = Object.keys(all);
    const result = await database.pool.query<{ id: string }>(
      `insert into leads (${columns.join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      Object.values(all),
    );
    return result.rows[0]!.id;
  }
  async function jobFor(leadId: string) {
    const result = await database.pool.query<{ id: string }>(
      `insert into jobs (type, input) values ('check_instagram', $1) returning id`,
      [JSON.stringify({ leadId })],
    );
    return { id: result.rows[0]!.id, type: 'check_instagram' as const, input: { leadId }, attempts: 1 };
  }
  const leadRow = async (id: string) =>
    (await database.pool.query(`select * from leads where id = $1`, [id])).rows[0] as Record<string, unknown>;
  const ledger = async (id: string) =>
    (await database.pool.query(`select step, status, usd_micro from lead_enrichment_ledger where lead_id = $1 order by created_at`, [id])).rows as {
      step: string;
      status: string;
      usd_micro: number;
    }[];

  const found: DiscoveryAnswer = { kind: 'found', name: 'Padaria Aurora', biography: 'Pães', website: 'https://aurora.com.br', followers: 900, posts: 40 };
  const config = (over: {
    enabled?: boolean;
    meta?: DiscoveryAnswer | null;
    judge?: JudgeVerdict | 'throws' | null;
    dailyUsd?: number;
  }) => {
    const calls = { meta: 0, search: 0, judge: 0 };
    const discovery: InstagramDiscovery | null =
      over.meta === null
        ? null
        : {
            lookup: async () => {
              calls.meta += 1;
              return over.meta ?? found;
            },
          };
    const judge: InstagramJudge | null =
      over.judge === null
        ? null
        : {
            name: 'fake-model',
            reserveUsdMicro: 4000,
            judge: async () => {
              calls.judge += 1;
              if (over.judge === 'throws') throw new Error('OpenRouter answered 500');
              return { verdict: over.judge ?? 'bate', costUsdMicro: 900 };
            },
          };
    return {
      calls,
      instagramCheck: { enabled: over.enabled ?? true, discovery, judge, dailyUsd: over.dailyUsd ?? 0.5 },
    };
  };
  const run = (leadId: string, job: Awaited<ReturnType<typeof jobFor>>, cfg: ReturnType<typeof config>, search: SearchResult[] | null) =>
    runCheckInstagramJob(
      job,
      baseContext({
        db: database.pool,
        instagramCheck: cfg.instagramCheck,
        enrichment: {
          zapi: null,
          search:
            search === null
              ? null
              : {
                  search: async () => {
                    cfg.calls.search += 1;
                    return search;
                  },
                },
          cnpj: { lookup: async () => null },
          budget: { dailyUsd: 2, searchUsdPerQuery: 0.005, researchDailyUsd: 1 },
        },
      }),
    );

  it('confirms a profile Meta sees, compares it with the company and keeps the cost in its own ledger', async () => {
    const leadId = await insertLead({ instagram: '@Aurora.Alimentos', company_name: 'Padaria Aurora', website: 'https://aurora.com.br' });
    const cfg = config({ judge: 'bate' });
    const output = await run(leadId, await jobFor(leadId), cfg, []);
    expect(output).toMatchObject({ status: 'confere', source: 'meta', verdict: null });
    expect(cfg.calls).toEqual({ meta: 1, search: 0, judge: 1 });
    const row = await leadRow(leadId);
    expect(row).toMatchObject({ instagram_check_status: 'confere', instagram_check_source: 'meta', instagram_verdict_effective: null });
    expect(row.instagram_check_detail).toMatchObject({ followers: 900, posts: 40, steps: { meta: 'found', ai: 'bate' } });
    expect((row.field_checks as { instagram: { status: string } }).instagram.status).toBe('confere');
    expect(await ledger(leadId)).toEqual([
      { step: 'ig_meta', status: 'done', usd_micro: 0 },
      { step: 'ig_ai', status: 'started', usd_micro: 4000 },
      { step: 'ig_ai', status: 'done', usd_micro: -3100 },
    ]);
    const events = await database.pool.query(`select kind from lead_events where lead_id = $1`, [leadId]);
    expect(events.rows.map((r) => r.kind)).toContain('instagram.checked');
  });

  it('falls back to the search when Meta does not see the profile, and counts that as found by the search', async () => {
    const leadId = await insertLead({ instagram: 'conta.pessoal' });
    const cfg = config({ meta: { kind: 'not_found' }, judge: null });
    const output = await run(
      leadId,
      await jobFor(leadId),
      cfg,
      [{ title: 'Conta (@conta.pessoal)', url: 'https://www.instagram.com/conta.pessoal/', snippet: 'Bio' }],
    );
    expect(output).toMatchObject({ status: 'confere', source: 'busca' });
    expect((await ledger(leadId)).map((r) => r.step)).toEqual(['ig_meta', 'ig_search', 'ig_search']);
  });

  it('marks a profile found nowhere as fake, and a half look as merely suspect', async () => {
    const both = await insertLead({ instagram: 'nao.existe.mesmo' });
    expect(await run(both, await jobFor(both), config({ meta: { kind: 'not_found' }, judge: null }), [])).toMatchObject({
      status: 'nao_encontrado',
      verdict: 'falso',
    });
    expect(await leadRow(both)).toMatchObject({ instagram_verdict: 'falso', instagram_verdict_effective: 'falso' });
    const half = await insertLead({ instagram: 'so.meta.olhou' });
    expect(await run(half, await jobFor(half), config({ meta: { kind: 'not_found' }, judge: null }), null)).toMatchObject({
      status: 'nao_encontrado',
      verdict: 'suspeito',
    });
  });

  it('keeps a seller\'s correction when the check runs again', async () => {
    const leadId = await insertLead({ instagram: 'nao.existe.mesmo', instagram_manual: 'confere', instagram_manual_at: new Date() });
    await run(leadId, await jobFor(leadId), config({ meta: { kind: 'not_found' }, judge: null }), []);
    expect(await leadRow(leadId)).toMatchObject({ instagram_verdict: 'falso', instagram_verdict_effective: null });
  });

  it('says "erro" and spends nothing when the paid steps are over the daily ceiling', async () => {
    const leadId = await insertLead({ instagram: 'qualquer.perfil' });
    const output = await run(leadId, await jobFor(leadId), config({ meta: { kind: 'error', reason: 'x' }, judge: null, dailyUsd: 0.001 }), [
      { title: 'x', url: 'https://www.instagram.com/qualquer.perfil/', snippet: '' },
    ]);
    expect(output).toMatchObject({ status: 'erro', source: 'nenhuma' });
    expect((await ledger(leadId)).some((r) => r.step === 'ig_search' && r.status === 'refused')).toBe(true);
    expect((await leadRow(leadId)).instagram_check_detail).toMatchObject({ reason: expect.stringMatching(/teto diário/) });
  });

  it('keeps "confere" when only the comparison failed, and never retries the paid call', async () => {
    const leadId = await insertLead({ instagram: 'aurora', company_name: 'Padaria Aurora' });
    const cfg = config({ judge: 'throws' });
    expect(await run(leadId, await jobFor(leadId), cfg, [])).toMatchObject({ status: 'confere' });
    expect(cfg.calls.judge).toBe(1);
    expect((await leadRow(leadId)).instagram_check_detail).toMatchObject({ reason: expect.stringMatching(/comparação/) });
  });

  it('does nothing without the switch, and clears the waiting mark of a lead with no Instagram', async () => {
    const off = await insertLead({ instagram: 'aurora' });
    expect(await run(off, await jobFor(off), config({ enabled: false }), [])).toEqual({ leadId: off, skipped: 'disabled' });
    const none = await insertLead({ instagram: 'Não tenho', instagram_check_status: 'pendente' });
    expect(await run(none, await jobFor(none), config({}), [])).toMatchObject({ skipped: 'no_instagram' });
    expect((await leadRow(none)).instagram_check_status).toBeNull();
  });

  it('counts its paid steps against its own ceiling, apart from the research and the searches', async () => {
    const leadId = await insertLead({ instagram: 'perfil.novo' });
    await database.pool.query(
      `insert into lead_enrichment_ledger (lead_id, step, status, usd_micro) values ($1, 'web_search', 'started', 1900000), ($1, 'ai_research', 'started', 990000)`,
      [leadId],
    );
    const output = await run(leadId, await jobFor(leadId), config({ meta: { kind: 'not_found' }, judge: null }), []);
    // The other ledgers are full to the brim and the Instagram ceiling is untouched: the search still ran.
    expect(output).toMatchObject({ status: 'nao_encontrado', verdict: 'falso' });
  });
});
