import { describe, expect, it } from 'vitest';
import {
  EMPTY_FACTS,
  emailDomainOf,
  enrichmentSummaryOf,
  expansionAreaSchema,
  franchiseeScoreOf,
  generateTrackingCode,
  landingPageKeysOf,
  matchSourceRule,
  normalizeBrazilianPhone,
  parseExpansionEntry,
  regionOfPhone,
  trackingCodeOf,
  whatsappLinkOf,
  type EnrichmentFacts,
} from './leads.js';

describe('phones and regions', () => {
  it('normalises Brazilian numbers and reads the DDD into a region', () => {
    expect(normalizeBrazilianPhone('(19) 99999-8888')).toBe('5519999998888');
    expect(normalizeBrazilianPhone('+55 11 3333-4444')).toBe('551133334444');
    expect(normalizeBrazilianPhone('00000000000')).toBeNull();
    expect(regionOfPhone('5519999998888')).toEqual({ ddd: '19', city: 'Campinas', uf: 'SP' });
    expect(regionOfPhone('5520999998888')).toBeNull();
    expect(regionOfPhone(null)).toBeNull();
  });

  it('tells a personal e-mail from a corporate one', () => {
    expect(emailDomainOf('Ana@Gmail.com')).toEqual({ domain: 'gmail.com', kind: 'personal' });
    expect(emailDomainOf('ana@padaria-aurora.com.br')).toEqual({
      domain: 'padaria-aurora.com.br',
      kind: 'corporate',
    });
    expect(emailDomainOf('not-an-email')).toBeNull();
  });
});

describe('tracking codes', () => {
  it('generates six readable characters and finds them at the start of a message', () => {
    const code = generateTrackingCode(() => 0.5);
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(trackingCodeOf(`  #${code.toLowerCase()} Olá, quero saber da franquia`)).toBe(code);
    expect(trackingCodeOf('Olá, quero saber da franquia')).toBeNull();
    expect(trackingCodeOf('')).toBeNull();
    expect(whatsappLinkOf('5511999998888', code)).toBe(`https://wa.me/5511999998888?text=${code}`);
  });
});

describe('source rules', () => {
  const rules = [
    { kind: 'landing_page' as const, pattern: 'sushi-do-bairro', clientId: 'sushi' },
    { kind: 'landing_page' as const, pattern: 'lp.aurora.com.br', clientId: 'aurora' },
    { kind: 'landing_page' as const, pattern: 'lp.aurora.com.br/verao', clientId: 'aurora-verao' },
    { kind: 'meta_form' as const, pattern: '123', clientId: 'sushi' },
  ];

  it('maps a franchise landing page by its slug', () => {
    const keys = landingPageKeysOf({
      url: 'https://franquia.wingscompany.com.br/sushi-do-bairro?utm_source=ig',
    });
    expect(keys).toContain('sushi-do-bairro');
    expect(matchSourceRule(rules, 'landing_page', keys)?.clientId).toBe('sushi');
  });

  it('prefers the most specific pattern and matches a host on its own', () => {
    const summer = landingPageKeysOf({ url: 'https://www.lp.aurora.com.br/verao/' });
    expect(matchSourceRule(rules, 'landing_page', summer)?.clientId).toBe('aurora-verao');
    const home = landingPageKeysOf({ url: 'https://lp.aurora.com.br/' });
    expect(matchSourceRule(rules, 'landing_page', home)?.clientId).toBe('aurora');
    expect(
      matchSourceRule(rules, 'landing_page', landingPageKeysOf({ url: 'https://other.com/x' })),
    ).toBeNull();
  });

  it('matches an RD conversion identifier and a Meta form id', () => {
    expect(
      matchSourceRule(rules, 'landing_page', landingPageKeysOf({ identifier: 'Sushi-do-Bairro' }))
        ?.clientId,
    ).toBe('sushi');
    expect(matchSourceRule(rules, 'meta_form', ['123'])?.clientId).toBe('sushi');
    expect(matchSourceRule(rules, 'meta_campaign', ['123'])).toBeNull();
  });
});

describe('expansion area', () => {
  it('accepts a state or a city with its state, in the ways people write them', () => {
    expect(parseExpansionEntry('sp')).toEqual({ uf: 'SP', city: null });
    expect(parseExpansionEntry('Campinas/SP')).toEqual({ uf: 'SP', city: 'Campinas' });
    expect(parseExpansionEntry('Campinas - sp')).toEqual({ uf: 'SP', city: 'Campinas' });
    expect(parseExpansionEntry('Campinas, SP')).toEqual({ uf: 'SP', city: 'Campinas' });
    expect(parseExpansionEntry('Campinas')).toBeNull();
    expect(parseExpansionEntry('Campinas/XX')).toBeNull();
  });

  it('refuses an area with an entry it cannot check and removes duplicates', () => {
    expect(
      expansionAreaSchema.safeParse({ expansionArea: ['SP', 'Campinas/SP', 'sp'] }).data,
    ).toEqual({
      expansionArea: [
        { uf: 'SP', city: null },
        { uf: 'SP', city: 'Campinas' },
      ],
    });
    const bad = expansionAreaSchema.safeParse({ expansionArea: ['Campinas'] });
    expect(bad.success).toBe(false);
  });
});

describe('the franchisee score', () => {
  const strong: EnrichmentFacts = {
    region: { ddd: '19', city: 'Campinas', uf: 'SP' },
    emailDomain: { domain: 'aurora.com.br', kind: 'corporate' },
    whatsapp: { profileName: 'Ana', photoUrl: 'https://example.invalid/p.jpg' },
    links: [
      {
        kind: 'linkedin',
        url: 'https://www.linkedin.com/in/ana',
        title: 'Ana Souza - Diretora Comercial - Aurora',
        snippet: 'Diretora comercial há 8 anos.',
      },
    ],
    company: {
      cnpj: '12.345.678/0001-90',
      name: 'Aurora Alimentos',
      legalName: 'Aurora Alimentos Ltda',
      capitalSocialBrl: 250_000,
      openedAt: '2015-03-01',
      mainActivity: 'Padaria',
      size: 'EPP',
      city: 'Campinas',
      uf: 'SP',
      leadIsPartner: true,
      matchedBy: 'partner',
    },
    searches: 2,
  };

  it('gives every point a reason and adds up to 100 for a strong profile in the area', () => {
    const score = franchiseeScoreOf(strong, [{ uf: 'SP', city: 'Campinas' }]);
    expect(score.score).toBe(100);
    const capital = score.criteria.find((c) => c.key === 'capital');
    expect(capital).toMatchObject({ points: 40, max: 40, evaluated: true });
    expect(capital?.reasons).toHaveLength(3);
    expect(score.criteria.find((c) => c.key === 'management')).toMatchObject({ points: 30 });
    expect(score.criteria.find((c) => c.key === 'location')?.reasons[0]).toContain('DDD 19');
  });

  it('gives half the location points for the state alone and none outside the area', () => {
    expect(franchiseeScoreOf(strong, [{ uf: 'SP', city: null }]).criteria[2]?.points).toBe(15);
    expect(franchiseeScoreOf(strong, [{ uf: 'RJ', city: null }]).criteria[2]?.points).toBe(0);
  });

  it('leaves location out of the total when there is no phone or no expansion area', () => {
    const noArea = franchiseeScoreOf(strong, []);
    expect(noArea.criteria[2]).toMatchObject({ evaluated: false, points: 0 });
    expect(noArea.score).toBe(100);
    const noPhone = franchiseeScoreOf({ ...strong, region: null }, [{ uf: 'SP', city: null }]);
    expect(noPhone.criteria[2]?.evaluated).toBe(false);
  });

  it('is honest about an empty profile', () => {
    const score = franchiseeScoreOf(EMPTY_FACTS, []);
    expect(score.score).toBe(0);
    expect(score.criteria.map((c) => c.reasons[0])).toEqual([
      'Nenhum sinal de capital encontrado.',
      'Nenhum sinal de gestão encontrado.',
      'Sem telefone com DDD conhecido: região não avaliada.',
    ]);
  });

  it('writes five lines, one per subject', () => {
    const score = franchiseeScoreOf(strong, [{ uf: 'SP', city: 'Campinas' }]);
    const summary = enrichmentSummaryOf({ name: 'Ana Souza' }, strong, score);
    const lines = summary.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(
      'Ana Souza: região de Campinas/SP pelo DDD 19; e-mail em domínio próprio (aurora.com.br).',
    );
    expect(lines[1]).toBe('WhatsApp: perfil "Ana", com foto.');
    expect(lines[2]).toContain('LinkedIn: Ana Souza - Diretora Comercial - Aurora');
    expect(lines[3]).toContain('capital social R$ 250.000');
    expect(lines[4]).toBe(
      'Perfil de franqueado: 100/100 (capital provável 40/40, experiência em gestão 30/30, cidade na área de expansão 30/30).',
    );

    const empty = enrichmentSummaryOf(
      { name: null },
      EMPTY_FACTS,
      franchiseeScoreOf(EMPTY_FACTS, []),
    );
    expect(empty.split('\n')).toHaveLength(5);
    expect(empty).toContain('Busca web não realizada.');
    expect(empty).toContain('cidade na área de expansão não avaliada');
  });
});

describe('utmLinksFor', () => {
  it('makes one link per channel with source, medium, campaign and content, keeping other parameters', async () => {
    const { utmLinksFor, utmValueOf } = await import('./leads.js');
    expect(utmValueOf('Vídeos Thais — Out/26')).toBe('videos_thais_out_26');
    const links = utmLinksFor(
      'https://franquia.wingscompany.com.br/cenoritas?ref=x&utm_source=old',
      {
        campaign: 'Expansão Out26',
        content: 'video 1',
      },
    );
    const instagram = links.find((link) => link.key === 'instagram_ads');
    expect(instagram?.url).toBe(
      'https://franquia.wingscompany.com.br/cenoritas?ref=x&utm_source=instagram&utm_medium=cpc&utm_campaign=expansao_out26&utm_content=video_1',
    );
    expect(links.map((link) => link.key)).toContain('google_ads');
  });
});
