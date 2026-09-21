import { describe, expect, it } from 'vitest';
import {
  CREATIVE_FORMATS,
  PAID_PLATFORMS,
  PLATFORM_REACH,
  RADIUS_NOT_ACCEPTED_HINT,
  describeReach,
  reachSchema,
  applyUtms,
  buildUtms,
  campaignDays,
  campaignDaysInMonth,
  campaignDraftSchema,
  checkCopyCompliance,
  dailyOverdeliveryFactor,
  estimateCostCents,
  matchesFormat,
  parseYoutubeVideoId,
  periodOverdeliveryFactor,
  placementsSchema,
  platformAcceptsRadius,
  reachRefusal,
  usesVerticalPlacements,
  utmSlug,
  variationMedia,
  youtubeThumbnailUrl,
  type CampaignDraftInput,
} from './campaign-builder.js';

const rulesOf = (text: string) => checkCopyCompliance(text).map((finding) => finding.rule);

describe('copy compliance', () => {
  it('lets ordinary franchise copy through', () => {
    expect(checkCopyCompliance('Leve a Wings para a sua cidade. Suporte completo.')).toEqual([]);
    expect(checkCopyCompliance('Conheça o modelo de negócio e fale com um consultor.')).toEqual([]);
  });

  it('blocks a revenue promise, with or without accents', () => {
    expect(rulesOf('Fature R$ 50.000 já no primeiro ano')).toContain('revenue_promise');
    expect(rulesOf('Unidades com faturamento de 80 mil')).toContain('revenue_promise');
    expect(rulesOf('Até 30 mil de lucro')).toContain('revenue_promise');
  });

  it('blocks guaranteed returns', () => {
    expect(rulesOf('Retorno garantido para o franqueado')).toContain('guaranteed_return');
    expect(rulesOf('Garantia de lucro desde o início')).toContain('guaranteed_return');
    expect(rulesOf('Um negócio sem risco')).toContain('guaranteed_return');
  });

  it('blocks payback claims', () => {
    expect(rulesOf('Payback em 18 meses')).toContain('payback');
    expect(rulesOf('Retorno do investimento em até 24 meses')).toContain('payback');
  });

  it('blocks "ganhe X por mês"', () => {
    expect(rulesOf('Ganhe até R$ 10 mil por mês')).toContain('earn_per_month');
    expect(rulesOf('R$ 8.000/mês trabalhando de casa')).toContain('earn_per_month');
    expect(rulesOf('Renda extra para você')).toContain('earn_per_month');
  });

  it('blocks investment language', () => {
    expect(rulesOf('O melhor investimento da sua vida')).toContain('investment_language');
    expect(rulesOf('Alta rentabilidade')).toContain('investment_language');
    expect(rulesOf('Renda passiva de verdade')).toContain('investment_language');
  });

  it('quotes the excerpt as the operator typed it', () => {
    const [finding] = checkCopyCompliance('Conheça: RETORNO GARANTIDO 🚀 hoje');
    expect(finding?.excerpt).toBe('RETORNO GARANTIDO');
  });

  it('does not flag words that merely contain a trigger', () => {
    // "roi" inside "heroi", "renda" inside "aprenda".
    expect(checkCopyCompliance('Seja o herói da sua cidade. Aprenda com a gente.')).toEqual([]);
  });
});

describe('UTMs', () => {
  it('slugs a campaign name', () => {
    expect(utmSlug('Expansão SP — Set/26')).toBe('expansao-sp-set-26');
  });

  it('generates defaults from the form', () => {
    expect(buildUtms({ platform: 'meta', objective: 'lead', campaignName: 'Expansão SP' })).toEqual(
      {
        utm_source: 'meta',
        utm_medium: 'paid_social',
        utm_campaign: 'expansao-sp',
        utm_content: 'lead',
      },
    );
  });

  it('applies them to the destination, one content value per variation', () => {
    const utms = buildUtms({ platform: 'meta', objective: 'lead', campaignName: 'Teste' });
    expect(applyUtms('https://wingscompany.com.br/franquia?x=1', utms, 1)).toBe(
      'https://wingscompany.com.br/franquia?x=1&utm_source=meta&utm_medium=paid_social&utm_campaign=teste&utm_content=lead-v2',
    );
    expect(applyUtms('não é url', utms)).toBeNull();
  });
});

describe('creative proportions', () => {
  it('matches a format within a small tolerance, whatever the resolution', () => {
    const square = CREATIVE_FORMATS.meta[0];
    if (!square) throw new Error('no format');
    expect(matchesFormat({ width: 2160, height: 2160 }, square)).toBe(true);
    expect(matchesFormat({ width: 1080, height: 1090 }, square)).toBe(true);
    expect(matchesFormat({ width: 1200, height: 628 }, square)).toBe(false);
  });
});

describe('reach', () => {
  const point = { latitude: -22.9056, longitude: -47.0608, radiusKm: 25, label: 'Campinas' };

  it('accepts a radius on the map alone, and describes it for the summary', () => {
    const reach = reachSchema.parse({ states: [], cities: [], customLocations: [point] });
    expect(describeReach(reach)).toBe('25 km ao redor de Campinas');
    expect(
      describeReach({
        states: ['SP'],
        cities: [],
        customLocations: [{ ...point, label: undefined }],
      }),
    ).toBe('SP (estado todo) · 25 km ao redor de Ponto 1 (-22.906, -47.061)');
  });

  it('keeps reading a reach saved before the map existed', () => {
    const old = { states: ['SP'], cities: [] };
    expect(reachSchema.parse(old).customLocations).toEqual([]);
    expect(describeReach(old as never)).toBe('SP (estado todo)');
  });

  it('holds the radius to what Meta documents, and refuses an empty reach', () => {
    const parse = (radiusKm: number) =>
      reachSchema.safeParse({ states: [], cities: [], customLocations: [{ ...point, radiusKm }] });
    expect(parse(0).success).toBe(false);
    expect(parse(81).success).toBe(false);
    expect(parse(12.5).success).toBe(false);
    expect(parse(80).success).toBe(true);
    expect(reachSchema.safeParse({ states: [], cities: [], customLocations: [] }).success).toBe(
      false,
    );
  });
});

describe('duration and cost', () => {
  it('counts both ends of the range', () => {
    expect(campaignDays('2026-09-20', '2026-09-20')).toBe(1);
    expect(campaignDays('2026-09-20', '2026-10-04')).toBe(15);
    expect(campaignDays('2026-09-20', '2026-09-19')).toBeNull();
  });

  it('counts only the days inside the current month', () => {
    expect(campaignDaysInMonth('2026-09-20', '2026-10-04', '2026-09-18')).toBe(11);
    expect(campaignDaysInMonth('2026-10-01', '2026-10-04', '2026-09-18')).toBe(0);
  });

  it('includes overdelivery in the estimate', () => {
    // R$ 20/day for 10 days is R$ 200 of budget and up to R$ 250 of spend.
    expect(estimateCostCents(2_000, 10)).toBe(25_000);
  });
});

describe('the draft schema', () => {
  const variations = [
    {
      creativeId: '11111111-1111-4111-8111-111111111111',
      headline: 'Leve a Wings para sua cidade',
      primaryText: 'Fale com a gente.',
      callToAction: 'LEARN_MORE',
    },
    {
      creativeId: '22222222-2222-4222-8222-222222222222',
      headline: 'Seja um franqueado Wings',
      primaryText: 'Suporte completo.',
      callToAction: 'CONTACT_US',
    },
  ] as const;

  const valid: CampaignDraftInput = {
    platform: 'meta',
    name: 'Sacrifício — teste de escrita',
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP'], cities: [{ name: 'Curitiba', state: 'PR' }] },
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    variations: [...variations],
    ageMin: 25,
    ageMax: 65,
    placements: { mode: 'automatic' },
    identity: { pageId: '104567890123456', instagramActorId: '17841400000000000' },
    startDate: '2026-09-20',
    endDate: '2026-09-27',
    dailyBudgetCents: 600,
    utms: {
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: 'sacrificio',
      utm_content: 'lead',
    },
    startPaused: true,
  };

  it('accepts a complete draft', () => {
    expect(campaignDraftSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses non-compliant copy on the server side too', () => {
    const result = campaignDraftSchema.safeParse({
      ...valid,
      variations: [variations[0], { ...variations[1], headline: 'Retorno garantido' }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['variations', 1, 'headline']);
  });

  it('demands a creative on every variation', () => {
    const [first, second] = variations;
    const result = campaignDraftSchema.safeParse({
      ...valid,
      variations: [first, { ...second, creativeId: '' }],
    });
    expect(result.error?.issues[0]?.message).toBe('Envie o criativo desta variação');
  });

  it('demands two to three variations', () => {
    expect(campaignDraftSchema.safeParse({ ...valid, variations: [variations[0]] }).success).toBe(
      false,
    );
  });

  it('refuses an end before the start, an http destination and an unknown format', () => {
    expect(campaignDraftSchema.safeParse({ ...valid, endDate: '2026-09-19' }).success).toBe(false);
    expect(
      campaignDraftSchema.safeParse({ ...valid, destinationUrl: 'http://x.com' }).success,
    ).toBe(false);
    expect(campaignDraftSchema.safeParse({ ...valid, formatKey: 'banner' }).success).toBe(false);
  });
});

describe('Meta drafts: ad set and ads', () => {
  const variations = [
    {
      creativeId: '11111111-1111-4111-8111-111111111111',
      headline: 'Leve a Wings para sua cidade',
      primaryText: 'Fale com a gente.',
      callToAction: 'LEARN_MORE',
    },
    {
      creativeId: '22222222-2222-4222-8222-222222222222',
      headline: 'Seja um franqueado Wings',
      primaryText: 'Suporte completo.',
      callToAction: 'CONTACT_US',
    },
  ] as const;

  const meta: CampaignDraftInput = {
    platform: 'meta',
    name: 'Meta — conjunto e anúncios',
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP'], cities: [] },
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    variations: [...variations],
    ageMin: 25,
    ageMax: 65,
    placements: { mode: 'automatic' },
    identity: { pageId: '104567890123456' },
    startDate: '2026-09-20',
    endDate: '2026-09-27',
    dailyBudgetCents: 600,
    utms: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'x', utm_content: '' },
    startPaused: true,
  };
  const ok = (patch: Record<string, unknown>) =>
    campaignDraftSchema.safeParse({ ...meta, ...patch }).success;

  it('treats a plain variation as an image, exactly as before video and carousel', () => {
    const parsed = campaignDraftSchema.parse(meta);
    expect(parsed.variations[0]?.creativeType).toBe('image');
    expect(parsed.identity?.instagramActorId).toBeNull();
    expect(variationMedia(parsed.variations[0]!)).toEqual({
      creativeIds: ['11111111-1111-4111-8111-111111111111'],
      videoIds: [],
    });
  });

  it('never lets anything be born active, on Meta either', () => {
    expect(ok({ startPaused: false })).toBe(false);
  });

  it('demands a page, placements and a sane age range', () => {
    expect(ok({ identity: undefined })).toBe(false);
    expect(ok({ identity: { pageId: 'minha-pagina' } })).toBe(false);
    expect(ok({ placements: undefined })).toBe(false);
    expect(ok({ ageMin: undefined })).toBe(false);
    expect(ok({ ageMin: 17 })).toBe(false);
    expect(ok({ ageMax: 66 })).toBe(false);
    expect(ok({ ageMin: 50, ageMax: 30 })).toBe(false);
    expect(ok({ ageMin: 30, ageMax: 30 })).toBe(true);
  });

  it('takes manual placements, and needs an Instagram account to advertise there', () => {
    const manual = { mode: 'manual', facebook: ['feed'], instagram: ['stories', 'reels'] };
    expect(ok({ placements: { mode: 'manual', facebook: [], instagram: [] } })).toBe(false);
    expect(ok({ placements: manual })).toBe(false);
    expect(
      ok({
        placements: manual,
        identity: { pageId: '104567890123456', instagramActorId: '17841400000000000' },
      }),
    ).toBe(true);
    expect(ok({ placements: { mode: 'manual', facebook: ['feed', 'stories'] } })).toBe(true);

    expect(usesVerticalPlacements(placementsSchema.parse(manual))).toBe(true);
    expect(usesVerticalPlacements(placementsSchema.parse({ mode: 'automatic' }))).toBe(false);
    expect(
      usesVerticalPlacements(placementsSchema.parse({ mode: 'manual', facebook: ['feed'] })),
    ).toBe(false);
  });

  it('takes a video variation and a carousel, each with what it needs', () => {
    const video = {
      creativeType: 'video',
      videoId: '33333333-3333-4333-8333-333333333333',
      headline: 'Veja a Wings por dentro',
      primaryText: 'Um minuto sobre o modelo.',
      callToAction: 'LEARN_MORE',
    };
    const card = (n: number, extra: Record<string, unknown> = {}) => ({
      creativeId: '11111111-1111-4111-8111-111111111111',
      headline: `Cartão ${n}`,
      description: 'Suporte completo.',
      link: 'https://wingscompany.com.br/franquia',
      ...extra,
    });
    const carousel = {
      creativeType: 'carousel',
      cards: [
        card(1),
        card(2, { mediaType: 'video', creativeId: undefined, videoId: video.videoId }),
      ],
      headline: 'Conheça a Wings',
      primaryText: 'Deslize para ver.',
      callToAction: 'LEARN_MORE',
    };

    const parsed = campaignDraftSchema.safeParse({ ...meta, variations: [video, carousel] });
    expect(parsed.success).toBe(true);
    expect(variationMedia(parsed.data!.variations[1]!)).toEqual({
      creativeIds: ['11111111-1111-4111-8111-111111111111'],
      videoIds: [video.videoId],
    });

    expect(ok({ variations: [variations[0], { ...video, videoId: undefined }] })).toBe(false);
    expect(ok({ variations: [variations[0], { ...carousel, cards: [card(1)] }] })).toBe(false);
    expect(
      ok({
        variations: [
          variations[0],
          { ...carousel, cards: Array.from({ length: 11 }, (_, i) => card(i)) },
        ],
      }),
    ).toBe(false);
    expect(
      ok({
        variations: [
          variations[0],
          { ...carousel, cards: [card(1), card(2, { link: 'http://x.com' })] },
        ],
      }),
    ).toBe(false);
    // Card copy answers to the same compliance rules.
    expect(
      ok({
        variations: [
          variations[0],
          { ...carousel, cards: [card(1), card(2, { headline: 'Retorno garantido' })] },
        ],
      }),
    ).toBe(false);
    expect(
      ok({ variations: [variations[0], { ...variations[1], cards: [card(1), card(2)] }] }),
    ).toBe(false);
  });

  it('keeps Meta-only fields off a Google draft', () => {
    const google = {
      ...meta,
      platform: 'google_search',
      formatKey: undefined,
      variations: [],
      identity: undefined,
      placements: undefined,
      ageMin: undefined,
      ageMax: undefined,
      search: {
        keywords: ['abrir franquia'],
        headlines: ['Franquia Wings'],
        descriptions: ['Conheça o modelo de negócio.'],
      },
    };
    expect(campaignDraftSchema.safeParse(google).success).toBe(true);
    expect(campaignDraftSchema.safeParse({ ...google, ageMin: 25 }).success).toBe(false);
    expect(
      campaignDraftSchema.safeParse({ ...google, placements: { mode: 'automatic' } }).success,
    ).toBe(false);
  });
});

describe('Google drafts', () => {
  const common: Omit<CampaignDraftInput, 'platform'> = {
    name: 'Pesquisa — franquia SP',
    objective: 'lead',
    idealCustomerProfile: 'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    reach: { states: ['SP'], cities: [{ name: 'Curitiba', state: 'PR' }] },
    destinationUrl: 'https://wingscompany.com.br/franquia',
    startDate: '2026-09-20',
    endDate: '2026-09-27',
    dailyBudgetCents: 3000,
    utms: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'pesquisa', utm_content: '' },
    startPaused: true,
  };

  const search: CampaignDraftInput = {
    ...common,
    platform: 'google_search',
    search: {
      keywords: ['franquia de alimentação', 'abrir franquia'],
      negativeKeywords: ['grátis'],
      headlines: ['Franquia Wings'],
      descriptions: ['Conheça o modelo de negócio e o suporte da Wings.'],
    },
  };

  const youtube: CampaignDraftInput = {
    ...common,
    platform: 'youtube',
    youtube: {
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      headline: 'Conheça a Wings',
    },
  };

  it('accepts a search draft and a YouTube draft, with no image', () => {
    const parsedSearch = campaignDraftSchema.safeParse(search);
    expect(parsedSearch.success).toBe(true);
    expect(parsedSearch.data?.variations).toEqual([]);
    expect(campaignDraftSchema.safeParse(youtube).success).toBe(true);
  });

  it('never lets a Google campaign be born active', () => {
    const result = campaignDraftSchema.safeParse({ ...search, startPaused: false });
    expect(result.error?.issues[0]?.message).toBe('Toda campanha nasce pausada');
  });

  it('caps keywords at 10 and negatives at 20, and refuses repeats and bad characters', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `franquia termo ${i}`);
    const withSearch = (patch: Record<string, unknown>) =>
      campaignDraftSchema.safeParse({ ...search, search: { ...search.search, ...patch } }).success;

    expect(withSearch({ keywords: many(10), negativeKeywords: many(20) })).toBe(true);
    expect(withSearch({ keywords: many(11) })).toBe(false);
    expect(withSearch({ negativeKeywords: many(21) })).toBe(false);
    expect(withSearch({ keywords: [] })).toBe(false);
    expect(withSearch({ keywords: ['Franquia', 'franquia'] })).toBe(false);
    expect(withSearch({ keywords: ['franquia 100%'] })).toBe(false);
  });

  it('holds search copy to the same compliance rules as Meta copy', () => {
    const result = campaignDraftSchema.safeParse({
      ...search,
      search: { ...search.search, headlines: ['Retorno garantido'] },
    });
    expect(result.success).toBe(false);
  });

  it('refuses the wrong parts: a video on search, keywords on YouTube, an image on either', () => {
    expect(campaignDraftSchema.safeParse({ ...search, youtube: youtube.youtube }).success).toBe(
      false,
    );
    expect(campaignDraftSchema.safeParse({ ...youtube, search: search.search }).success).toBe(
      false,
    );
    expect(campaignDraftSchema.safeParse({ ...search, formatKey: 'feed_square' }).success).toBe(
      false,
    );
    expect(campaignDraftSchema.safeParse({ ...youtube, youtube: undefined }).success).toBe(false);
  });

  it('accepts a radius on the map, alone or alongside states and cities', () => {
    const point = { latitude: -23.5, longitude: -46.6, radiusKm: 10 };
    for (const base of [search, youtube]) {
      expect(
        campaignDraftSchema.safeParse({
          ...base,
          reach: {
            states: ['SP'],
            cities: [{ name: 'Curitiba', state: 'PR' }],
            customLocations: [point],
          },
        }).success,
      ).toBe(true);
      expect(
        campaignDraftSchema.safeParse({
          ...base,
          reach: { states: [], cities: [], customLocations: [point] },
        }).success,
      ).toBe(true);
    }
  });
});

describe('YouTube links', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=10', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('reads the id out of %s', (url, id) => {
    expect(parseYoutubeVideoId(url)).toBe(id);
    expect(youtubeThumbnailUrl(id)).toBe(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
  });

  it.each([
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://vimeo.com/123456',
    'https://www.youtube.com/watch?v=curto',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/channel/UCabc',
    '',
  ])('refuses %s', (url) => {
    expect(parseYoutubeVideoId(url)).toBeNull();
  });
});

describe('cost estimate by platform', () => {
  it('uses 1.25x for Meta and 1x over the period for Google', () => {
    expect(estimateCostCents(1000, 10)).toBe(12_500);
    expect(estimateCostCents(1000, 10, 'meta')).toBe(12_500);
    expect(estimateCostCents(1000, 10, 'google_search')).toBe(10_000);
    expect(estimateCostCents(1000, 10, 'youtube')).toBe(10_000);
  });

  it("keeps Google's 2x for a single day, where no period evens it out", () => {
    expect(estimateCostCents(1000, 1, 'google_search')).toBe(2_000);
    expect(estimateCostCents(1000, 2, 'google_search')).toBe(2_000);
    expect(estimateCostCents(1000, 3, 'google_search')).toBe(3_000);
    // Meta's one factor covers both, so a single day changes nothing there.
    expect(estimateCostCents(1000, 1, 'meta')).toBe(1_250);
  });

  it('costs nothing over no days', () => {
    expect(estimateCostCents(1000, 0, 'google_search')).toBe(0);
    expect(estimateCostCents(1000, 0, 'meta')).toBe(0);
  });

  it('names both factors per platform', () => {
    expect(dailyOverdeliveryFactor('google')).toBe(2);
    expect(periodOverdeliveryFactor('google')).toBe(1);
    expect(periodOverdeliveryFactor('youtube')).toBe(1);
    expect(dailyOverdeliveryFactor('meta')).toBe(1.25);
    expect(periodOverdeliveryFactor('meta')).toBe(1.25);
  });

  it('labels Google traffic as such in the UTMs', () => {
    expect(
      buildUtms({ platform: 'google_search', objective: 'lead', campaignName: 'X' }),
    ).toMatchObject({ utm_source: 'google', utm_medium: 'cpc' });
    expect(buildUtms({ platform: 'youtube', objective: 'lead', campaignName: 'X' })).toMatchObject({
      utm_source: 'youtube',
      utm_medium: 'paid_video',
    });
  });
});

describe('what of the reach each platform takes', () => {
  const point = { latitude: -23.5, longitude: -46.6, radiusKm: 10 };

  it('lists every platform of the builder, the ones without an adapter included', () => {
    expect(Object.keys(PLATFORM_REACH).sort()).toEqual(PAID_PLATFORMS.map((p) => p.key).sort());
  });

  it('takes a radius on Meta, Google Pesquisa and YouTube; not on TikTok or LinkedIn', () => {
    expect(['meta', 'google_search', 'youtube'].map(platformAcceptsRadius)).toEqual([
      true,
      true,
      true,
    ]);
    expect(['tiktok', 'linkedin', 'unheard-of'].map(platformAcceptsRadius)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('refuses a radius where it is not taken, and says what to use instead', () => {
    expect(reachRefusal('tiktok', { customLocations: [point] })).toBe(
      'Esta plataforma não aceita raio: use estados e cidades',
    );
    expect(reachRefusal('linkedin', { customLocations: [point] })).toBe(RADIUS_NOT_ACCEPTED_HINT);
    // States and cities go everywhere.
    expect(reachRefusal('tiktok', { customLocations: [] })).toBeNull();
    expect(reachRefusal('tiktok', {})).toBeNull();
    expect(reachRefusal('google_search', { customLocations: [point] })).toBeNull();
  });
});
