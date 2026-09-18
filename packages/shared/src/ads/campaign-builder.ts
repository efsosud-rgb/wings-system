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
    key: 'tiktok',
    label: 'TikTok',
    enabled: false,
    disabledReason: 'Sem conta de anúncios conectada',
  },
  {
    key: 'youtube',
    label: 'YouTube',
    enabled: false,
    disabledReason: 'Google Ads aguardando acesso à API',
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    enabled: false,
    disabledReason: 'Integração ainda não construída',
  },
] as const;

export type PaidPlatformKey = (typeof PAID_PLATFORMS)[number]['key'];

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

const UTM_SOURCE: Record<PaidPlatformKey, string> = {
  meta: 'meta',
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
    utm_medium: 'paid_social',
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
 * What the campaign can really cost: budget is not spend, and the platform may
 * deliver up to 25% over the daily budget.
 */
export function estimateCostCents(dailyBudgetCents: number, days: number): number {
  return Math.round(dailyBudgetCents * days * META_DAILY_OVERDELIVERY_FACTOR);
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

export const copyVariationSchema = z.object({
  /** The uploaded image this copy goes with; the server checks it exists. */
  creativeId: z.uuid({ error: 'Envie o criativo desta variação' }),
  headline: compliantText(HEADLINE_MAX, 'o título'),
  primaryText: compliantText(PRIMARY_TEXT_MAX, 'o texto'),
  callToAction: z.enum(CALLS_TO_ACTION),
});
export type CopyVariation = z.output<typeof copyVariationSchema>;

const dateString = z.string().regex(DATE_PATTERN, 'Informe a data');

const utmValue = z
  .string()
  .trim()
  .max(80, 'Máximo de 80 caracteres')
  .regex(/^[A-Za-z0-9_.-]*$/, 'Use só letras, números, hífen, ponto e sublinhado');

export const campaignDraftSchema = z
  .object({
    platform: z.literal('meta', { error: 'Só a Meta está habilitada' }),
    name: z.string().trim().min(3, 'Dê um nome à campanha').max(120),
    objective: z.enum(CAMPAIGN_OBJECTIVES, { error: 'Escolha o objetivo' }),
    formatKey: z.string().min(1, 'Escolha o formato'),
    destinationUrl: z.url({ protocol: /^https$/, error: 'Informe um endereço https:// válido' }),
    variations: z
      .array(copyVariationSchema)
      .min(MIN_VARIATIONS, `Crie pelo menos ${MIN_VARIATIONS} variações`)
      .max(MAX_VARIATIONS, `No máximo ${MAX_VARIATIONS} variações`),
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
    /** Born paused: what the sacrifice-campaign test uses. */
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
    if (!CREATIVE_FORMATS[draft.platform].some((format) => format.key === draft.formatKey)) {
      ctx.addIssue({ code: 'custom', path: ['formatKey'], message: 'Formato inválido' });
    }
  });

export type CampaignDraftInput = z.input<typeof campaignDraftSchema>;
export type CampaignDraft = z.output<typeof campaignDraftSchema>;
