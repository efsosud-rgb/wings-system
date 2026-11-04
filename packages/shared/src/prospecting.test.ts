import { describe, expect, it } from 'vitest';
import { INSTAGRAM_FROM_GOOGLE_SITE, type ProspectInstagramRef } from './instagram-discovery.js';
import {
  DEFAULT_ICP_WEIGHTS,
  excludedName,
  icpScore,
  missingFields,
  nameKey,
  PROSPECT_ENRICHMENT_SOURCE,
  prospectApproachSchema,
  prospectBatchSchema,
  prospectClaimSchema,
  prospectingIcpSchema,
  prospectingRetentionSchema,
  PROSPECT_LEAD_PREFILL_FROM_GOOGLE,
  prospectLeadDefaults,
  prospectLeadSchema,
  reservationExpiresAt,
  prospectSearchSchema,
  siteDomain,
  whatsappOptInMissing,
  withInstagram,
} from './prospecting.js';

describe('icpScore', () => {
  it('adds the weights the brief lists, the highest band only, over the 9 points possible', () => {
    const top = icpScore({
      rating: 4.6,
      reviews: 812,
      hasWebsite: true,
      hasInstagram: true,
      multiUnit: true,
    });
    expect(top.earned).toBe(2 + 3 + 1 + 1 + 2);
    expect(top.possible).toBe(9);
    expect(top.score).toBe(100);
    const mid = icpScore({
      rating: 4.2,
      reviews: 200,
      hasWebsite: false,
      hasInstagram: false,
      multiUnit: false,
    });
    expect(mid.earned).toBe(1 + 2);
    expect(mid.score).toBe(Math.round((100 * 3) / 9));
    expect(
      icpScore({
        rating: 4.1,
        reviews: 49,
        hasWebsite: false,
        hasInstagram: false,
        multiUnit: false,
      }),
    ).toEqual({ score: 0, earned: 0, possible: 9, reasons: [], noData: [] });
  });

  it('uses edited weights and drops a zero weight from the reasons', () => {
    const result = icpScore(
      { rating: null, reviews: 60, hasWebsite: true, hasInstagram: false, multiUnit: false },
      { ...DEFAULT_ICP_WEIGHTS, website: 0, reviews50: 4 },
    );
    // Possible: rating 2 + reviews max(3, 2, 4) + website 0 + instagram 1 + units 2 = 9.
    expect(result).toEqual({
      score: Math.round((100 * 4) / 9),
      earned: 4,
      possible: 9,
      reasons: ['Avaliações ≥ 50 (+4)'],
      noData: [],
    });
  });

  it('is 0 and not NaN when every weight is zero', () => {
    const zero = Object.fromEntries(Object.keys(DEFAULT_ICP_WEIGHTS).map((k) => [k, 0]));
    expect(
      icpScore(
        { rating: 5, reviews: 900, hasWebsite: true, hasInstagram: true, multiUnit: true },
        zero as typeof DEFAULT_ICP_WEIGHTS,
      ).score,
    ).toBe(0);
  });
});

describe('icpScore with Instagram (§6.3)', () => {
  const google = {
    rating: 4.6,
    reviews: 812,
    hasWebsite: true,
    hasInstagram: true,
    multiUnit: true,
  };
  const full = {
    followers: 12_000,
    posts: 340,
    postsLast30d: 6,
    avgLikesMilli: 150_000,
    avgCommentsMilli: 8_000,
  };

  it('a business account with every number: Google 9 + Instagram 8 possible', () => {
    const result = icpScore(google, DEFAULT_ICP_WEIGHTS, full);
    // 158 per post over 12,000 followers is 1.3%: engagement counts.
    expect(result.possible).toBe(9 + 2 + 2 + 1 + 2 + 1);
    expect(result.earned).toBe(9 + 8);
    expect(result.score).toBe(100);
    expect(result.reasons).toContain('Instagram: seguidores ≥ 10.000 (+2)');
    expect(result.noData).toEqual([]);
  });

  it('counts a criterion that holds and misses one that does not', () => {
    const result = icpScore(
      { rating: null, reviews: null, hasWebsite: false, hasInstagram: false, multiUnit: false },
      DEFAULT_ICP_WEIGHTS,
      {
        followers: 1_500,
        posts: 40,
        postsLast30d: 2,
        avgLikesMilli: 5_000,
        avgCommentsMilli: 1_000,
      },
    );
    // Only 1k followers (+1); 6 per post over 1,500 is 0.4%: no engagement.
    expect(result.earned).toBe(1);
    expect(result.possible).toBe(9 + 8);
    expect(result.score).toBe(Math.round(100 / 17));
  });

  it('hidden likes take out only the engagement criterion, on both sides', () => {
    const result = icpScore(google, DEFAULT_ICP_WEIGHTS, { ...full, avgLikesMilli: null });
    expect(result.possible).toBe(9 + 8 - 2);
    expect(result.earned).toBe(9 + 8 - 2);
    expect(result.noData).toEqual(['Instagram: engajamento ≥ 1%']);
  });

  it('no timestamp takes out the frequency; no followers the followers and the engagement', () => {
    const noTime = icpScore(google, DEFAULT_ICP_WEIGHTS, { ...full, postsLast30d: null });
    expect(noTime.possible).toBe(17 - 2);
    expect(noTime.noData).toEqual(['Instagram: 4 ou mais posts em 30 dias']);
    const noFollowers = icpScore(google, DEFAULT_ICP_WEIGHTS, { ...full, followers: null });
    expect(noFollowers.possible).toBe(17 - 2 - 2);
    expect(noFollowers.noData).toEqual([
      'Instagram: seguidores ≥ 10.000',
      'Instagram: seguidores ≥ 1.000',
      'Instagram: engajamento ≥ 1%',
    ]);
  });

  it('a missing criterion never reads as zero: the same company scores higher than a zero', () => {
    const missing = icpScore(google, DEFAULT_ICP_WEIGHTS, { ...full, avgCommentsMilli: null });
    const zero = icpScore(google, DEFAULT_ICP_WEIGHTS, { ...full, avgCommentsMilli: 0 });
    expect(missing.score).toBeGreaterThan(zero.score);
  });

  it("the screen adds Instagram to the search's score and gets the same answer", () => {
    const later = withInstagram(icpScore(google), DEFAULT_ICP_WEIGHTS, {
      ...full,
      followers: 2_000,
    });
    expect(later).toEqual(icpScore(google, DEFAULT_ICP_WEIGHTS, { ...full, followers: 2_000 }));
    expect(withInstagram(icpScore(google), DEFAULT_ICP_WEIGHTS, null)).toEqual(icpScore(google));
  });

  it('without a business account the score is Google alone, still 0 to 100', () => {
    expect(icpScore(google, DEFAULT_ICP_WEIGHTS, null)).toEqual(icpScore(google));
    expect(icpScore(google).score).toBe(100);
  });
});

describe('prospectingIcpSchema', () => {
  it('reads a row saved before the Instagram weights with their defaults, keeping the list', () => {
    const old = {
      weights: {
        rating45: 2,
        rating42: 1,
        reviews500: 3,
        reviews200: 2,
        reviews50: 1,
        website: 1,
        instagram: 1,
        multiUnit: 2,
      },
      excludedNames: ['Rede Exemplo Burger'],
    };
    const parsed = prospectingIcpSchema.parse(old);
    expect(parsed.excludedNames).toEqual(['Rede Exemplo Burger']);
    expect(parsed.weights.igFollowers10k).toBe(2);
    expect(parsed.weights.igComments5).toBe(1);
    expect(
      prospectingIcpSchema.safeParse({ ...old, weights: { ...old.weights, igPosts100: 11 } })
        .success,
    ).toBe(false);
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

describe('retention', () => {
  const ok = { reservedDays: 30, contactedDays: 90, enrichmentDays: 180 };

  it('takes 7 to 365 days for a reservation and 30 to 730 for the enrichment, whole days', () => {
    expect(prospectingRetentionSchema.safeParse(ok).success).toBe(true);
    for (const days of [7, 365]) {
      expect(prospectingRetentionSchema.safeParse({ ...ok, reservedDays: days }).success).toBe(
        true,
      );
      expect(prospectingRetentionSchema.safeParse({ ...ok, contactedDays: days }).success).toBe(
        true,
      );
    }
    for (const bad of [
      { ...ok, reservedDays: 6 },
      { ...ok, reservedDays: 366 },
      { ...ok, contactedDays: 6 },
      { ...ok, enrichmentDays: 29 },
      { ...ok, enrichmentDays: 731 },
      { ...ok, reservedDays: 30.5 },
      { reservedDays: 30, contactedDays: 90 },
    ])
      expect(prospectingRetentionSchema.safeParse(bad).success).toBe(false);
    expect(
      prospectingRetentionSchema.safeParse({ ...ok, reservedDays: 6 }).error?.issues[0]?.message,
    ).toBe('De 7 a 365 dias');
  });

  it('a reservation expires from its last update; a status that holds nothing never does', () => {
    const updatedAt = '2026-10-01T12:00:00.000Z';
    expect(reservationExpiresAt({ status: 'reservado', updatedAt }, ok)?.toISOString()).toBe(
      '2026-10-31T12:00:00.000Z',
    );
    expect(reservationExpiresAt({ status: 'contatado', updatedAt }, ok)?.toISOString()).toBe(
      '2026-12-30T12:00:00.000Z',
    );
    for (const status of ['descartado', 'virou_lead', 'nao_contatar'] as const)
      expect(reservationExpiresAt({ status, updatedAt }, ok)).toBeNull();
  });
});

describe('prospectLeadDefaults', () => {
  const place = {
    name: ' Empresa Teste ',
    phone: '(21) 90000-0001',
    website: 'https://exemplo.com.br/',
  };

  const site = {
    email: { value: 'contato@exemplo.com.br', source: 'site da empresa', at: '2026-10-26' },
    instagram: { value: 'empresateste', source: 'site da empresa', at: '2026-10-26' },
  } as const;

  // The search row's @ as the screen gets it: from the company's own site (ours) or from Google.
  const ownRow = (username: string): Pick<ProspectInstagramRef, 'username' | 'source'> => ({
    username,
    source: PROSPECT_ENRICHMENT_SOURCE,
  });
  const googleRow = (username: string): Pick<ProspectInstagramRef, 'username' | 'source'> => ({
    username,
    source: INSTAGRAM_FROM_GOOGLE_SITE,
  });

  it("keeps Google's name, phone and site out of the form until Eric decides", () => {
    expect(PROSPECT_LEAD_PREFILL_FROM_GOOGLE).toBe(false);
    const defaults = prospectLeadDefaults(place, site, ownRow('outro'));
    expect(defaults).toEqual({
      companyName: '',
      phone: '',
      email: 'contato@exemplo.com.br',
      instagram: 'empresateste',
      website: '',
    });
    const values = Object.values(defaults).join(' ');
    for (const google of [place.name.trim(), place.phone, place.website])
      expect(values).not.toContain(google);
  });

  it('can start with the Google row too, ready for the day the rule changes', () => {
    expect(prospectLeadDefaults(place, site, ownRow('outro'), true)).toEqual({
      companyName: 'Empresa Teste',
      phone: '(21) 90000-0001',
      email: 'contato@exemplo.com.br',
      instagram: 'empresateste',
      website: 'https://exemplo.com.br/',
    });
  });

  it("falls back to the search row's Instagram and leaves missing data empty, never guessed", () => {
    expect(
      prospectLeadDefaults(
        { name: null, phone: null, website: 'javascript:alert(1)' },
        {},
        ownRow('empresateste'),
        true,
      ),
    ).toEqual({ companyName: '', phone: '', email: '', instagram: '@empresateste', website: '' });
    expect(prospectLeadDefaults(null, {})).toEqual({
      companyName: '',
      phone: '',
      email: '',
      instagram: '',
      website: '',
    });
  });

  it("never starts the form with the @ Google's site field showed, whatever the fallback", () => {
    // `instagram.com/<@>` as the company's site on Maps: live Google data, not ours (not stored).
    for (const fromGoogle of [false, true]) {
      expect(prospectLeadDefaults(place, {}, googleRow('perfilgoogle'), fromGoogle).instagram).toBe(
        '',
      );
      // What the company's own site showed still wins over the Google one, and stays.
      expect(
        prospectLeadDefaults(place, site, googleRow('perfilgoogle'), fromGoogle).instagram,
      ).toBe('empresateste');
    }
  });

  it('needs the seller to type the company: the schema refuses the form without it', () => {
    const contact = { contactName: 'Pessoa Teste', whatsappOptIn: false };
    const blank = prospectLeadSchema.safeParse({ ...prospectLeadDefaults(place, {}), ...contact });
    expect(blank.success).toBe(false);
    const typed = prospectLeadSchema.safeParse({
      ...prospectLeadDefaults(place, {}),
      ...contact,
      companyName: 'Empresa Digitada',
      phone: '(21) 90000-0009',
    });
    expect(typed.success).toBe(true);
    // With the prefill on, the form of the Google row is accepted as it is.
    expect(
      prospectLeadSchema.safeParse({ ...prospectLeadDefaults(place, {}, null, true), ...contact })
        .success,
    ).toBe(true);
  });
});
