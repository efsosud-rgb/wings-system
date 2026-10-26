import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ICP_WEIGHTS,
  excludedName,
  icpScore,
  missingFields,
  nameKey,
  prospectApproachSchema,
  prospectBatchSchema,
  prospectClaimSchema,
  prospectLeadSchema,
  prospectSearchSchema,
  siteDomain,
  whatsappOptInMissing,
} from './prospecting.js';

describe('icpScore', () => {
  it('adds the weights the brief lists, the highest band only', () => {
    expect(
      icpScore({
        rating: 4.6,
        reviews: 812,
        hasWebsite: true,
        hasInstagram: true,
        multiUnit: true,
      }).score,
    ).toBe(2 + 3 + 1 + 1 + 2);
    expect(
      icpScore({
        rating: 4.2,
        reviews: 200,
        hasWebsite: false,
        hasInstagram: false,
        multiUnit: false,
      }).score,
    ).toBe(1 + 2);
    expect(
      icpScore({
        rating: 4.1,
        reviews: 49,
        hasWebsite: false,
        hasInstagram: false,
        multiUnit: false,
      }),
    ).toEqual({ score: 0, reasons: [] });
  });

  it('uses edited weights and drops a zero weight from the reasons', () => {
    const result = icpScore(
      { rating: null, reviews: 60, hasWebsite: true, hasInstagram: false, multiUnit: false },
      { ...DEFAULT_ICP_WEIGHTS, website: 0, reviews50: 4 },
    );
    expect(result).toEqual({ score: 4, reasons: ['Avaliações ≥ 50 (+4)'] });
  });
});

describe('names', () => {
  it('compares without case or accents, by whole words', () => {
    expect(nameKey('  Açaí da Esquina!! ')).toBe('acai da esquina');
    expect(excludedName('Rede Exemplo Burger - Niterói', ['rede exemplo'])).toBe(true);
    expect(excludedName('Lanches Exemplos', ['exemplo'])).toBe(false);
    expect(excludedName('Qualquer', ['  '])).toBe(false);
  });
});

describe('schemas', () => {
  it('asks for the previous token on pages 2 and 3, and only on a one-place search', () => {
    const base = { segment: 'hamburguerias', places: ['Niterói'] };
    expect(prospectSearchSchema.safeParse(base).success).toBe(true);
    expect(prospectSearchSchema.safeParse({ ...base, page: 2 }).success).toBe(false);
    expect(prospectSearchSchema.safeParse({ ...base, page: 2, pageToken: 'abc' }).success).toBe(
      true,
    );
    expect(
      prospectSearchSchema.safeParse({
        ...base,
        places: ['Icaraí', 'Centro'],
        page: 2,
        pageToken: 'abc',
      }).success,
    ).toBe(false);
    expect(prospectSearchSchema.safeParse({ ...base, page: 4, pageToken: 'abc' }).success).toBe(
      false,
    );
  });

  it('needs a reason to discard and a phone or e-mail for the lead', () => {
    const placeId = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
    expect(prospectClaimSchema.safeParse({ placeId, action: 'discard' }).success).toBe(false);
    expect(prospectClaimSchema.safeParse({ placeId, action: 'reserve' }).success).toBe(true);
    const lead = {
      companyName: 'Empresa Teste',
      contactName: 'Pessoa Teste',
      whatsappOptIn: false,
    };
    expect(prospectLeadSchema.safeParse(lead).success).toBe(false);
    expect(prospectLeadSchema.safeParse({ ...lead, email: 'a@exemplo.com' }).success).toBe(true);
  });
});

describe('whatsappOptInMissing', () => {
  it('blocks only a prospecting lead without consent', () => {
    const lead = (source: string, legalBasis: string | null, consentSource: string | null) =>
      whatsappOptInMissing({ source, legalBasis, consentSource });
    expect(lead('google_places', 'legitimate_interest', 'prospeccao')).toBe(true);
    expect(lead('google_places', 'consent', 'prospeccao')).toBe(false);
    expect(lead('site_form', null, null)).toBe(false);
    expect(lead('site_form', 'consent', 'site_form:x')).toBe(false);
    // A deal Criar lead merged into: the "não" recorded there counts, whatever its source.
    expect(lead('manual', 'legitimate_interest', 'prospeccao')).toBe(true);
  });
});

describe('Maps Prospecting additions', () => {
  it('reads the company domain, never a shared host', () => {
    expect(siteDomain('https://www.Padaria-Teste.example.com.br/contato?x=1')).toBe(
      'padaria-teste.example.com.br',
    );
    expect(siteDomain('padaria-teste.example.com.br')).toBe('padaria-teste.example.com.br');
    expect(siteDomain('http://user@site-teste.example.com:8080/')).toBe('site-teste.example.com');
    for (const shared of [
      'https://www.instagram.com/perfil.teste/',
      'https://m.facebook.com/pagina.teste',
      'https://linktr.ee/teste',
      'https://wa.me/5521990000000',
      null,
      '',
      'não tem',
    ])
      expect(siteDomain(shared)).toBeNull();
  });

  it('lists what Google did not give', () => {
    const place = {
      placeId: 'ChIJteste000001',
      name: 'Empresa Teste',
      address: null,
      phone: null,
      website: 'https://empresa-teste.example.com.br',
      rating: null,
      reviews: null,
      businessStatus: null,
      mapsUri: null,
      types: [],
    };
    expect(missingFields(place)).toEqual(['phone', 'address', 'rating']);
    expect(missingFields({ ...place, phone: '(21) 99000-0001', address: 'x', rating: 0 })).toEqual(
      [],
    );
  });

  it('a batch: one to sixty distinct places', () => {
    const id = (n: number) => `ChIJbatchTeste${String(n).padStart(4, '0')}`;
    expect(prospectBatchSchema.safeParse({ placeIds: [id(1), id(2)] }).success).toBe(true);
    expect(prospectBatchSchema.safeParse({ placeIds: [] }).success).toBe(false);
    expect(prospectBatchSchema.safeParse({ placeIds: [id(1), id(1)] }).success).toBe(false);
    expect(
      prospectBatchSchema.safeParse({ placeIds: Array.from({ length: 61 }, (_, i) => id(i)) })
        .success,
    ).toBe(false);
  });

  it('the follow-up is a date with its offset, or nothing', () => {
    const base = {
      companyName: 'Empresa',
      contactName: 'Contato',
      phone: '1',
      whatsappOptIn: false,
    };
    expect(prospectLeadSchema.safeParse(base).success).toBe(true);
    expect(prospectLeadSchema.safeParse({ ...base, followUpAt: '' }).success).toBe(true);
    expect(
      prospectLeadSchema.safeParse({ ...base, followUpAt: '2027-03-10T13:00:00.000Z' }).success,
    ).toBe(true);
    expect(prospectLeadSchema.safeParse({ ...base, followUpAt: '2027-03-10' }).success).toBe(false);
  });

  it('never suggests WhatsApp as the approach', () => {
    expect(prospectApproachSchema.safeParse({ channel: 'ligacao' }).success).toBe(true);
    expect(prospectApproachSchema.safeParse({ channel: 'whatsapp' }).success).toBe(false);
  });
});
