import { z } from 'zod';

/**
 * Contract for the campaign builder in the traffic studio.
 *
 * The builder never writes to an ad platform. Its only output is a draft that
 * becomes a `create_campaign` request in front of the approvals gate, so
 * everything here is about describing a campaign precisely enough for a person
 * to approve it — and about refusing copy that would get the account
 * restricted before a person ever sees it.
 */

/** Meta permits delivery to exceed the daily budget by up to this factor. */
export const META_DAILY_OVERDELIVERY_FACTOR = 1.25;
/**
 * Google's contractual ceiling for one day. The live account never went past
 * 1.35x (stage-google-spike.md), but a guardrail is sized by the worst case.
 */
export const GOOGLE_DAILY_OVERDELIVERY_FACTOR = 2;
/**
 * Google makes a second, tighter promise over a period: a month is never
 * charged beyond 30.4 x the daily budget, so the days that remain cost at most
 * the budget itself. Sizing the month by the one-day factor would demand twice
 * the ceiling for no reason (stage-google-spike.md, tetos-reais.md).
 */
export const GOOGLE_PERIOD_OVERDELIVERY_FACTOR = 1;

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export const PAID_PLATFORMS = [
  {
    key: 'meta',
    label: 'Meta (Facebook + Instagram)',
    enabled: true,
    disabledReason: null,
  },
  {
    key: 'google_search',
    label: 'Google Pesquisa',
    enabled: true,
    disabledReason: null,
  },
  {
    // Google's API cannot create a VIDEO campaign (reporting only). What it
    // offers for video on YouTube is Demand Gen, restricted to YouTube channels.
    key: 'youtube',
    label: 'YouTube',
    enabled: true,
    disabledReason: null,
  },
  {
    key: 'tiktok',
    label: 'TikTok',
    enabled: false,
    disabledReason: 'Sem conta de anúncios conectada',
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    enabled: false,
    disabledReason: 'Integração ainda não construída',
  },
] as const;

export type PaidPlatformKey = (typeof PAID_PLATFORMS)[number]['key'];

/** The ad account a builder platform spends from. */
export type AdAccountPlatform = 'meta' | 'google';
export const AD_ACCOUNT_PLATFORM: Record<'meta' | 'google_search' | 'youtube', AdAccountPlatform> =
  { meta: 'meta', google_search: 'google', youtube: 'google' };

export const GOOGLE_BUILDER_PLATFORMS = ['google_search', 'youtube'] as const;
export type GoogleBuilderPlatform = (typeof GOOGLE_BUILDER_PLATFORMS)[number];

export function isGooglePlatform(platform: string): platform is GoogleBuilderPlatform {
  return (GOOGLE_BUILDER_PLATFORMS as readonly string[]).includes(platform);
}

/** Google's `advertising_channel_type` for each builder platform. */
export const GOOGLE_CHANNEL_TYPE: Record<GoogleBuilderPlatform, 'SEARCH' | 'DEMAND_GEN'> = {
  google_search: 'SEARCH',
  youtube: 'DEMAND_GEN',
};

function spendsFromGoogle(platform: string): boolean {
  return isGooglePlatform(platform) || platform === 'google';
}

/** The most one single day can cost, as a multiple of the daily budget. */
export function dailyOverdeliveryFactor(platform: string): number {
  return spendsFromGoogle(platform)
    ? GOOGLE_DAILY_OVERDELIVERY_FACTOR
    : META_DAILY_OVERDELIVERY_FACTOR;
}

/**
 * The most a run of days can cost, as a multiple of budget x days. Meta makes
 * no period promise, so its daily factor applies to every day.
 */
export function periodOverdeliveryFactor(platform: string): number {
  return spendsFromGoogle(platform)
    ? GOOGLE_PERIOD_OVERDELIVERY_FACTOR
    : META_DAILY_OVERDELIVERY_FACTOR;
}

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export const CAMPAIGN_OBJECTIVES = ['lead', 'traffic', 'conversion'] as const;
export type CampaignObjective = (typeof CAMPAIGN_OBJECTIVES)[number];

export const CAMPAIGN_OBJECTIVE_LABEL: Record<CampaignObjective, string> = {
  lead: 'Geração de leads',
  traffic: 'Tráfego para o site',
  conversion: 'Conversão',
};

export const CAMPAIGN_OBJECTIVE_HINT: Record<CampaignObjective, string> = {
  lead: 'Formulário ou contato direto. É o objetivo das campanhas atuais da Wings.',
  traffic: 'Leva pessoas à página de destino. Não otimiza para cadastro.',
  conversion: 'Otimiza para um evento do pixel. Exige pixel instalado na página de destino.',
};

/** Meta's ODAX objective for each of ours. */
export const META_OBJECTIVE: Record<CampaignObjective, string> = {
  lead: 'OUTCOME_LEADS',
  traffic: 'OUTCOME_TRAFFIC',
  conversion: 'OUTCOME_SALES',
};

// ---------------------------------------------------------------------------
// Creative formats (static table)
// ---------------------------------------------------------------------------

export interface CreativeFormat {
  key: string;
  label: string;
  placement: string;
  width: number;
  height: number;
  ratio: string;
}

export const CREATIVE_FORMATS: Record<PaidPlatformKey, readonly CreativeFormat[]> = {
  meta: [
    {
      key: 'feed_square',
      label: 'Feed quadrado',
      placement: 'Feed do Facebook e do Instagram',
      width: 1080,
      height: 1080,
      ratio: '1:1',
    },
    {
      key: 'feed_vertical',
      label: 'Feed vertical',
      placement: 'Feed do Facebook e do Instagram',
      width: 1080,
      height: 1350,
      ratio: '4:5',
    },
    {
      key: 'stories_reels',
      label: 'Stories e Reels',
      placement: 'Stories e Reels, tela cheia',
      width: 1080,
      height: 1920,
      ratio: '9:16',
    },
    {
      key: 'landscape',
      label: 'Paisagem',
      placement: 'Feed com link, coluna da direita',
      width: 1200,
      height: 628,
      ratio: '1,91:1',
    },
  ],
  // Google campaigns are born as a shell: no image is uploaded for them yet.
  google_search: [],
  tiktok: [],
  youtube: [],
  linkedin: [],
};

/** What the server says about an image it accepted. Read from the bytes. */
export interface CreativeUpload {
  id: string;
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  byteSize: number;
}

/**
 * Whether an image has the proportions of a format, within 2%. A mismatch is
 * a warning, never a refusal: the platform crops, and the operator may want
 * exactly that.
 */
export function matchesFormat(
  image: { width: number; height: number },
  format: CreativeFormat,
): boolean {
  const wanted = format.width / format.height;
  const actual = image.width / image.height;
  return Math.abs(actual - wanted) / wanted <= 0.02;
}

// ---------------------------------------------------------------------------
// Calls to action
// ---------------------------------------------------------------------------

export const CALLS_TO_ACTION = [
  'LEARN_MORE',
  'SIGN_UP',
  'CONTACT_US',
  'GET_QUOTE',
  'DOWNLOAD',
] as const;
export type CallToAction = (typeof CALLS_TO_ACTION)[number];

export const CALL_TO_ACTION_LABEL: Record<CallToAction, string> = {
  LEARN_MORE: 'Saiba mais',
  SIGN_UP: 'Cadastre-se',
  CONTACT_US: 'Fale conosco',
  GET_QUOTE: 'Obter cotação',
  DOWNLOAD: 'Baixar',
};

// ---------------------------------------------------------------------------
// Copy compliance
// ---------------------------------------------------------------------------

/**
 * Why this exists: two ads on the live account were disapproved for
 * "Práticas de negócios inaceitáveis" and the account carries a restriction.
 * Franchise copy that promises income is exactly what triggers that, so the
 * builder refuses it before it can reach an approver, let alone Meta.
 */
export const COMPLIANCE_RULES = [
  'revenue_promise',
  'guaranteed_return',
  'payback',
  'earn_per_month',
  'investment_language',
] as const;
export type ComplianceRule = (typeof COMPLIANCE_RULES)[number];

export const COMPLIANCE_RULE_LABEL: Record<ComplianceRule, string> = {
  revenue_promise: 'Promessa de faturamento',
  guaranteed_return: 'Retorno garantido',
  payback: 'Prazo de payback',
  earn_per_month: '"Ganhe X por mês"',
  investment_language: 'Linguagem de investimento',
};

export const COMPLIANCE_RULE_ADVICE: Record<ComplianceRule, string> = {
  revenue_promise:
    'Não cite valores de faturamento, lucro ou renda. Fale do modelo de negócio e do suporte.',
  guaranteed_return: 'Nenhum resultado pode ser apresentado como garantido ou sem risco.',
  payback: 'Não prometa prazo de retorno. Esse número vai na COF, não no anúncio.',
  earn_per_month: 'Não anuncie ganhos mensais, nem como exemplo.',
  investment_language:
    'Franquia não é produto financeiro. Evite "investimento", "rentabilidade" e "renda passiva".',
};

export interface ComplianceFinding {
  rule: ComplianceRule;
  /** The offending stretch, as the operator typed it. */
  excerpt: string;
}

const MONEY = String.raw`(?:r\$\s?\d|\d[\d.,]*\s?(?:mil|k|milhao|milhoes|reais)\b|\d{1,3}(?:\.\d{3})+)`;
const INCOME_WORD = String.raw`(?:fatur\w+|lucr\w+|rend(?:a|er|imento)\w*|ganh\w+|receita\w*)`;

const COMPLIANCE_PATTERNS: Record<ComplianceRule, RegExp[]> = {
  revenue_promise: [
    new RegExp(String.raw`\b${INCOME_WORD}\b[^.!?\n]{0,40}?${MONEY}`, 'g'),
    new RegExp(String.raw`${MONEY}[^.!?\n]{0,40}?\b${INCOME_WORD}\b`, 'g'),
    /\b(?:alto|grande|maior) (?:faturamento|lucro)\b/g,
  ],
  guaranteed_return: [
    /\b(?:retorno|lucro|resultado|renda|ganho|sucesso|faturamento)s?(?: \w+)? garantid[oa]s?\b/g,
    /\bgarant(?:ia|imos|e|ido) (?:de |o |seu |sua )?(?:retorno|lucro|resultado|renda|ganho|sucesso|faturamento)s?\b/g,
    /\b(?:sem risco|risco zero|100% seguro|dinheiro de volta)\b/g,
  ],
  payback: [
    /\bpay ?back\b/g,
    /\bretorno (?:do (?:seu )?investimento |do capital )?em (?:ate )?\d+ (?:meses|mes|anos|ano|dias)\b/g,
    /\b(?:recupere|recupera|recuperar) (?:o |seu )?(?:investimento|capital|dinheiro)\b/g,
    /\broi\b/g,
  ],
  earn_per_month: [
    /\bganh(?:e|ar|ando|a)\b[^.!?\n]{0,40}?(?:por|ao|a cada|\/) ?mes\b/g,
    new RegExp(String.raw`${MONEY}\s?(?:por|ao|a cada|\/) ?mes\b`, 'g'),
    /\b(?:renda|salario|ganhos?) (?:mensal|mensais|extra)\b/g,
  ],
  investment_language: [
    /\binvest(?:imento|imentos|ir|idor|idores|idora|a|e|indo)\b/g,
    /\b(?:rentabilidade|rentavel|renda passiva|dividendos?|aplicacao financeira|lucratividade)\b/g,
  ],
};

/**
 * Lower-cases and strips accents **without changing the length**, so a match
 * index in the normalised text is the same index in what the operator typed.
 */
function foldForMatching(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[À-ſ]/g, (char) => char.normalize('NFD').charAt(0))
    .toLowerCase();
}

/** Every compliance problem in one piece of copy. Empty means clean. */
export function checkCopyCompliance(text: string): ComplianceFinding[] {
  const original = text.normalize('NFC');
  const folded = foldForMatching(original);
  const findings: ComplianceFinding[] = [];
  const seen = new Set<string>();

  for (const rule of COMPLIANCE_RULES) {
    for (const pattern of COMPLIANCE_PATTERNS[rule]) {
      for (const match of folded.matchAll(pattern)) {
        const excerpt = original.slice(match.index, match.index + match[0].length).trim();
        const key = `${rule}:${excerpt.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ rule, excerpt });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// UTMs
// ---------------------------------------------------------------------------

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type UtmParams = Record<UtmKey, string>;

const UTM_MEDIUM: Record<PaidPlatformKey, string> = {
  meta: 'paid_social',
  google_search: 'cpc',
  tiktok: 'paid_social',
  youtube: 'paid_video',
  linkedin: 'paid_social',
};

const UTM_SOURCE: Record<PaidPlatformKey, string> = {
  meta: 'meta',
  google_search: 'google',
  tiktok: 'tiktok',
  youtube: 'youtube',
  linkedin: 'linkedin',
};

/** "Expansão SP — Set/26" -> "expansao-sp-set-26". */
export function utmSlug(value: string): string {
  return foldForMatching(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function buildUtms(input: {
  platform: PaidPlatformKey;
  objective: CampaignObjective;
  campaignName: string;
}): UtmParams {
  return {
    utm_source: UTM_SOURCE[input.platform],
    utm_medium: UTM_MEDIUM[input.platform],
    utm_campaign: utmSlug(input.campaignName) || 'campanha',
    // One value per campaign; each variation appends its own suffix (-v1, -v2).
    utm_content: input.objective,
  };
}

/** The destination URL with UTMs applied; null while the URL is not valid. */
export function applyUtms(url: string, utms: UtmParams, variationIndex?: number): string | null {
  // Plain string handling: this package compiles without DOM or Node types,
  // so the URL class is not available here.
  const trimmed = url.trim();
  if (!/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(trimmed)) return null;

  const [beforeHash = '', ...hashParts] = trimmed.split('#');
  const [base = '', ...queryParts] = beforeHash.split('?');
  const utmKeys: readonly string[] = UTM_KEYS;
  // An operator-typed UTM already in the address is replaced, never doubled.
  const params = queryParts
    .join('?')
    .split('&')
    .filter((pair) => pair !== '' && !utmKeys.includes(pair.split('=')[0] ?? ''));

  for (const key of UTM_KEYS) {
    const value = utms[key].trim();
    if (!value) continue;
    const suffix =
      key === 'utm_content' && variationIndex !== undefined ? `-v${variationIndex + 1}` : '';
    params.push(`${key}=${encodeURIComponent(`${value}${suffix}`)}`);
  }

  const hash = hashParts.length > 0 ? `#${hashParts.join('#')}` : '';
  return `${base}${params.length > 0 ? `?${params.join('&')}` : ''}${hash}`;
}

// ---------------------------------------------------------------------------
// Duration and cost
// ---------------------------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function utcDay(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Days the campaign runs, counting both the first and the last. */
export function campaignDays(startDate: string, endDate: string): number | null {
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) return null;
  const start = utcDay(startDate);
  const end = utcDay(endDate);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 86_400_000) + 1;
}

/** Days of the campaign that fall inside the month of `today` (YYYY-MM-DD). */
export function campaignDaysInMonth(startDate: string, endDate: string, today: string): number {
  if (campaignDays(startDate, endDate) === null || !DATE_PATTERN.test(today)) return 0;
  const [year, month] = today.split('-').map(Number) as [number, number];
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 0);
  const from = Math.max(utcDay(startDate), monthStart);
  const to = Math.min(utcDay(endDate), monthEnd);
  return to < from ? 0 : Math.round((to - from) / 86_400_000) + 1;
}

/**
 * What the campaign can really cost: budget is not spend. Meta may deliver up
 * to 25% over the daily budget, every day. Google may deliver twice the budget
 * on a given day but evens it out over the period, so the period costs the
 * budget itself — and never less than one worst day, which is what decides a
 * run of a single day. The budget guard judges a new request by this figure.
 */
export function estimateCostCents(
  dailyBudgetCents: number,
  days: number,
  platform: string = 'meta',
): number {
  if (days <= 0) return 0;
  return Math.max(
    Math.round(dailyBudgetCents * days * periodOverdeliveryFactor(platform)),
    Math.round(dailyBudgetCents * dailyOverdeliveryFactor(platform)),
  );
}

// ---------------------------------------------------------------------------
// Audience: ideal customer profile and reach
// ---------------------------------------------------------------------------

export const BRAZIL_STATES = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;
export type BrazilState = (typeof BRAZIL_STATES)[number];

export const ICP_MIN = 20;
export const ICP_MAX = 2000;
export const MAX_REACH_CITIES = 50;

/**
 * Where the campaign should reach: whole states, single cities, a radius
 * around a point on the map, or any mix of them.
 *
 * Minimal on purpose. Cities are names the operator types, not ids from a
 * gazetteer: nothing consumes them yet except a person reading the request, and
 * mapping them to a platform's location keys belongs with ad-set creation.
 */
/**
 * A point on the map and a radius around it — Meta's
 * `geo_locations.custom_locations` (latitude, longitude, radius, kilometres).
 * The radius bounds are Meta's documented ones for a custom location; like
 * everything about targeting, they are unverified on the live account until
 * ad-set creation exists.
 */
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 80;
export const DEFAULT_RADIUS_KM = 15;
export const MAX_CUSTOM_LOCATIONS = 5;

export const customLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusKm: z
    .number()
    .int()
    .min(MIN_RADIUS_KM, `O raio mínimo é ${MIN_RADIUS_KM} km`)
    .max(MAX_RADIUS_KM, `O raio máximo é ${MAX_RADIUS_KM} km`),
  /** A place name for people to read; the coordinates are what counts. */
  label: z.string().trim().max(80).optional(),
});
export type CustomLocation = z.output<typeof customLocationSchema>;

export const reachSchema = z
  .object({
    states: z.array(z.enum(BRAZIL_STATES)).max(BRAZIL_STATES.length),
    cities: z
      .array(
        z.object({
          name: z.string().trim().min(2, 'Informe a cidade').max(80),
          state: z.enum(BRAZIL_STATES, { error: 'Escolha a UF' }),
        }),
      )
      .max(MAX_REACH_CITIES, `No máximo ${MAX_REACH_CITIES} cidades`),
    /** Absent in reaches saved before the map existed, hence the default. */
    customLocations: z
      .array(customLocationSchema)
      .max(MAX_CUSTOM_LOCATIONS, `No máximo ${MAX_CUSTOM_LOCATIONS} pontos no mapa`)
      .default([]),
  })
  .refine((reach) => reach.states.length + reach.cities.length + reach.customLocations.length > 0, {
    message: 'Escolha pelo menos um estado, uma cidade ou um ponto no mapa',
  });
export type Reach = z.output<typeof reachSchema>;

const idealCustomerProfile = z
  .string()
  .trim()
  .min(ICP_MIN, `Descreva o cliente ideal em pelo menos ${ICP_MIN} caracteres`)
  .max(ICP_MAX, `Máximo de ${ICP_MAX} caracteres`);

/**
 * The tenant's standing answer to "who are we talking to, and where". The
 * builder starts from it; each campaign then carries its own copy, so editing
 * the default later never rewrites a request somebody already approved.
 */
export const audienceProfileSchema = z.object({ idealCustomerProfile, reach: reachSchema });
export type AudienceProfileInput = z.output<typeof audienceProfileSchema>;

export interface AudienceProfile extends AudienceProfileInput {
  updatedAt: string;
  updatedByName: string | null;
}

export function describeCustomLocation(location: CustomLocation, index: number): string {
  const place =
    location.label ??
    `Ponto ${index + 1} (${location.latitude.toFixed(3)}, ${location.longitude.toFixed(3)})`;
  return `${location.radiusKm} km ao redor de ${place}`;
}

/** Tolerates a reach stored before the map existed, read back without parsing. */
export function describeReach(
  reach: Omit<Reach, 'customLocations'> & { customLocations?: CustomLocation[] },
): string {
  const parts = [
    ...reach.states.map((state) => `${state} (estado todo)`),
    ...reach.cities.map((city) => `${city.name}/${city.state}`),
    ...(reach.customLocations ?? []).map(describeCustomLocation),
  ];
  return parts.join(' · ') || '—';
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

export const MIN_VARIATIONS = 2;
export const MAX_VARIATIONS = 3;
export const HEADLINE_MAX = 40;
export const PRIMARY_TEXT_MAX = 500;
/** Meta truncates primary text around here on most placements. */
export const PRIMARY_TEXT_RECOMMENDED = 125;
/** Smallest daily budget the system will ask for: R$ 1,00. Meta may demand more. */
export const MIN_DAILY_BUDGET_CENTS = 100;

const compliantText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `Informe ${label}`)
    .max(max, `Máximo de ${max} caracteres`)
    .superRefine((value, ctx) => {
      for (const finding of checkCopyCompliance(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `${COMPLIANCE_RULE_LABEL[finding.rule]}: "${finding.excerpt}"`,
        });
      }
    });

// ---------------------------------------------------------------------------
// Google: YouTube video and Search keywords
// ---------------------------------------------------------------------------

const YOUTUBE_ID = '[A-Za-z0-9_-]{11}';
const YOUTUBE_PATTERNS = [
  new RegExp(
    String.raw`^https://(?:www\.|m\.)?youtube\.com/watch\?(?:[^#]*&)?v=(${YOUTUBE_ID})(?:[&#].*)?$`,
  ),
  new RegExp(String.raw`^https://youtu\.be/(${YOUTUBE_ID})(?:[?#].*)?$`),
  new RegExp(
    String.raw`^https://(?:www\.|m\.)?youtube\.com/(?:shorts|embed|live)/(${YOUTUBE_ID})(?:[?#/].*)?$`,
  ),
];

/** The 11-character video id of a YouTube link, or null when it is not one. */
export function parseYoutubeVideoId(url: string): string | null {
  const trimmed = url.trim();
  for (const pattern of YOUTUBE_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** YouTube's own still for a video; needs no API key. */
export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export const MAX_KEYWORDS = 10;
export const MAX_NEGATIVE_KEYWORDS = 20;
export const KEYWORD_MAX_LENGTH = 80;
export const KEYWORD_MAX_WORDS = 10;
/** Google's limits for a responsive search ad's parts. */
export const SEARCH_HEADLINE_MAX = 30;
export const SEARCH_DESCRIPTION_MAX = 90;
export const MAX_SEARCH_HEADLINES = 3;
export const MAX_SEARCH_DESCRIPTIONS = 2;

/** Google refuses these characters in a keyword. */
const KEYWORD_FORBIDDEN = /[!@%,*=;`<>^{}|~]/;

const keywordSchema = z
  .string()
  .trim()
  .min(2, 'Palavra-chave muito curta')
  .max(KEYWORD_MAX_LENGTH, `Máximo de ${KEYWORD_MAX_LENGTH} caracteres por palavra-chave`)
  .refine((value) => !KEYWORD_FORBIDDEN.test(value), 'Caractere não aceito pelo Google')
  .refine(
    (value) => value.split(/\s+/).length <= KEYWORD_MAX_WORDS,
    `No máximo ${KEYWORD_MAX_WORDS} palavras por palavra-chave`,
  );

const keywordList = (max: number, label: string) =>
  z
    .array(keywordSchema)
    .max(max, `No máximo ${max} ${label}`)
    .refine(
      (list) => new Set(list.map((item) => item.toLowerCase())).size === list.length,
      'Há palavras-chave repetidas',
    );

export const youtubeDraftSchema = z.object({
  videoUrl: z
    .string()
    .trim()
    .refine((value) => parseYoutubeVideoId(value) !== null, 'Informe um link https:// do YouTube'),
  /** Shown over the video in the preview, and the ad's headline next wave. */
  headline: compliantText(HEADLINE_MAX, 'o título'),
});
export type YoutubeDraft = z.output<typeof youtubeDraftSchema>;

export const searchDraftSchema = z.object({
  keywords: keywordList(MAX_KEYWORDS, 'palavras-chave').min(
    1,
    'Informe ao menos uma palavra-chave',
  ),
  negativeKeywords: keywordList(MAX_NEGATIVE_KEYWORDS, 'palavras-chave negativas').default([]),
  headlines: z
    .array(compliantText(SEARCH_HEADLINE_MAX, 'o título'))
    .min(1, 'Escreva ao menos um título')
    .max(MAX_SEARCH_HEADLINES),
  descriptions: z
    .array(compliantText(SEARCH_DESCRIPTION_MAX, 'a descrição'))
    .min(1, 'Escreva ao menos uma descrição')
    .max(MAX_SEARCH_DESCRIPTIONS),
});
export type SearchDraft = z.output<typeof searchDraftSchema>;

// ---------------------------------------------------------------------------
// Meta: creative types, placements, age range, page and Instagram account
// ---------------------------------------------------------------------------

export const CREATIVE_TYPES = ['image', 'video', 'carousel'] as const;
export type CreativeType = (typeof CREATIVE_TYPES)[number];

export const CREATIVE_TYPE_LABEL: Record<CreativeType, string> = {
  image: 'Imagem única',
  video: 'Vídeo',
  carousel: 'Carrossel',
};

export const MIN_CAROUSEL_CARDS = 2;
export const MAX_CAROUSEL_CARDS = 10;
export const CARD_DESCRIPTION_MAX = 60;
/** Meta's ceiling for an ad video. */
export const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const;

/** What the server says about a video it accepted. */
export interface VideoUpload {
  id: string;
  mimeType: (typeof VIDEO_MIME_TYPES)[number];
  byteSize: number;
}

const mediaRefinement = (
  media: { mediaType: 'image' | 'video'; creativeId?: string; videoId?: string },
  ctx: z.RefinementCtx,
  imageMessage: string,
) => {
  if (media.mediaType === 'image' && !media.creativeId) {
    ctx.addIssue({ code: 'custom', path: ['creativeId'], message: imageMessage });
  }
  if (media.mediaType === 'video' && !media.videoId) {
    ctx.addIssue({ code: 'custom', path: ['videoId'], message: 'Envie o vídeo' });
  }
};

export const carouselCardSchema = z
  .object({
    mediaType: z.enum(['image', 'video']).default('image'),
    creativeId: z.uuid().optional(),
    videoId: z.uuid().optional(),
    headline: compliantText(HEADLINE_MAX, 'o título do cartão'),
    description: compliantText(CARD_DESCRIPTION_MAX, 'o texto do cartão'),
    link: z.url({ protocol: /^https$/, error: 'Informe um endereço https:// válido' }),
  })
  .superRefine((card, ctx) => mediaRefinement(card, ctx, 'Envie a imagem do cartão'));
export type CarouselCard = z.output<typeof carouselCardSchema>;

/**
 * One ad. `creativeType` defaults to `image`, and an image variation is exactly
 * what a variation was before video and carousel existed — so drafts approved
 * back then still parse, and still hash the same.
 */
export const copyVariationSchema = z
  .object({
    creativeType: z.enum(CREATIVE_TYPES).default('image'),
    /** The uploaded image this copy goes with; the server checks it exists. */
    creativeId: z.union([z.uuid(), z.literal('')]).optional(),
    /** The uploaded video, for a video variation. */
    videoId: z.uuid().optional(),
    /** Carousel only. */
    cards: z.array(carouselCardSchema).optional(),
    headline: compliantText(HEADLINE_MAX, 'o título'),
    primaryText: compliantText(PRIMARY_TEXT_MAX, 'o texto'),
    callToAction: z.enum(CALLS_TO_ACTION),
  })
  .superRefine((variation, ctx) => {
    if (variation.creativeType === 'image' && !variation.creativeId) {
      ctx.addIssue({
        code: 'custom',
        path: ['creativeId'],
        message: 'Envie o criativo desta variação',
      });
    }
    if (variation.creativeType === 'video' && !variation.videoId) {
      ctx.addIssue({ code: 'custom', path: ['videoId'], message: 'Envie o vídeo desta variação' });
    }
    if (variation.creativeType === 'carousel') {
      const count = variation.cards?.length ?? 0;
      if (count < MIN_CAROUSEL_CARDS || count > MAX_CAROUSEL_CARDS) {
        ctx.addIssue({
          code: 'custom',
          path: ['cards'],
          message: `Um carrossel tem de ${MIN_CAROUSEL_CARDS} a ${MAX_CAROUSEL_CARDS} cartões`,
        });
      }
    } else if (variation.cards && variation.cards.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['cards'], message: 'Cartões são só do carrossel' });
    }
  });
export type CopyVariation = z.output<typeof copyVariationSchema>;

/** Every uploaded image and video a variation points at, cards included. */
export function variationMedia(variation: CopyVariation): {
  creativeIds: string[];
  videoIds: string[];
} {
  const creativeIds: string[] = [];
  const videoIds: string[] = [];
  if (variation.creativeType === 'image' && variation.creativeId) {
    creativeIds.push(variation.creativeId);
  }
  if (variation.creativeType === 'video' && variation.videoId) videoIds.push(variation.videoId);
  for (const card of variation.creativeType === 'carousel' ? (variation.cards ?? []) : []) {
    if (card.mediaType === 'image' && card.creativeId) creativeIds.push(card.creativeId);
    if (card.mediaType === 'video' && card.videoId) videoIds.push(card.videoId);
  }
  return { creativeIds, videoIds };
}

export const MIN_AGE = 18;
export const MAX_AGE = 65;
export const DEFAULT_AGE_MIN = 25;
export const DEFAULT_AGE_MAX = 65;

const AGE_MESSAGE = `A idade vai de ${MIN_AGE} a ${MAX_AGE} anos`;
const ageSchema = z
  .number({ error: AGE_MESSAGE })
  .int(AGE_MESSAGE)
  .min(MIN_AGE, AGE_MESSAGE)
  .max(MAX_AGE, AGE_MESSAGE);

export const PLACEMENT_PUBLISHERS = ['facebook', 'instagram'] as const;
export type PlacementPublisher = (typeof PLACEMENT_PUBLISHERS)[number];
export const PLACEMENT_POSITIONS = ['feed', 'stories', 'reels'] as const;
export type PlacementPosition = (typeof PLACEMENT_POSITIONS)[number];

export const PLACEMENT_PUBLISHER_LABEL: Record<PlacementPublisher, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
};
export const PLACEMENT_POSITION_LABEL: Record<PlacementPosition, string> = {
  feed: 'Feed',
  stories: 'Stories',
  reels: 'Reels',
};

const positionList = z.array(z.enum(PLACEMENT_POSITIONS)).max(PLACEMENT_POSITIONS.length);

/**
 * Where the ads may appear. `automatic` is Meta's Advantage+ placements: the
 * ad set names no placement and Meta chooses. `manual` names them.
 */
export const placementsSchema = z
  .object({
    mode: z.enum(['automatic', 'manual']),
    facebook: positionList.default([]),
    instagram: positionList.default([]),
  })
  .superRefine((placements, ctx) => {
    if (
      placements.mode === 'manual' &&
      placements.facebook.length + placements.instagram.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['facebook'],
        message: 'Escolha ao menos um posicionamento',
      });
    }
  });
export type Placements = z.output<typeof placementsSchema>;

/** True when the chosen placements include a full-screen vertical one. */
export function usesVerticalPlacements(placements: Placements | undefined): boolean {
  if (!placements || placements.mode !== 'manual') return false;
  return [...placements.facebook, ...placements.instagram].some(
    (position) => position === 'stories' || position === 'reels',
  );
}

/** The Facebook Page and Instagram account the ads are published as. */
export const metaIdentitySchema = z.object({
  pageId: z.string().regex(/^\d{5,25}$/, 'Escolha a Página do Facebook'),
  instagramActorId: z
    .string()
    .regex(/^\d{5,25}$/)
    .nullable()
    .default(null),
});
export type MetaIdentity = z.output<typeof metaIdentitySchema>;

/** What `GET /ads/meta/identities` answers: read from Meta, never typed in. */
export interface MetaIdentities {
  pages: {
    id: string;
    name: string;
    instagramAccounts: { id: string; username: string }[];
  }[];
  /** Wings' standing choice, if one was saved. */
  default: MetaIdentity | null;
}

/** Placements the official preview can be asked for, once the ads exist. */
export const PREVIEW_PLACEMENTS = [
  'facebook_feed',
  'instagram_feed',
  'facebook_stories',
  'instagram_stories',
  'facebook_reels',
  'instagram_reels',
] as const;
export type PreviewPlacement = (typeof PREVIEW_PLACEMENTS)[number];

export const PREVIEW_PLACEMENT_LABEL: Record<PreviewPlacement, string> = {
  facebook_feed: 'Feed do Facebook',
  instagram_feed: 'Feed do Instagram',
  facebook_stories: 'Stories do Facebook',
  instagram_stories: 'Stories do Instagram',
  facebook_reels: 'Reels do Facebook',
  instagram_reels: 'Reels do Instagram',
};

/** One official preview: Meta's own iframe, host checked by the server. */
export interface OfficialPreview {
  adName: string;
  iframeSrc: string;
}

const dateString = z.string().regex(DATE_PATTERN, 'Informe a data');

const utmValue = z
  .string()
  .trim()
  .max(80, 'Máximo de 80 caracteres')
  .regex(/^[A-Za-z0-9_.-]*$/, 'Use só letras, números, hífen, ponto e sublinhado');

export const DRAFT_PLATFORMS = ['meta', 'google_search', 'youtube'] as const;
export type DraftPlatform = (typeof DRAFT_PLATFORMS)[number];

/**
 * One shape for every platform, with the platform-specific parts required by
 * the refinement below. A Meta draft is exactly what it was before Google
 * existed, so drafts already approved keep their hash.
 *
 * Google drafts carry no uploaded image and are always born paused: the first
 * real Google write is a shell created with a person watching.
 */
export const campaignDraftSchema = z
  .object({
    platform: z.enum(DRAFT_PLATFORMS, { error: 'Escolha uma plataforma habilitada' }),
    name: z.string().trim().min(3, 'Dê um nome à campanha').max(120),
    objective: z.enum(CAMPAIGN_OBJECTIVES, { error: 'Escolha o objetivo' }),
    idealCustomerProfile,
    reach: reachSchema,
    /** Meta only. */
    formatKey: z.string().optional(),
    destinationUrl: z.url({ protocol: /^https$/, error: 'Informe um endereço https:// válido' }),
    /** Meta only: image plus copy. Google drafts send none. */
    variations: z
      .array(copyVariationSchema)
      .max(MAX_VARIATIONS, `No máximo ${MAX_VARIATIONS} variações`)
      .default([]),
    /**
     * Meta only, and absent on drafts from before ad sets existed: those create
     * the campaign shell alone, as they were approved to.
     */
    ageMin: ageSchema.optional(),
    ageMax: ageSchema.optional(),
    placements: placementsSchema.optional(),
    identity: metaIdentitySchema.optional(),
    /** YouTube only. */
    youtube: youtubeDraftSchema.optional(),
    /** Google Pesquisa only. */
    search: searchDraftSchema.optional(),
    startDate: dateString,
    endDate: dateString,
    dailyBudgetCents: z
      .number({ error: 'Informe a verba diária' })
      .int()
      .min(MIN_DAILY_BUDGET_CENTS, 'A verba diária mínima é R$ 1,00'),
    utms: z.object({
      utm_source: utmValue.min(1, 'Obrigatório'),
      utm_medium: utmValue.min(1, 'Obrigatório'),
      utm_campaign: utmValue.min(1, 'Obrigatório'),
      utm_content: utmValue,
    }),
    /** Born paused: what the sacrifice-campaign test uses. Always true on Google. */
    startPaused: z.boolean(),
  })
  .superRefine((draft, ctx) => {
    if (campaignDays(draft.startDate, draft.endDate) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'O fim não pode ser antes do início',
      });
    }

    // Decided 2026-09-19: everything this system creates is born paused, on every
    // platform. Switching a campaign on is a person's act, in the platform.
    if (!draft.startPaused) {
      ctx.addIssue({
        code: 'custom',
        path: ['startPaused'],
        message: 'Toda campanha nasce pausada',
      });
    }

    const foreign = (field: 'youtube' | 'search' | 'variations' | 'formatKey', label: string) =>
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${label} não pertence a esta plataforma`,
      });

    if (draft.platform === 'meta') {
      if (!CREATIVE_FORMATS.meta.some((format) => format.key === draft.formatKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['formatKey'],
          message: draft.formatKey ? 'Formato inválido' : 'Escolha o formato',
        });
      }
      if (draft.variations.length < MIN_VARIATIONS) {
        ctx.addIssue({
          code: 'custom',
          path: ['variations'],
          message: `Crie pelo menos ${MIN_VARIATIONS} variações`,
        });
      }
      if (draft.youtube) foreign('youtube', 'O vídeo do YouTube');
      if (draft.search) foreign('search', 'As palavras-chave');

      if (!draft.identity) {
        ctx.addIssue({
          code: 'custom',
          path: ['identity', 'pageId'],
          message: 'Escolha a Página do Facebook',
        });
      }
      if (!draft.placements) {
        ctx.addIssue({
          code: 'custom',
          path: ['placements', 'mode'],
          message: 'Escolha os posicionamentos',
        });
      }
      if (draft.ageMin === undefined || draft.ageMax === undefined) {
        ctx.addIssue({ code: 'custom', path: ['ageMin'], message: 'Informe a faixa etária' });
      } else if (draft.ageMin > draft.ageMax) {
        ctx.addIssue({
          code: 'custom',
          path: ['ageMax'],
          message: 'A idade máxima não pode ser menor que a mínima',
        });
      }
      if (
        draft.placements?.mode === 'manual' &&
        draft.placements.instagram.length > 0 &&
        !draft.identity?.instagramActorId
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['identity', 'instagramActorId'],
          message: 'Escolha a conta do Instagram para anunciar no Instagram',
        });
      }
      return;
    }

    // Google from here on.
    for (const field of ['ageMin', 'ageMax', 'placements', 'identity'] as const) {
      if (draft[field] !== undefined) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'Campo só da Meta' });
      }
    }
    if (draft.reach.customLocations.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['reach', 'customLocations'],
        message: 'O raio no mapa ainda não vale para o Google: use estados e cidades',
      });
    }
    if (draft.variations.length > 0) foreign('variations', 'Criativo de imagem');
    if (draft.formatKey) foreign('formatKey', 'Formato de imagem');

    if (draft.platform === 'youtube') {
      if (!draft.youtube) {
        ctx.addIssue({ code: 'custom', path: ['youtube', 'videoUrl'], message: 'Informe o vídeo' });
      }
      if (draft.search) foreign('search', 'As palavras-chave');
    } else {
      if (!draft.search) {
        ctx.addIssue({
          code: 'custom',
          path: ['search', 'keywords'],
          message: 'Informe as palavras-chave',
        });
      }
      if (draft.youtube) foreign('youtube', 'O vídeo do YouTube');
    }
  });

export type CampaignDraftInput = z.input<typeof campaignDraftSchema>;
export type CampaignDraft = z.output<typeof campaignDraftSchema>;
