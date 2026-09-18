import { describe, expect, it } from 'vitest';
import {
  CREATIVE_FORMATS,
  applyUtms,
  buildUtms,
  campaignDays,
  campaignDaysInMonth,
  campaignDraftSchema,
  checkCopyCompliance,
  estimateCostCents,
  matchesFormat,
  utmSlug,
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
  const valid: CampaignDraftInput = {
    platform: 'meta',
    name: 'Sacrifício — teste de escrita',
    objective: 'lead',
    formatKey: 'feed_square',
    destinationUrl: 'https://wingscompany.com.br/franquia',
    variations: [
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
    ],
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
      variations: [valid.variations[0], { ...valid.variations[1], headline: 'Retorno garantido' }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['variations', 1, 'headline']);
  });

  it('demands a creative on every variation', () => {
    const [first, second] = valid.variations;
    const result = campaignDraftSchema.safeParse({
      ...valid,
      variations: [first, { ...second, creativeId: '' }],
    });
    expect(result.error?.issues[0]?.message).toBe('Envie o criativo desta variação');
  });

  it('demands two to three variations', () => {
    expect(
      campaignDraftSchema.safeParse({ ...valid, variations: [valid.variations[0]] }).success,
    ).toBe(false);
  });

  it('refuses an end before the start, an http destination and an unknown format', () => {
    expect(campaignDraftSchema.safeParse({ ...valid, endDate: '2026-09-19' }).success).toBe(false);
    expect(
      campaignDraftSchema.safeParse({ ...valid, destinationUrl: 'http://x.com' }).success,
    ).toBe(false);
    expect(campaignDraftSchema.safeParse({ ...valid, formatKey: 'banner' }).success).toBe(false);
  });
});
