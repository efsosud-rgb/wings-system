import { describe, expect, it } from 'vitest';
import {
  RESEARCH_MAX_RESULTS,
  createLeadResearchProvider,
  createOpenRouterResearch,
  fieldsOf,
  promptOf,
  researchInputOf,
  scrubResearchText,
  sourcesOf,
} from './lead-research.js';

const LEAD_ID = '00000000-0000-4000-8000-000000000001';
// A valid CNPJ (check digits computed): 11.222.333/0001-81.
const CNPJ = '11.222.333/0001-81';

const citation = (url: string, title = 'Página') => ({
  type: 'url_citation',
  url_citation: { url, title, content: 'texto' },
});

/** A fetch that records the request and answers like OpenRouter's chat completions. */
function fakeFetch(answer: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(answer), { status });
  }) as typeof fetch;
  return { impl, calls };
}

const GOOD_ANSWER = {
  choices: [
    {
      message: {
        content:
          'Aqui está:\n{"activity":{"value":"Rede de açaí","reason":null},"location":{"value":"Campinas/SP","reason":null},"size":{"value":null,"reason":"Nenhuma página fala do porte"},"time_in_market":{"value":"Desde 2015","reason":null},"online_presence":{"value":"Site e Instagram ativos","reason":null}}',
        annotations: [
          citation('https://acai.example.com.br/sobre#topo', 'Sobre'),
          citation('https://www.instagram.com/acai/'),
        ],
      },
    },
  ],
  usage: { prompt_tokens: 4000, completion_tokens: 300, cost: 0.031 },
};

describe('what may be sent about a lead', () => {
  it('keeps only the company name, the site address, the Instagram handle and a valid CNPJ', () => {
    expect(
      researchInputOf(LEAD_ID, {
        company_name: '  Açaí   da Fila ',
        website: 'https://acai.example.com.br/produtos?utm_source=x#top',
        instagram: '@Acai.Da.Fila',
        company_cnpj: CNPJ,
      }),
    ).toEqual({
      leadId: LEAD_ID,
      companyName: 'Açaí da Fila',
      website: 'https://acai.example.com.br/',
      instagram: 'acai.da.fila',
      cnpj: CNPJ,
    });
  });

  it('drops a value that looks like a person contact, a made-up CNPJ and an address that is not public', () => {
    expect(
      researchInputOf(LEAD_ID, {
        company_name: 'ana@gmail.com',
        website: 'http://192.168.0.1/admin',
        instagram: 'não tenho',
        company_cnpj: '11.222.333/0001-82',
      }),
    ).toBeNull();
    expect(
      researchInputOf(LEAD_ID, { company_name: 'Falar no (19) 99999-8888', instagram: 'acai' }),
    ).toEqual({
      leadId: LEAD_ID,
      companyName: null,
      website: null,
      instagram: 'acai',
      cnpj: null,
    });
    expect(researchInputOf(LEAD_ID, { company_name: '5519999998888' })).toBeNull();
    expect(researchInputOf(LEAD_ID, {})).toBeNull();
  });

  it('writes the prompt from the company fields only, one per line', () => {
    const text = promptOf({
      leadId: LEAD_ID,
      companyName: 'Açaí da Fila',
      website: null,
      instagram: 'acai',
      cnpj: CNPJ,
    });
    expect(text).toBe(
      `Pesquise esta empresa.\nEmpresa: Açaí da Fila\nInstagram: @acai\nCNPJ: ${CNPJ}`,
    );
  });
});

describe('reading the answer', () => {
  it('turns annotations into sources: public pages only, no fragment, no duplicate, at most five', () => {
    const sources = sourcesOf([
      citation('https://a.example.com/x#y', 'A'),
      citation('https://a.example.com/x', 'A de novo'),
      citation('javascript:alert(1)'),
      citation('https://user:pass@b.example.com/'),
      citation('http://localhost/x'),
      { type: 'file_citation', url_citation: { url: 'https://c.example.com/' } },
      citation('https://d.example.com/'),
      citation('https://e.example.com/'),
      citation('https://f.example.com/'),
      citation('https://g.example.com/'),
      citation('https://h.example.com/'),
    ]);
    expect(sources.map((s) => s.url)).toEqual([
      'https://a.example.com/x',
      'https://d.example.com/',
      'https://e.example.com/',
      'https://f.example.com/',
      'https://g.example.com/',
    ]);
    expect(sources).toHaveLength(RESEARCH_MAX_RESULTS);
    expect(sourcesOf(undefined)).toEqual([]);
  });

  it('takes the JSON out of surrounding text and leaves a missing or empty key as null with a reason', () => {
    const fields = fieldsOf(
      'texto antes {"activity":{"value":"Rede de açaí","reason":null},"size":{"value":"","reason":"Sem número de lojas"},"location":"Campinas/SP"} depois',
      true,
    );
    expect(fields.map((f) => f.key)).toEqual([
      'activity',
      'location',
      'size',
      'time_in_market',
      'online_presence',
    ]);
    expect(fields[0]).toEqual({ key: 'activity', value: 'Rede de açaí', reason: null });
    expect(fields[1]).toEqual({ key: 'location', value: 'Campinas/SP', reason: null });
    expect(fields[2]).toEqual({ key: 'size', value: null, reason: 'Sem número de lojas' });
    expect(fields[3]).toEqual({
      key: 'time_in_market',
      value: null,
      reason: 'As páginas encontradas não dizem isso',
    });
  });

  it('drops every value, with the reason, when no page backs it, and when the text is not JSON', () => {
    const none = fieldsOf('{"activity":{"value":"Inventado","reason":null}}', false);
    expect(
      none.every(
        (f) => f.value === null && f.reason === 'A busca não trouxe páginas para confirmar',
      ),
    ).toBe(true);
    const garbage = fieldsOf('não consegui', true);
    expect(garbage.every((f) => f.value === null && f.reason !== null)).toBe(true);
  });

  it('removes e-mails, phones and CPFs the model copied from a page, and keeps a CNPJ', () => {
    expect(
      scrubResearchText('Fale com ana@acai.com.br ou (19) 99999-8888, CPF 123.456.789-09'),
    ).toBe('Fale com [e-mail removido] ou [telefone removido], CPF [documento removido]');
    expect(scrubResearchText(`Empresa ${CNPJ} desde 2015`)).toBe(`Empresa ${CNPJ} desde 2015`);
    expect(scrubResearchText('CNPJ 11222333000181')).toBe('CNPJ 11222333000181');
    const fields = fieldsOf(
      '{"activity":{"value":"Contato: dono@acai.com.br","reason":null}}',
      true,
    );
    expect(fields[0]?.value).toBe('Contato: [e-mail removido]');
  });
});

describe('the OpenRouter provider', () => {
  const input = {
    leadId: LEAD_ID,
    companyName: 'Açaí da Fila',
    website: 'https://acai.example.com.br/',
    instagram: 'acai',
    cnpj: CNPJ,
  };

  it('asks for at most 5 web results, with data_collection deny, one model, and nothing but the company fields', async () => {
    const { impl, calls } = fakeFetch(GOOD_ANSWER);
    const provider = createOpenRouterResearch({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      reserveUsd: 0.06,
      fetchImpl: impl,
    });
    await provider.research(input);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown> & {
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('anthropic/claude-haiku-4.5');
    expect(body.plugins).toEqual([{ id: 'web', max_results: 5 }]);
    expect(body.provider).toEqual({ data_collection: 'deny' });
    expect(body.usage).toEqual({ include: true });
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[1]?.content).toBe(
      `Pesquise esta empresa.\nEmpresa: Açaí da Fila\nSite: https://acai.example.com.br/\nInstagram: @acai\nCNPJ: ${CNPJ}`,
    );
  });

  it('returns the five fields, the pages the search returned and the cost OpenRouter reported', async () => {
    const { impl } = fakeFetch(GOOD_ANSWER);
    const provider = createOpenRouterResearch({
      apiKey: 'sk-test',
      model: 'anthropic/claude-haiku-4.5',
      reserveUsd: 0.06,
      fetchImpl: impl,
    });
    const finding = await provider.research(input);
    expect(provider.reserveUsdMicro).toBe(60_000);
    expect(finding.costUsdMicro).toBe(31_000);
    expect(finding.model).toBe('anthropic/claude-haiku-4.5');
    expect(finding.sources.map((s) => s.url)).toEqual([
      'https://acai.example.com.br/sobre',
      'https://www.instagram.com/acai/',
    ]);
    expect(finding.fields.find((f) => f.key === 'activity')?.value).toBe('Rede de açaí');
    expect(finding.fields.find((f) => f.key === 'size')).toEqual({
      key: 'size',
      value: null,
      reason: 'Nenhuma página fala do porte',
    });
  });

  it('estimates the cost from the tokens and the results when none is reported, and reserves it when nothing is', async () => {
    const noCost = { ...GOOD_ANSWER, usage: { prompt_tokens: 4000, completion_tokens: 300 } };
    const provider = (answer: unknown) =>
      createOpenRouterResearch({
        apiKey: 'k',
        model: 'anthropic/claude-haiku-4.5',
        reserveUsd: 0.06,
        fetchImpl: fakeFetch(answer).impl,
      });
    // haiku: US$ 1 / 5 per million tokens -> 4000 + 1500 micro-dollars, plus 2 results at 4000.
    expect((await provider(noCost).research(input)).costUsdMicro).toBe(4000 + 1500 + 2 * 4000);
    expect((await provider({ choices: GOOD_ANSWER.choices }).research(input)).costUsdMicro).toBe(
      60_000,
    );
  });

  it('keeps nothing the model said when the search returned no page', async () => {
    const { impl } = fakeFetch({
      choices: [{ message: { content: GOOD_ANSWER.choices[0]?.message.content } }],
      usage: { cost: 0.01 },
    });
    const finding = await createOpenRouterResearch({
      apiKey: 'k',
      model: 'anthropic/claude-haiku-4.5',
      reserveUsd: 0.06,
      fetchImpl: impl,
    }).research(input);
    expect(finding.sources).toEqual([]);
    expect(finding.fields.every((f) => f.value === null)).toBe(true);
  });

  it('fails with a code and never with the provider text, the key or the request', async () => {
    const refused = createOpenRouterResearch({
      apiKey: 'sk-secret',
      model: 'anthropic/claude-haiku-4.5',
      reserveUsd: 0.06,
      fetchImpl: fakeFetch({ error: { message: 'Açaí da Fila sk-secret' } }, 500).impl,
    });
    await expect(refused.research(input)).rejects.toThrow(/^OpenRouter answered 500$/);

    const broken = createOpenRouterResearch({
      apiKey: 'sk-secret',
      model: 'anthropic/claude-haiku-4.5',
      reserveUsd: 0.06,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed for Bearer sk-secret Açaí da Fila');
      }) as typeof fetch,
    });
    const error = (await broken.research(input).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('OpenRouter did not answer (TypeError)');

    const inBody = createOpenRouterResearch({
      apiKey: 'k',
      model: 'anthropic/claude-haiku-4.5',
      reserveUsd: 0.06,
      fetchImpl: fakeFetch({ error: { code: 402, message: 'x' } }).impl,
    });
    await expect(inBody.research(input)).rejects.toThrow(/^OpenRouter reported an error$/);
  });

  it('logs the shape of the answer, never its text', async () => {
    const logged: Record<string, unknown>[] = [];
    const { impl } = fakeFetch(GOOD_ANSWER);
    await createOpenRouterResearch({
      apiKey: 'k',
      model: 'anthropic/claude-haiku-4.5',
      reserveUsd: 0.06,
      fetchImpl: impl,
      log: (facts) => logged.push(facts),
    }).research(input);
    expect(logged).toHaveLength(1);
    const text = JSON.stringify(logged[0]);
    expect(text).not.toContain('Rede de açaí');
    expect(text).not.toContain('acai.example.com.br');
    expect(text).toContain('string(');
  });
});

describe('switching it on', () => {
  it('needs the flag and the key', () => {
    const base = { model: 'anthropic/claude-haiku-4.5' as const, reserveUsd: 0.06 };
    expect(createLeadResearchProvider({ ...base, enabled: false, apiKey: 'k' })).toBeNull();
    expect(createLeadResearchProvider({ ...base, enabled: true })).toBeNull();
    expect(createLeadResearchProvider({ ...base, enabled: true, apiKey: 'k' })?.name).toBe(
      'openrouter',
    );
  });
});
