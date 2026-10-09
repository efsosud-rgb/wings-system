import { buildUtms, type CampaignDraftInput } from './campaign-builder.js';

/**
 * Ready-made YouTube (Demand Gen) campaigns the builder can start from. A
 * template is a form filled in, never a request: the person still picks the
 * logo, checks the video and asks for approval like any other campaign.
 */

/** Where the Wings System serves its site pages (`/lp/<slug>`) in production. */
export const WINGS_PUBLIC_ORIGIN = 'https://wingssystem.online';

/** The conversion a template bids for, matched by name in the account's list. */
export interface YoutubeTemplateConversion {
  name: string;
}

export interface YoutubeTemplate {
  key: string;
  label: string;
  /** Why these numbers: the analysis it came from, for the person choosing it. */
  source: string;
  conversion: YoutubeTemplateConversion;
  /** The form, with dates from `today`; the logo and the conversion's id left to the screen. */
  draft: (today: string) => CampaignDraftInput;
}

function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const FORMATACAO_OUT26_NAME = 'YouTube · Formatação · Out26';

/**
 * The recommendation of the campaign analysis of 2026-10-09
 * (`/root/relatorios/campanhas/analise-2026-10-09.md`, item 3.2): R$ 50 a day
 * for 7 days, Maximize conversions on "RD form conversion", the Formatação
 * site page, 25 to 65+, DF, GO, RJ and SC, YouTube only (in-stream, in-feed,
 * Shorts). The video is the coffee-shop one, the best-retaining of the
 * account's videos, until the Jimmy Ogro case is on the channel.
 */
export const YOUTUBE_FORMATACAO_OUT26: YoutubeTemplate = {
  key: 'youtube-formatacao-out26',
  label: FORMATACAO_OUT26_NAME,
  source: 'Análise de campanhas de 09/10/2026, item 3.2',
  conversion: { name: 'RD form conversion' },
  draft: (today) => ({
    platform: 'youtube',
    name: FORMATACAO_OUT26_NAME,
    objective: 'lead',
    idealCustomerProfile:
      'Dono de empresa de serviços, alimentação ou varejo, de 25 a 65 anos, que quer transformar o negócio em uma rede de franquias.',
    reach: { states: ['DF', 'GO', 'RJ', 'SC'], cities: [], customLocations: [] },
    destinationUrl: `${WINGS_PUBLIC_ORIGIN}/lp/formatacao`,
    variations: [],
    youtube: {
      videos: ['https://www.youtube.com/watch?v=34zzJBPHlYg'],
      headlines: [
        'Sua empresa pode virar franquia?',
        'Faça o diagnóstico de franquia',
        '+1.400 projetos de franquia',
      ],
      longHeadlines: [
        'Sua empresa tem potencial para virar uma rede de franquias. Ela está pronta?',
        'Diagnóstico de franquia com quem já formatou mais de 1.400 projetos',
      ],
      descriptions: [
        'O sucesso começa com um diagnóstico. Ex-diretor da ABF-RJ avalia o seu negócio.',
        'Processos, gestão e governança para a sua empresa crescer como rede de franquias.',
      ],
      businessName: 'Wings Company',
      // Chosen on screen: a square logo from the Drive, and the conversion by name.
      logoFileId: '',
      conversionAction: { id: '', name: 'RD form conversion' },
      ageMin: 25,
      ageMax: 65,
      includeUnknownAge: false,
      channels: ['youtube_in_stream', 'youtube_in_feed', 'youtube_shorts'],
      audienceSegments: [],
    },
    startDate: today,
    endDate: plusDays(today, 6),
    dailyBudgetCents: 5000,
    utms: buildUtms({
      platform: 'youtube',
      objective: 'lead',
      campaignName: FORMATACAO_OUT26_NAME,
    }),
    startPaused: true,
  }),
};

export const YOUTUBE_TEMPLATES: readonly YoutubeTemplate[] = [YOUTUBE_FORMATACAO_OUT26];
