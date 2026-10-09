import { describe, expect, it } from 'vitest';
import {
  campaignDays,
  campaignDraftSchema,
  checkCopyCompliance,
  parseYoutubeVideoRef,
} from './campaign-builder.js';
import { YOUTUBE_FORMATACAO_OUT26, YOUTUBE_TEMPLATES } from './youtube-templates.js';

describe('YouTube · Formatação · Out26', () => {
  const today = '2026-10-09';
  const form = YOUTUBE_FORMATACAO_OUT26.draft(today);

  it('carries the analysis of 09/10: R$ 50 a day for 7 days, 25 to 65+, DF/GO/RJ/SC, YouTube only', () => {
    expect(form).toMatchObject({
      platform: 'youtube',
      name: 'YouTube · Formatação · Out26',
      objective: 'lead',
      dailyBudgetCents: 5000,
      startDate: '2026-10-09',
      endDate: '2026-10-15',
      startPaused: true,
      destinationUrl: 'https://wingssystem.online/lp/formatacao',
      reach: { states: ['DF', 'GO', 'RJ', 'SC'], cities: [], customLocations: [] },
      youtube: {
        ageMin: 25,
        ageMax: 65,
        includeUnknownAge: false,
        channels: ['youtube_in_stream', 'youtube_in_feed', 'youtube_shorts'],
        conversionAction: { name: 'RD form conversion' },
      },
    });
    expect(campaignDays(form.startDate, form.endDate)).toBe(7);
    expect(YOUTUBE_FORMATACAO_OUT26.conversion.name).toBe('RD form conversion');
    expect(form.youtube?.targetCpaCents).toBeUndefined();
    expect(parseYoutubeVideoRef(form.youtube!.videos[0]!)).toBe('34zzJBPHlYg');
  });

  it('is not a request until the person picks the logo and the conversion is found in the account', () => {
    expect(campaignDraftSchema.safeParse(form).success).toBe(false);
    const filled = {
      ...form,
      youtube: {
        ...form.youtube!,
        logoFileId: '7c1f4a52-2b8e-4d0a-9f3e-1a2b3c4d5e6f',
        conversionAction: { id: '7804997444', name: 'RD form conversion' },
      },
    };
    const parsed = campaignDraftSchema.safeParse(filled);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('has copy that passes the compliance rules and fits every limit', () => {
    const texts = [
      ...form.youtube!.headlines,
      ...form.youtube!.longHeadlines,
      ...form.youtube!.descriptions,
      form.youtube!.businessName,
    ];
    for (const text of texts) expect(checkCopyCompliance(text)).toEqual([]);
  });

  it('is the one template listed', () => {
    expect(YOUTUBE_TEMPLATES.map((template) => template.key)).toEqual(['youtube-formatacao-out26']);
  });
});

describe('parseYoutubeVideoRef', () => {
  it('takes a link or the bare id, nothing else', () => {
    expect(parseYoutubeVideoRef('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYoutubeVideoRef(' https://youtu.be/dQw4w9WgXcQ ')).toBe('dQw4w9WgXcQ');
    expect(parseYoutubeVideoRef('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYoutubeVideoRef('dQw4w9WgXc')).toBeNull();
    expect(parseYoutubeVideoRef('https://vimeo.com/123')).toBeNull();
  });
});
