import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ICP_WEIGHTS,
  excludedName,
  icpScore,
  nameKey,
  prospectClaimSchema,
  prospectLeadSchema,
  prospectSearchSchema,
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
