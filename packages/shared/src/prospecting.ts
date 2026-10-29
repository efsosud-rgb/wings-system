import { z } from 'zod';
import { LEAD_NAME_MAX } from './leads.js';

/**
 * CRM Vendas → Prospecção (docs/crm/prospeccao.md): companies found live on Google Maps through the
 * Places API (New). Google's terms (Maps Platform 3.2.3) allow storing only the place_id, so every
 * name, address, phone, site, rating and review count below lives in a response, never in a table.
 */

export const PROSPECT_STATUSES = [
  'reservado',
  'descartado',
  'contatado',
  'sem_interesse',
  'nao_contatar',
  'virou_lead',
  'nao_encontrado',
] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const PROSPECT_STATUS_LABELS: Record<ProspectStatus, string> = {
  reservado: 'Reservado',
  descartado: 'Descartado',
  contatado: 'Contatado',
  sem_interesse: 'Sem interesse',
  nao_contatar: 'Pediu para não ser contatado',
  virou_lead: 'Virou lead',
  nao_encontrado: 'Não encontrado no Google',
};

/** What the owner sets by hand on a saved prospect; `virou_lead` and `nao_encontrado` come from actions. */
export const PROSPECT_MANUAL_STATUSES = [
  'reservado',
  'contatado',
  'sem_interesse',
  'nao_contatar',
  'descartado',
] as const;

/** Statuses that hold the company for its owner: other sellers do not see it in a search. */
export const PROSPECT_HOLDING_STATUSES: readonly ProspectStatus[] = ['reservado', 'contatado'];

/** Google gives 20 per page and 3 pages at most (60 results) per search. */
export const PROSPECT_PAGE_SIZE = 20;
export const PROSPECT_SEARCH_MAX_PAGES = 3;
/** The most places one sweep (varredura por bairros) runs, one call each. */
export const PROSPECT_SCAN_MAX_PLACES = 20;

/** The site the data was read from, as stored next to each enriched value. */
export const PROSPECT_ENRICHMENT_SOURCE = 'site da empresa';

export const placeIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{10,300}$/, 'place_id inválido');

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

/**
 * One search. One place is a normal search (pages 2 and 3 by Google's token); more than one is a
 * sweep, which runs only with `confirmCalls` equal to the calls the screen showed the seller.
 */
export const prospectSearchSchema = z
  .object({
    segment: z.string().trim().min(2, 'Informe o segmento').max(80),
    places: z
      .array(z.string().trim().min(2).max(80))
      .min(1, 'Informe a cidade ou os bairros')
      .max(PROSPECT_SCAN_MAX_PLACES, `No máximo ${PROSPECT_SCAN_MAX_PLACES} locais por varredura`),
    minRating: z.number().min(0).max(5).nullable().default(null),
    minReviews: z.number().int().min(0).max(1_000_000).nullable().default(null),
    requireWebsite: z.boolean().default(false),
    /** Only companies Google shows a phone for (telefone comercial). */
    requirePhone: z.boolean().default(false),
    onlyOperational: z.boolean().default(true),
    pageToken: z.string().trim().min(1).max(2000).optional(),
    page: z.number().int().min(1).max(PROSPECT_SEARCH_MAX_PAGES).default(1),
    confirmCalls: z.number().int().min(1).optional(),
  })
  .refine((v) => v.page > 1 === Boolean(v.pageToken), {
    message: 'A página seguinte precisa do token da anterior',
    path: ['pageToken'],
  })
  .refine((v) => !v.pageToken || v.places.length === 1, {
    message: 'A varredura por bairros não tem página seguinte',
    path: ['pageToken'],
  });
export type ProspectSearchInput = z.infer<typeof prospectSearchSchema>;

/** The seller's sentence for the AI ("hamburguerias em Niterói com nota 4,5+"). */
export const prospectParseSchema = z.object({ text: z.string().trim().min(3).max(500) });

/** What the AI turns the sentence into: search parameters only, never Google content. */
export const prospectQuerySchema = z.object({
  segmento: z.string().trim().min(1).max(80),
  locais: z.array(z.string().trim().min(1).max(80)).max(PROSPECT_SCAN_MAX_PLACES),
  nota_min: z.number().min(0).max(5).nullable(),
  avaliacoes_min: z.number().int().min(0).nullable(),
  exige_site: z.boolean(),
});
export type ProspectQuery = z.infer<typeof prospectQuerySchema>;

/** The most results one batch reserves: one search's three pages. */
export const PROSPECT_BATCH_MAX = PROSPECT_PAGE_SIZE * PROSPECT_SEARCH_MAX_PAGES;

/** Reservar em lote: the results the seller reviewed and ticked, each reserved on its own. */
export const prospectBatchSchema = z.object({
  placeIds: z
    .array(placeIdSchema)
    .min(1, 'Selecione ao menos uma empresa')
    .max(PROSPECT_BATCH_MAX, `No máximo ${PROSPECT_BATCH_MAX} empresas por lote`)
    .refine((ids) => new Set(ids).size === ids.length, 'Empresa repetida no lote'),
});
export type ProspectBatchInput = z.infer<typeof prospectBatchSchema>;

/** Reservar or Descartar straight from a result; a discard needs its reason. */
export const prospectClaimSchema = z
  .object({
    placeId: placeIdSchema,
    action: z.enum(['reserve', 'discard']),
    reason: optionalText(300),
  })
  .refine((v) => v.action !== 'discard' || Boolean(v.reason), {
    message: 'Diga o motivo do descarte',
    path: ['reason'],
  });
export type ProspectClaimInput = z.infer<typeof prospectClaimSchema>;

/** A saved prospect: its status, notes, and (managers only) a new owner. */
export const prospectUpdateSchema = z
  .object({
    status: z.enum(PROSPECT_MANUAL_STATUSES).optional(),
    reason: optionalText(300),
    notes: optionalText(2000),
    ownerEmployeeId: z.uuid().optional(),
  })
  .refine((v) => v.status !== 'descartado' || Boolean(v.reason), {
    message: 'Diga o motivo do descarte',
    path: ['reason'],
  });
export type ProspectUpdateInput = z.infer<typeof prospectUpdateSchema>;

/** Enriquecer: the company's site as the live result showed it; the URL itself is never stored. */
export const prospectEnrichSchema = z.object({ website: z.url().max(2000) });

/**
 * Criar lead, after the first contact: what the company said, not what Google shows. Phone or
 * e-mail is required; `whatsappOptIn` is the answer to "aceitou receber WhatsApp?".
 */
export const prospectLeadSchema = z
  .object({
    companyName: z.string().trim().min(2, 'Informe a empresa').max(120),
    contactName: z.string().trim().min(2, 'Informe o contato').max(LEAD_NAME_MAX),
    contactRole: optionalText(80),
    phone: optionalText(30),
    email: optionalText(200),
    instagram: optionalText(200),
    notes: optionalText(2000),
    whatsappOptIn: z.boolean({ error: 'Diga se aceitou receber WhatsApp' }),
    stageId: z.uuid().optional().or(z.literal('')),
    /** The return the company agreed to: a follow-up task for the lead's owner. */
    followUpAt: z.iso.datetime({ offset: true }).optional().or(z.literal('')),
  })
  .refine((v) => Boolean(v.phone || v.email), {
    message: 'Informe o telefone ou o e-mail',
    path: ['phone'],
  });
export type ProspectLeadInput = z.infer<typeof prospectLeadSchema>;

/** The title of the follow-up task Criar lead opens when a return was agreed. */
export const PROSPECT_FOLLOW_UP_TITLE = 'Retorno combinado na prospecção';

/**
 * How the seller will approach the company. No WhatsApp: a prospecting company gets WhatsApp from
 * the system only after it said yes (`whatsappOptInMissing`), so the suggestion never plans one.
 */
export const PROSPECT_APPROACH_CHANNELS = ['ligacao', 'email', 'visita'] as const;
export type ProspectApproachChannel = (typeof PROSPECT_APPROACH_CHANNELS)[number];
export const PROSPECT_APPROACH_CHANNEL_LABELS: Record<ProspectApproachChannel, string> = {
  ligacao: 'Ligação',
  email: 'E-mail',
  visita: 'Visita',
};

/** One approach suggestion per person per day at most (each is one paid model call). */
export const PROSPECT_APPROACH_DAILY_MAX = 30;

/** Sentences turned into search parameters per person per day at most (each is one paid model call). */
export const PROSPECT_PARSE_DAILY_MAX = 60;

/**
 * Sugerir abordagem: what the seller tells the AI. Nothing of Google's goes with it; the segment is
 * what the seller typed in the search, the context is their own words.
 */
export const prospectApproachSchema = z.object({
  channel: z.enum(PROSPECT_APPROACH_CHANNELS),
  segment: optionalText(80),
  context: optionalText(500),
});
export type ProspectApproachInput = z.infer<typeof prospectApproachSchema>;

/** The model's answer, checked before it reaches the screen. */
export const prospectApproachAnswerSchema = z.object({
  abertura: z.string().trim().min(1).max(1200),
  pontos: z.array(z.string().trim().min(1).max(300)).min(1).max(5),
  proximo_passo: z.string().trim().min(1).max(300),
});

/** A suggestion, marked as the AI's: the seller reads, edits and uses it; nothing is sent. */
export interface ProspectApproach {
  origin: 'ia';
  channel: ProspectApproachChannel;
  opening: string;
  points: string[];
  nextStep: string;
}

// --- ICP score ----------------------------------------------------------------

export const ICP_WEIGHT_KEYS = [
  'rating45',
  'rating42',
  'reviews500',
  'reviews200',
  'reviews50',
  'website',
  'instagram',
  'multiUnit',
] as const;
export type IcpWeightKey = (typeof ICP_WEIGHT_KEYS)[number];
export type IcpWeights = Record<IcpWeightKey, number>;

export const ICP_WEIGHT_LABELS: Record<IcpWeightKey, string> = {
  rating45: 'Nota ≥ 4,5',
  rating42: 'Nota ≥ 4,2',
  reviews500: 'Avaliações ≥ 500',
  reviews200: 'Avaliações ≥ 200',
  reviews50: 'Avaliações ≥ 50',
  website: 'Tem site',
  instagram: 'Instagram achado no site',
  multiUnit: 'Mesmo nome em mais de um endereço',
};

export const DEFAULT_ICP_WEIGHTS: IcpWeights = {
  rating45: 2,
  rating42: 1,
  reviews500: 3,
  reviews200: 2,
  reviews50: 1,
  website: 1,
  instagram: 1,
  multiUnit: 2,
};

export const prospectingIcpSchema = z.object({
  weights: z.object(
    Object.fromEntries(ICP_WEIGHT_KEYS.map((k) => [k, z.number().int().min(0).max(10)])) as Record<
      IcpWeightKey,
      z.ZodNumber
    >,
  ),
  /** Big chains already franchised: a result whose name holds one of these is hidden. */
  excludedNames: z.array(z.string().trim().min(2).max(80)).max(300),
});
export type ProspectingIcp = z.infer<typeof prospectingIcpSchema>;

export interface IcpInput {
  rating: number | null;
  reviews: number | null;
  hasWebsite: boolean;
  hasInstagram: boolean;
  multiUnit: boolean;
}

/** The ICP score, computed on every answer and never stored; each reason is a weight that counted. */
export function icpScore(
  input: IcpInput,
  weights: IcpWeights = DEFAULT_ICP_WEIGHTS,
): { score: number; reasons: string[] } {
  const hits: IcpWeightKey[] = [];
  const rating = input.rating ?? 0;
  const reviews = input.reviews ?? 0;
  if (rating >= 4.5) hits.push('rating45');
  else if (rating >= 4.2) hits.push('rating42');
  if (reviews >= 500) hits.push('reviews500');
  else if (reviews >= 200) hits.push('reviews200');
  else if (reviews >= 50) hits.push('reviews50');
  if (input.hasWebsite) hits.push('website');
  if (input.hasInstagram) hits.push('instagram');
  if (input.multiUnit) hits.push('multiUnit');
  const counted = hits.filter((k) => weights[k] > 0);
  return {
    score: counted.reduce((sum, k) => sum + weights[k], 0),
    reasons: counted.map((k) => `${ICP_WEIGHT_LABELS[k]} (+${weights[k]})`),
  };
}

/** A name as compared: lower case, no accents, words separated by single spaces. */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when the name holds an excluded one as whole words ("Rede Exemplo Niterói" ← "rede exemplo"). */
export function excludedName(name: string, excluded: readonly string[]): boolean {
  const key = ` ${nameKey(name)} `;
  return excluded.some((entry) => {
    const word = nameKey(entry);
    return word.length > 0 && key.includes(` ${word} `);
  });
}

// --- quota --------------------------------------------------------------------

/** Each call to Google counts 1; the month stays inside Google's 1,000 free calls of each kind. */
export const DEFAULT_PROSPECTING_QUOTA = {
  perUserDaily: 40,
  monthlySearches: 950,
  monthlyDetails: 950,
} as const;

export const prospectingQuotaSchema = z.object({
  perUserDaily: z.number().int().min(0).max(1000),
  monthlySearches: z.number().int().min(0).max(1000, 'Acima de 1.000 o Google cobra'),
  monthlyDetails: z.number().int().min(0).max(1000, 'Acima de 1.000 o Google cobra'),
});
export type ProspectingQuota = z.infer<typeof prospectingQuotaSchema>;

export interface ProspectingUsage {
  today: { used: number; limit: number };
  month: { searches: number; searchLimit: number; details: number; detailsLimit: number };
}

// --- retention ----------------------------------------------------------------

/**
 * How long our own data is kept without an update: a reservation (and a contact) then goes back
 * to free as `descartado`, and what the company's site showed is cleared from a prospect that
 * did not become a lead. The enrichment's 180 days are a default still to be checked with the
 * lawyer (docs/crm/prospeccao.md).
 */
export const DEFAULT_PROSPECTING_RETENTION = {
  reservedDays: 30,
  contactedDays: 90,
  enrichmentDays: 180,
} as const;

const days = (min: number, max: number) =>
  z.number().int().min(min, `De ${min} a ${max} dias`).max(max, `De ${min} a ${max} dias`);

export const prospectingRetentionSchema = z.object({
  reservedDays: days(7, 365),
  contactedDays: days(7, 365),
  enrichmentDays: days(30, 730),
});
export type ProspectingRetention = z.infer<typeof prospectingRetentionSchema>;

const DAY_MS = 86_400_000;

/** When a held prospect goes back to free if nobody touches it; null for a status that holds nothing. */
export function reservationExpiresAt(
  prospect: { status: ProspectStatus; updatedAt: string },
  retention: ProspectingRetention,
): Date | null {
  const holdDays =
    prospect.status === 'reservado'
      ? retention.reservedDays
      : prospect.status === 'contatado'
        ? retention.contactedDays
        : null;
  return holdDays === null ? null : new Date(Date.parse(prospect.updatedAt) + holdDays * DAY_MS);
}

export interface ProspectingSettings {
  icp: ProspectingIcp;
  quota: ProspectingQuota;
  retention: ProspectingRetention;
  updatedAt: string | null;
}

// --- answers ------------------------------------------------------------------

/** A place as Google answered it, for this response only. */
export interface PlaceResult {
  placeId: string;
  name: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  rating: number | null;
  reviews: number | null;
  businessStatus: string | null;
  mapsUri: string | null;
  types: string[];
}

export type ProspectTagKind =
  | 'lead'
  | 'client'
  | 'reserved'
  | 'discarded'
  | 'do_not_contact'
  | 'multi_unit'
  | 'possible_duplicate'
  | 'status';

export interface ProspectTag {
  kind: ProspectTagKind;
  text: string;
}

/** The saved prospect behind a result, when there is one. */
export interface ProspectRef {
  id: string;
  status: ProspectStatus;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  mine: boolean;
}

/** What Google did not give for a result: the record is incomplete there. */
export const PROSPECT_MISSING_FIELDS = ['phone', 'website', 'address', 'rating'] as const;
export type ProspectMissingField = (typeof PROSPECT_MISSING_FIELDS)[number];
export const PROSPECT_MISSING_LABELS: Record<ProspectMissingField, string> = {
  phone: 'sem telefone',
  website: 'sem site',
  address: 'sem endereço',
  rating: 'sem nota',
};

export function missingFields(place: PlaceResult): ProspectMissingField[] {
  const present: Record<ProspectMissingField, boolean> = {
    phone: Boolean(place.phone),
    website: Boolean(place.website),
    address: Boolean(place.address),
    rating: place.rating !== null,
  };
  return PROSPECT_MISSING_FIELDS.filter((field) => !present[field]);
}

/**
 * Hosts that are not the company's own site (a profile, a link page, a delivery app): two
 * companies "sharing" one of these are not the same company, so it never marks a duplicate.
 */
const SHARED_HOSTS = [
  'instagram.com',
  'facebook.com',
  'fb.com',
  'linktr.ee',
  'wa.me',
  'whatsapp.com',
  'linkedin.com',
  'google.com',
  'business.site',
  'ifood.com.br',
  'goo.gl',
  'bit.ly',
  'tiktok.com',
  'youtube.com',
];

/** The company's own domain ("hamburgueria.com.br"), lower case without www; null for no site or a shared host. */
export function siteDomain(url: string | null | undefined): string | null {
  // No URL class here (the shared package runs without DOM or Node types): the host by hand.
  const host = (url ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/?#]*@/, '')
    .split(/[/?#:]/)[0]!
    .replace(/^www\./, '')
    .replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return SHARED_HOSTS.some((shared) => host === shared || host.endsWith(`.${shared}`))
    ? null
    : host;
}

export interface ProspectSearchItem extends PlaceResult {
  icp: { score: number; reasons: string[] };
  /** Fields Google did not give: an incomplete record, flagged, never filled in. */
  missing: ProspectMissingField[];
  tags: ProspectTag[];
  prospect: ProspectRef | null;
  /** The lead with this place_id or this phone, when the seller may open it. */
  leadId: string | null;
}

export interface ProspectSearchResponse {
  items: ProspectSearchItem[];
  /** For a one-place search: the token of the next page, null at the last one or on page 3. */
  nextPageToken: string | null;
  page: number;
  callsSpent: number;
  /** Results left out, so the list never reads as all Google had. */
  hidden: { excluded: number; filtered: number; heldByOthers: number; repeated: number };
  /** In a sweep, the places Google did not answer (their calls still count): the list is partial. */
  failedPlaces: { place: string; code: PlacesErrorCode }[];
  usage: ProspectingUsage;
}

export type PlacesErrorCode =
  'timeout' | 'unavailable' | 'key_invalid' | 'quota_exceeded' | 'bad_request' | 'not_found';

/** Why a place did not answer, as the screen says it. */
export const PLACES_ERROR_LABELS: Record<PlacesErrorCode, string> = {
  timeout: 'o Google demorou demais',
  unavailable: 'o Google não respondeu',
  key_invalid: 'o Google recusou a chave',
  quota_exceeded: 'limite de uso do Google',
  bad_request: 'pedido recusado pelo Google',
  not_found: 'não encontrado no Google',
};

export interface ProspectEnrichedValue {
  value: string;
  source: string;
  at: string;
}
export const PROSPECT_ENRICHMENT_KEYS = [
  'instagram',
  'facebook',
  'linkedin',
  'whatsapp',
  'email',
] as const;
export type ProspectEnrichmentKey = (typeof PROSPECT_ENRICHMENT_KEYS)[number];
export type ProspectEnrichment = Partial<Record<ProspectEnrichmentKey, ProspectEnrichedValue>>;

/** A saved prospect: our own data only. The name and contacts come live from the ficha. */
export interface Prospect {
  id: string;
  placeId: string;
  status: ProspectStatus;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  mine: boolean;
  reason: string | null;
  notes: string | null;
  enrichment: ProspectEnrichment;
  leadId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One result of a batch reservation: reserved, or why not, in the seller's words. */
export type ProspectBatchResult =
  | { placeId: string; ok: true; prospect: Prospect }
  | { placeId: string; ok: false; error: string; message: string };

export interface ProspectBatchResponse {
  results: ProspectBatchResult[];
  reserved: number;
  refused: number;
}

/** One past search, from the calls reserved for it: what the seller typed, never what Google answered. */
export interface ProspectSearchHistoryItem {
  id: string;
  at: string;
  employeeName: string | null;
  mine: boolean;
  segment: string | null;
  places: string[];
  calls: number;
}

/** Prospecção in numbers, per owner: our prospects by status and the calls to Google this month. */
export interface ProspectingOwnerMetrics {
  employeeId: string | null;
  name: string | null;
  byStatus: Partial<Record<ProspectStatus, number>>;
  total: number;
  callsThisMonth: number;
}

export interface ProspectingMetrics {
  owners: ProspectingOwnerMetrics[];
  byStatus: Partial<Record<ProspectStatus, number>>;
  total: number;
  /** Converted (virou_lead) over every saved prospect; null with none saved. */
  conversionRate: number | null;
  callsThisMonth: number;
}

export type ProspectPlaceResponse =
  | { found: true; place: PlaceResult; usage: ProspectingUsage }
  | { found: false; message: string; usage: ProspectingUsage };

export interface ProspectEnrichResponse {
  prospect: Prospect;
  /** Pages actually read (robots.txt allowing), at most 2. */
  pagesRead: number;
  /** Why a page was not read, in Portuguese, when one was not. */
  skipped: string[];
}

// --- WhatsApp opt-in ----------------------------------------------------------

export const WHATSAPP_OPT_IN_MISSING_TEXT =
  'Sem aceite de WhatsApp registrado: este lead veio da prospecção. Use o telefone comercial ou o e-mail.';

/**
 * A prospecting lead gets WhatsApp from the company number only with the opt-in on record
 * (WhatsApp Business policy): `consent` basis, set when the company said yes in the first contact.
 * A deal that Criar lead merged into keeps its source, so the answer recorded there
 * (`consentSource` 'prospeccao') counts too.
 */
export function whatsappOptInMissing(lead: {
  source: string;
  legalBasis: string | null;
  consentSource: string | null;
}): boolean {
  return (
    (lead.source === 'google_places' || lead.consentSource === 'prospeccao') &&
    lead.legalBasis !== 'consent'
  );
}
