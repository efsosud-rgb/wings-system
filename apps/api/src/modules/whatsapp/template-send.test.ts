import { describe, expect, it } from 'vitest';
import {
  ART_MISSING_BRAND,
  ART_MISSING_WINGS,
  ART_VERSION_PENDING,
  ARTICLE_MISSING,
  payloadOf,
  planTemplate,
  toFreeMessage,
  unsupportedOf,
  type PlanInput,
  type TemplateRow,
} from './template-send.js';
import { errorText } from './graph.js';
import { callPermissionText } from './thread.js';

/**
 * Which message a template becomes, with no database and no Meta: the window,
 * the `_arte` version, the articles, the buttons a common message can carry,
 * and what goes to Meta.
 */

const quick = (...titles: string[]) => ({
  type: 'BUTTONS',
  buttons: titles.map((text) => ({ type: 'QUICK_REPLY', text })),
});
const imageHeader = { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::aW'] } };
const row = (
  name: string,
  category: string,
  body: string,
  ...more: Record<string, unknown>[]
): TemplateRow => ({
  name,
  language: 'pt_BR',
  category,
  components: [{ type: 'BODY', text: body }, ...more],
});

// The texts sent to Meta on 07/10 (modelos-whatsapp-2026-10-07.json, modelos-arte-12).
const T = {
  boasVindas: row(
    'expansao_boas_vindas',
    'MARKETING',
    'Olá, {{1}}! Aqui é {{2}}, do time de expansão da {{3}}. Recebemos o seu interesse em abrir uma unidade da rede. Posso te enviar as informações por aqui?',
    quick('Sim, pode enviar', 'Prefiro uma ligação'),
  ),
  boasVindasArte: row(
    'expansao_boas_vindas_arte',
    'UTILITY',
    'Olá, {{1}}! Aqui é {{2}}, do time de expansão {{3}}. Recebemos o seu interesse em abrir uma unidade da rede. Posso te enviar as informações por aqui?',
    imageHeader,
    quick('Sim, pode enviar', 'Prefiro uma ligação'),
  ),
  /** The same name on the test account, still with the first text ("da {{3}}"). */
  boasVindasArteAntigo: row(
    'expansao_boas_vindas_arte',
    'UTILITY',
    'Olá, {{1}}! Aqui é {{2}}, do time de expansão da {{3}}. Recebemos o seu interesse em abrir uma unidade da rede. Posso te enviar as informações por aqui?',
    imageHeader,
    quick('Sim, pode enviar', 'Prefiro uma ligação'),
  ),
  cof: row(
    'expansao_cof_enviada',
    'UTILITY',
    'Olá, {{1}}! A Circular de Oferta de Franquia (COF) da {{2}} foi enviada para o seu e-mail. Leia com calma e me chame aqui para tirar qualquer dúvida.',
  ),
  cofArte: row(
    'expansao_cof_enviada_arte',
    'UTILITY',
    'Olá, {{1}}! A Circular de Oferta de Franquia (COF) {{2}} foi enviada para o seu e-mail. Leia com calma e me chame aqui para tirar qualquer dúvida.',
    imageHeader,
  ),
  retomar: row(
    'expansao_retomar_contato',
    'MARKETING',
    'Olá, {{1}}! Tudo bem? Conversamos há alguns dias sobre a franquia {{2}}. Ainda tem interesse em abrir a sua unidade?',
    { type: 'FOOTER', text: 'Para não receber mais mensagens, responda SAIR.' },
    quick('Sim, quero continuar', 'Não tenho interesse'),
  ),
  formatacaoBoasVindasArte: row(
    'wings_formatacao_boas_vindas_arte',
    'UTILITY',
    'Olá, {{1}}! Aqui é {{2}}, da Wings Company. Recebemos o seu interesse em transformar {{3}} em franquia. Posso te fazer algumas perguntas rápidas por aqui?',
    imageHeader,
    quick('Sim, pode perguntar', 'Prefiro uma ligação'),
  ),
  formatacaoBoasVindas: row(
    'wings_formatacao_boas_vindas',
    'UTILITY',
    'Olá, {{1}}! Aqui é {{2}}, da Wings Company. Recebemos o seu interesse em transformar a {{3}} em franquia. Posso te fazer algumas perguntas rápidas por aqui?',
    quick('Sim, pode perguntar', 'Prefiro uma ligação'),
  ),
};

const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  request: { name: 'expansao_boas_vindas', language: 'pt_BR', params: [], companyArticle: 'a' },
  templates: [T.boasVindas, T.boasVindasArte],
  window: { open: false, expiresAt: null },
  voice: { name: 'Malkuth', article: 'a' },
  hasArt: true,
  defaults: { lead: 'Ricardo', seller: 'Fernando', company: 'Padaria Pão Dourado' },
  ...over,
});

const ok = (input: PlanInput) => {
  const plan = planTemplate(input);
  if (!plan.ok) throw new Error(`refused: ${plan.error}`);
  return plan;
};

describe('which template goes with the window closed', () => {
  it('the _arte version with the art in the header and "da"/"do" inside the field', () => {
    const plan = ok(base());
    expect(plan.version.name).toBe('expansao_boas_vindas_arte');
    expect(plan.preview).toMatchObject({
      family: 'expansao_boas_vindas',
      sendAs: 'template',
      charged: true,
      withArt: true,
      text: 'Olá, Ricardo! Aqui é Fernando, do time de expansão da Malkuth. Recebemos o seu interesse em abrir uma unidade da rede. Posso te enviar as informações por aqui?',
      notices: [],
      ready: true,
    });
    expect(plan.needsArt).toBe(true);
    expect(payloadOf(plan, 'MEDIA42')).toEqual({
      type: 'template',
      template: {
        name: 'expansao_boas_vindas_arte',
        language: { code: 'pt_BR' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { id: 'MEDIA42' } }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Ricardo' },
              { type: 'text', text: 'Fernando' },
              { type: 'text', text: 'da Malkuth' },
            ],
          },
        ],
      },
    });
    const masculine = ok(base({ voice: { name: 'Casal do Churros', article: 'o' } }));
    expect(masculine.params[2]).toBe('do Casal do Churros');
    // A brand whose name starts with an article is not given a second one.
    const cabana = ok(base({ voice: { name: 'A Cabana da Barra', article: 'a' } }));
    expect(cabana.params[2]).toBe('da Cabana da Barra');
    expect(cabana.preview.text).toContain('do time de expansão da Cabana da Barra.');
  });

  it('the first version, with a notice, when the brand has no art', () => {
    const plan = ok(base({ hasArt: false }));
    expect(plan.version.name).toBe('expansao_boas_vindas');
    expect(plan.params).toEqual(['Ricardo', 'Fernando', 'Malkuth']);
    expect(plan.preview.notices).toEqual([ART_MISSING_BRAND]);
    expect(plan.needsArt).toBe(false);
    expect(payloadOf(plan, null)).toMatchObject({
      template: { name: 'expansao_boas_vindas', components: [{ type: 'body' }] },
    });
    // Wings' own conversation names where the Wings art is kept.
    expect(ok(base({ hasArt: false, voice: null })).preview.notices).toEqual([ART_MISSING_WINGS]);
  });

  it('never doubles the article of a name that has its own in the first version either', () => {
    // A Cabana da Barra has no art: its templates go by the first version ("expansão da {{3}}").
    const cabana = { name: 'A Cabana da Barra', article: 'a' as const };
    const plan = ok(base({ hasArt: false, voice: cabana }));
    expect(plan.version.name).toBe('expansao_boas_vindas');
    expect(plan.params[2]).toBe('Cabana da Barra');
    expect(plan.preview.text).toContain('do time de expansão da Cabana da Barra.');
    // The seller still sees the brand as it is registered.
    expect(plan.preview.fields[2]).toMatchObject({ value: 'A Cabana da Barra', locked: true });
    // The art version not approved yet, and the old text on the art version: the same.
    expect(ok(base({ voice: cabana, templates: [T.boasVindas] })).params[2]).toBe(
      'Cabana da Barra',
    );
    expect(
      ok(base({ voice: cabana, templates: [T.boasVindas, T.boasVindasArteAntigo] })).preview.text,
    ).toContain('do time de expansão da Cabana da Barra.');
    const cof = ok(
      base({
        hasArt: false,
        voice: cabana,
        request: {
          name: 'expansao_cof_enviada',
          language: 'pt_BR',
          params: [],
          companyArticle: 'a',
        },
        templates: [T.cof, T.cofArte],
      }),
    );
    expect(cof.preview.text).toContain('(COF) da Cabana da Barra foi enviada');
    // Where the text has no article before the name, the name keeps its own.
    const retomar = ok(
      base({
        hasArt: false,
        voice: cabana,
        request: {
          name: 'expansao_retomar_contato',
          language: 'pt_BR',
          params: [],
          companyArticle: 'a',
        },
        templates: [T.retomar],
      }),
    );
    expect(retomar.preview.text).toContain('sobre a franquia A Cabana da Barra.');
    // The same for the lead's company in Formatação: "transformar a Padaria Real".
    const formatacao = ok(
      base({
        hasArt: false,
        voice: null,
        request: {
          name: 'wings_formatacao_boas_vindas',
          language: 'pt_BR',
          params: ['Mariana', 'Daniele', 'A Padaria Real'],
          companyArticle: 'a',
        },
        templates: [T.formatacaoBoasVindas, T.formatacaoBoasVindasArte],
      }),
    );
    expect(formatacao.preview.text).toContain('transformar a Padaria Real em franquia');
    // A name whose article disagrees with the text's stays whole: never "a Bar do Zé".
    const masculine = ok({
      ...base({
        hasArt: false,
        voice: null,
        templates: [T.formatacaoBoasVindas, T.formatacaoBoasVindasArte],
      }),
      request: {
        name: 'wings_formatacao_boas_vindas',
        language: 'pt_BR',
        params: ['Mariana', 'Daniele', 'O Bar do Zé'],
        companyArticle: 'o',
      },
    });
    expect(masculine.params[2]).toBe('O Bar do Zé');
  });

  it('the first version when the art version is not approved yet, saying so', () => {
    const plan = ok(base({ templates: [T.boasVindas] }));
    expect(plan.version.name).toBe('expansao_boas_vindas');
    expect(plan.preview.notices).toEqual([ART_VERSION_PENDING]);
  });

  it('refuses an art-only template when there is no art', () => {
    const plan = planTemplate(
      base({
        request: {
          name: 'expansao_cof_enviada_arte',
          language: 'pt_BR',
          params: [],
          companyArticle: 'a',
        },
        templates: [T.cofArte],
        hasArt: false,
      }),
    );
    expect(plan).toMatchObject({ ok: false, error: 'art_missing' });
  });

  it('never doubles the article on a template made with the old text', () => {
    const plan = ok(base({ templates: [T.boasVindas, T.boasVindasArteAntigo] }));
    expect(plan.version.name).toBe('expansao_boas_vindas_arte');
    expect(plan.params[2]).toBe('Malkuth');
    expect(plan.preview.text).toContain('do time de expansão da Malkuth.');
  });

  it('puts "da" and asks for the article when the brand has none', () => {
    const plan = ok(base({ voice: { name: 'Pecan', article: null } }));
    expect(plan.params[2]).toBe('da Pecan');
    expect(plan.preview.notices).toContain(ARTICLE_MISSING);
  });

  it("always fills the conversation's brand, whatever was typed", () => {
    const plan = ok(
      base({
        request: {
          name: 'expansao_boas_vindas',
          language: 'pt_BR',
          params: ['Ricardo', 'Fernando', 'Outra Marca'],
          companyArticle: 'a',
        },
      }),
    );
    expect(plan.params[2]).toBe('da Malkuth');
    expect(plan.preview.fields[2]).toMatchObject({ role: 'brand', value: 'Malkuth', locked: true });
  });

  it('is not ready while a field is empty', () => {
    const plan = ok(base({ defaults: { lead: '', seller: 'Fernando', company: '' } }));
    expect(plan.preview.ready).toBe(false);
    expect(plan.preview.fields[0]).toMatchObject({
      role: 'lead',
      label: 'Nome do lead',
      value: '',
    });
  });

  it('a lead without a company goes with "sua empresa", never empty (lead 775262e5, 26/10)', () => {
    const input = base({
      request: {
        name: 'wings_formatacao_boas_vindas',
        language: 'pt_BR',
        params: [],
        companyArticle: 'o',
      },
      templates: [T.formatacaoBoasVindas, T.formatacaoBoasVindasArte],
      voice: null,
      defaults: { lead: 'Mariana', seller: 'Daniele', company: '' },
    });
    const arte = ok(input);
    expect(arte.preview.ready).toBe(true);
    expect(arte.preview.fields[2]).toMatchObject({ role: 'company', value: 'sua empresa' });
    // Feminine even with "o" ticked.
    expect(arte.preview.text).toContain('transformar a sua empresa em franquia');
    expect(arte.preview.notices.join(' ')).toContain('empresa do lead → "sua empresa"');
    // The first version carries the "a" in its text.
    expect(ok({ ...input, hasArt: false }).preview.text).toContain(
      'transformar a sua empresa em franquia',
    );
    // A seller who clears the field gets the fallback back, never an empty parameter.
    const cleared = ok({
      ...input,
      request: { ...input.request, params: ['Mariana', 'Daniele', ''] },
    });
    expect(cleared.params[2]).toBe('a sua empresa');
    // What the seller types wins.
    const typed = ok({
      ...input,
      request: { ...input.request, params: ['Mariana', 'Daniele', 'Bar do Zé'] },
    });
    expect(typed.params[2]).toBe('o Bar do Zé');
    expect(typed.preview.notices.join(' ')).not.toContain('texto padrão');
  });

  it('puts the company article the seller chose (feminine by default)', () => {
    const input = base({
      request: {
        name: 'wings_formatacao_boas_vindas',
        language: 'pt_BR',
        params: [],
        companyArticle: 'a',
      },
      templates: [T.formatacaoBoasVindas, T.formatacaoBoasVindasArte],
      voice: null,
    });
    const feminine = ok(input);
    expect(feminine.preview.text).toContain('transformar a Padaria Pão Dourado em franquia');
    expect(feminine.preview.usesCompanyArticle).toBe(true);
    const masculine = ok({
      ...input,
      request: {
        ...input.request,
        params: ['Mariana', 'Daniele', 'Bar do Zé'],
        companyArticle: 'o',
      },
    });
    expect(masculine.params[2]).toBe('o Bar do Zé');
    // The first version has the article in its text: the switch does not apply.
    const noArt = ok({ ...input, hasArt: false });
    expect(noArt.params[2]).toBe('Padaria Pão Dourado');
    expect(noArt.preview.usesCompanyArticle).toBe(false);
  });
});

describe('with the window open', () => {
  const open = { open: true, expiresAt: '2026-10-08T15:00:00.000Z' };

  it('a common message from the first version keeps the article single too', () => {
    const plan = ok(
      base({
        window: open,
        hasArt: false,
        voice: { name: 'A Cabana da Barra', article: 'a' },
      }),
    );
    expect(plan.free).not.toBeNull();
    expect(plan.preview.sendAs).toBe('free');
    expect(plan.preview.text).toContain('do time de expansão da Cabana da Barra.');
    expect(JSON.stringify(payloadOf(plan, null))).not.toContain('da A Cabana');
  });

  it('goes as a common message: the art in the header, the reply buttons, no charge', () => {
    const plan = ok(base({ window: open }));
    expect(plan.preview).toMatchObject({
      sendAs: 'free',
      charged: false,
      reason: null,
      windowExpiresAt: open.expiresAt,
      withArt: true,
      buttons: ['Sim, pode enviar', 'Prefiro uma ligação'],
    });
    expect(payloadOf(plan, 'MEDIA42')).toEqual({
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'image', image: { id: 'MEDIA42' } },
        body: { text: plan.preview.text },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'modelo_resposta_1', title: 'Sim, pode enviar' } },
            { type: 'reply', reply: { id: 'modelo_resposta_2', title: 'Prefiro uma ligação' } },
          ],
        },
      },
    });
  });

  it('carries the footer and, with no art, no header', () => {
    const plan = ok(
      base({
        window: open,
        hasArt: false,
        request: {
          name: 'expansao_retomar_contato',
          language: 'pt_BR',
          params: [],
          companyArticle: 'a',
        },
        templates: [T.retomar],
      }),
    );
    expect(payloadOf(plan, null)).toEqual({
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: 'Olá, Ricardo! Tudo bem? Conversamos há alguns dias sobre a franquia Malkuth. Ainda tem interesse em abrir a sua unidade?',
        },
        footer: { text: 'Para não receber mais mensagens, responda SAIR.' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'modelo_resposta_1', title: 'Sim, quero continuar' } },
            { type: 'reply', reply: { id: 'modelo_resposta_2', title: 'Não tenho interesse' } },
          ],
        },
      },
    });
  });

  it('without buttons: the art with the text under it, or plain text', () => {
    const cof = {
      request: {
        name: 'expansao_cof_enviada',
        language: 'pt_BR',
        params: [],
        companyArticle: 'a' as const,
      },
      templates: [T.cof, T.cofArte],
    };
    const withArt = ok(base({ window: open, ...cof }));
    expect(withArt.version.name).toBe('expansao_cof_enviada_arte');
    expect(payloadOf(withArt, 'MEDIA42')).toEqual({
      type: 'image',
      image: {
        id: 'MEDIA42',
        caption:
          'Olá, Ricardo! A Circular de Oferta de Franquia (COF) da Malkuth foi enviada para o seu e-mail. Leia com calma e me chame aqui para tirar qualquer dúvida.',
      },
    });
    const without = ok(base({ window: open, hasArt: false, ...cof }));
    expect(payloadOf(without, null)).toMatchObject({ type: 'text', text: { preview_url: false } });
  });

  it('one link button becomes a cta_url', () => {
    const link = row('expansao_material', 'UTILITY', 'Olá, {{1}}! O material está no link.', {
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'Abrir material', url: 'https://exemplo.com.br/m' }],
    });
    const plan = ok(
      base({
        window: open,
        hasArt: false,
        request: {
          name: 'expansao_material',
          language: 'pt_BR',
          params: ['Ricardo'],
          companyArticle: 'a',
        },
        templates: [link],
      }),
    );
    // A template not in the table: its fields are free, typed as they go.
    expect(plan.preview.fields).toEqual([
      { index: 1, role: 'free', label: 'Campo {{1}}', value: 'Ricardo', locked: false },
    ]);
    expect(payloadOf(plan, null)).toEqual({
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: 'Olá, Ricardo! O material está no link.' },
        action: {
          name: 'cta_url',
          parameters: { display_text: 'Abrir material', url: 'https://exemplo.com.br/m' },
        },
      },
    });
  });

  it('a combination a common message cannot carry goes as the template, saying why (a utility one free)', () => {
    const mixed = row('expansao_mista', 'MARKETING', 'Olá, {{1}}!', {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Quero' },
        { type: 'URL', text: 'Site', url: 'https://exemplo.com.br' },
      ],
    });
    const plan = ok(
      base({
        window: open,
        hasArt: false,
        request: { name: 'expansao_mista', language: 'pt_BR', params: [], companyArticle: 'a' },
        templates: [mixed],
      }),
    );
    expect(plan.preview).toMatchObject({
      sendAs: 'template',
      charged: true,
      reason: 'A mensagem comum não junta link com botões de resposta.',
    });
    // The same as a utility template: inside the window Meta does not charge it.
    const utility = ok(
      base({
        window: open,
        hasArt: false,
        request: { name: 'expansao_mista', language: 'pt_BR', params: [], companyArticle: 'a' },
        templates: [{ ...mixed, category: 'UTILITY' }],
      }),
    );
    expect(utility.preview).toMatchObject({ sendAs: 'template', charged: false });
    const reasons = [
      [{ type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '+5521' }],
      [{ type: 'COPY_CODE', text: 'Copiar' }],
      [1, 2, 3, 4].map((n) => ({ type: 'QUICK_REPLY', text: `Opção ${n}` })),
      [{ type: 'QUICK_REPLY', text: 'Um título com mais de vinte letras' }],
      [{ type: 'URL', text: 'Abrir', url: 'https://exemplo.com.br/{{1}}' }],
    ].map((buttons) =>
      toFreeMessage(row('x', 'UTILITY', 'Olá', { type: 'BUTTONS', buttons }), 'Olá', false),
    );
    expect(reasons).toEqual([
      'A mensagem comum não tem botão de ligar.',
      'A mensagem comum não tem esse tipo de botão (código, formulário…).',
      'A mensagem comum leva até 3 botões de resposta.',
      'O botão "Um título com mais de vinte letras" passa de 20 letras e não cabe na mensagem comum.',
      'O link deste modelo tem uma parte variável: só vai como modelo.',
    ]);
    const video = toFreeMessage(
      row('x', 'UTILITY', 'Olá', { type: 'HEADER', format: 'VIDEO' }),
      'Olá',
      true,
    );
    expect(video).toMatch(/cabeçalho/);
  });
});

describe('refusals', () => {
  it('an unknown template, or one of another language', () => {
    expect(
      planTemplate(
        base({ request: { name: 'nada', language: 'pt_BR', params: [], companyArticle: 'a' } }),
      ),
    ).toMatchObject({ ok: false, error: 'template_unknown' });
    expect(
      planTemplate(
        base({
          request: {
            name: 'expansao_boas_vindas',
            language: 'en_US',
            params: [],
            companyArticle: 'a',
          },
        }),
      ),
    ).toMatchObject({ ok: false, error: 'template_unknown' });
  });
});

describe('the call-permission text', () => {
  it('names the brand with its own article, capitalised', () => {
    expect(callPermissionText(null)).toMatch(/^A Wings gostaria de poder te ligar/);
    expect(callPermissionText({ name: 'Malkuth', article: 'a' })).toMatch(/^A Malkuth gostaria/);
    expect(callPermissionText({ name: 'Casal do Churros', article: 'o' })).toMatch(
      /^O Casal do Churros gostaria/,
    );
    expect(callPermissionText({ name: 'A Cabana da Barra', article: 'a' })).toMatch(
      /^A Cabana da Barra gostaria/,
    );
    expect(callPermissionText({ name: 'Pecan', article: null })).toMatch(/^A Pecan gostaria/);
  });
});

describe('a template written on the Modelos screen', () => {
  const custom = {
    ...row('lembrete_simples', 'UTILITY', 'Oi, {{1}}! Até {{2}}.', quick('Prefiro uma ligação')),
    fields: [
      { role: 'lead' as const, fallback: 'tudo bem' },
      { role: 'free' as const, label: 'Dia' },
    ],
  };
  const input = base({
    request: { name: 'lembrete_simples', language: 'pt_BR', params: [], companyArticle: 'a' },
    templates: [custom],
    voice: null,
    defaults: { lead: '', seller: 'Daniele', company: '' },
  });

  it('fills each {{n}} as saved, the fallback when the CRM has nothing', () => {
    const plan = ok(input);
    expect(plan.preview.fields).toMatchObject([
      { role: 'lead', value: 'tudo bem' },
      { role: 'free', label: 'Dia', value: '' },
    ]);
    // A free field without a fallback is still the seller's to fill.
    expect(plan.preview.ready).toBe(false);
  });

  it('a custom company fallback follows the article the seller ticked', () => {
    const own = {
      ...T.formatacaoBoasVindasArte,
      fields: [
        { role: 'lead' as const },
        { role: 'seller' as const },
        { role: 'company' as const, form: 'article' as const, fallback: 'seu negócio' },
      ],
    };
    const plan = ok({
      ...input,
      request: {
        name: 'wings_formatacao_boas_vindas',
        language: 'pt_BR',
        params: [],
        companyArticle: 'o',
      },
      templates: [T.formatacaoBoasVindas, own],
      defaults: { lead: 'Mariana', seller: 'Daniele', company: '' },
    });
    expect(plan.preview.text).toContain('transformar o seu negócio em franquia');
  });

  it('the _arte version takes the fallback saved on its base, with its own article', () => {
    const base = {
      ...T.formatacaoBoasVindas,
      fields: [
        { role: 'lead' as const, fallback: 'tudo bem' },
        { role: 'seller' as const },
        { role: 'company' as const, fallback: 'sua empresa' },
      ],
    };
    const plan = ok({
      ...input,
      request: {
        name: 'wings_formatacao_boas_vindas',
        language: 'pt_BR',
        params: [],
        companyArticle: 'a',
      },
      templates: [base, T.formatacaoBoasVindasArte],
      defaults: { lead: '', seller: 'Daniele', company: '' },
    });
    expect(plan.version.name).toBe('wings_formatacao_boas_vindas_arte');
    expect(plan.preview.text).toContain('Olá, tudo bem!');
    expect(plan.preview.text).toContain('transformar a sua empresa em franquia');
  });

  it('with the call-permission request, goes as the template even inside the window', () => {
    const asking = {
      ...custom,
      components: [...(custom.components as object[]), { type: 'CALL_PERMISSION_REQUEST' }],
    };
    const plan = ok({ ...input, templates: [asking], window: { open: true, expiresAt: null } });
    expect(plan.preview.sendAs).toBe('template');
    expect(plan.preview.reason).toMatch(/permissão para ligar/);
  });
});

describe("Meta's refusals in Portuguese", () => {
  it('says the test number only reaches the numbers listed in the app (131030)', () => {
    expect(errorText(131030, 'Recipient phone number not in allowed list')).toMatch(
      /número de teste da Meta/,
    );
  });
});

describe('a template with a part the system does not fill yet (auditoria, item 4)', () => {
  const plain = (...more: Record<string, unknown>[]) =>
    row('aviso_teste', 'UTILITY', 'Olá, {{1}}! Temos novidades.', ...more);
  const cases: [string, TemplateRow][] = [
    ['a variable in the title', plain({ type: 'HEADER', format: 'TEXT', text: 'Oi, {{1}}' })],
    [
      'a link button with a variable part',
      plain({
        type: 'BUTTONS',
        buttons: [{ type: 'URL', text: 'Ver proposta', url: 'https://exemplo.com.br/p/{{1}}' }],
      }),
    ],
    ['a video header', plain({ type: 'HEADER', format: 'VIDEO' })],
    ['a document header', plain({ type: 'HEADER', format: 'DOCUMENT' })],
  ];
  for (const [what, template] of cases)
    it(`is refused before anything goes, window open or closed: ${what}`, () => {
      for (const open of [false, true]) {
        const plan = planTemplate(
          base({
            request: { name: 'aviso_teste', language: 'pt_BR', params: [], companyArticle: 'a' },
            templates: [template],
            window: { open, expiresAt: null },
            hasArt: false,
          }),
        );
        expect(plan).toMatchObject({ ok: false, status: 422, error: 'template_unsupported' });
        expect(unsupportedOf(template)).toContain('Escolha outro modelo');
      }
    });

  it('a fixed title and a fixed link still go', () => {
    const fixed = plain(
      { type: 'HEADER', format: 'TEXT', text: 'Novidades' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver', url: 'https://exemplo.com.br/p' }] },
    );
    expect(unsupportedOf(fixed)).toBeNull();
  });
});
