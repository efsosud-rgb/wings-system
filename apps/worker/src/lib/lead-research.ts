import {
  WEB_RESEARCH_FIELD_KEYS,
  estimateAgentCostMicroUsd,
  formatCnpj,
  isValidCnpj,
  normalizeCnpj,
  normalizeInstagram,
  normalizeWebsite,
  type AgentModel,
  type WebResearchField,
  type WebResearchFieldKey,
  type WebResearchSource,
} from '@wings/shared';
import {
  shapeOf,
  type LeadResearchFinding,
  type LeadResearchInput,
  type LeadResearchProvider,
  type ShapeLogger,
} from './enrichment.js';

/**
 * Company research for a lead that just arrived: OpenRouter, with its web
 * search plugin limited to 5 results, asked to summarise only what those pages
 * say about the COMPANY. Same account as the traffic agent (`OPENROUTER_API_KEY`),
 * asked with `data_collection: deny` so OpenRouter routes only to providers that
 * neither store nor train on the prompt.
 *
 * What leaves the server: the company name, site, Instagram and CNPJ, in that
 * order, and nothing else (`researchInputOf`, `promptOf`). What comes back is
 * kept only when a page backs it: the sources are the pages the search returned
 * (the response's `url_citation` annotations), never links the model wrote, and
 * with no source at all every value is dropped. A value the search did not bring
 * is null with the reason, never filled in.
 *
 * NOT verified live: the web plugin's answer (`annotations` with `url_citation`)
 * and `usage.cost` follow OpenRouter's reference; the shape log
 * (`worker: enrich_lead`, `msg: lead research`) is where the real format gets
 * checked on the first run.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** The limit the web search is asked for, per research. */
export const RESEARCH_MAX_RESULTS = 5;
/** OpenRouter's web plugin charges per result (US$ 4 per 1,000, Exa); the fallback when no cost is reported. */
const WEB_USD_MICRO_PER_RESULT = 4000;
const MAX_OUTPUT_TOKENS = 900;
const VALUE_MAX_CHARS = 240;
const REASON_MAX_CHARS = 160;

// --- what may be sent ------------------------------------------------------------------------

/** An e-mail, or a phone with a country/area code, or a run of 8+ digits: a person's contact, not a company's name. */
const CONTACT_LIKE = /@|(?:\+?\d{2}\s?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}|\d{8,}/;

/**
 * The four company fields a lead form may have filled, cleaned. A value that
 * looks like a person's contact (an e-mail or phone typed into the company
 * name) is dropped, and the site is cut to its address (no path, no query).
 * Null when nothing usable is left: then there is nothing to search.
 */
export function researchInputOf(
  leadId: string,
  row: {
    company_name?: string | null;
    website?: string | null;
    instagram?: string | null;
    company_cnpj?: string | null;
  },
): LeadResearchInput | null {
  const name = (row.company_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const companyName = name.length >= 2 && !CONTACT_LIKE.test(name) ? name : null;

  const normalisedSite = row.website ? normalizeWebsite(row.website) : null;
  const website = normalisedSite ? `${new URL(normalisedSite).origin}/` : null;

  const instagram = row.instagram ? normalizeInstagram(row.instagram) : null;

  const rawCnpj = row.company_cnpj ? normalizeCnpj(row.company_cnpj) : '';
  const cnpj = rawCnpj && isValidCnpj(rawCnpj) ? formatCnpj(rawCnpj) : null;

  if (!companyName && !website && !instagram && !cnpj) return null;
  return { leadId, companyName, website, instagram, cnpj };
}

const SYSTEM_PROMPT = [
  'Você pesquisa UMA empresa brasileira na web para o time comercial de uma franqueadora.',
  'Use somente o que as páginas encontradas dizem sobre a empresa. Nunca invente nem complete com o que você supõe.',
  'Se um dado não aparece nas páginas, devolva null para ele e diga em poucas palavras o motivo.',
  'Não escreva nomes de pessoas, telefones, e-mails nem CPF, mesmo que apareçam nas páginas.',
  `Responda somente com um objeto JSON, sem texto fora dele, com estas chaves: ${WEB_RESEARCH_FIELD_KEYS.join(', ')}.`,
  `Cada chave é {"value": texto de até ${VALUE_MAX_CHARS} caracteres em português do Brasil, ou null, "reason": motivo curto quando value é null, senão null}.`,
  'activity = o que a empresa faz; location = cidade e estado; size = porte (funcionários, unidades, faturamento, se as páginas disserem);',
  'time_in_market = desde quando atua; online_presence = o que as páginas mostram do site e do Instagram da empresa.',
].join('\n');

/** The only text about the lead that is sent: the company's fields, one per line. */
export function promptOf(input: LeadResearchInput): string {
  const lines = [
    input.companyName ? `Empresa: ${input.companyName}` : null,
    input.website ? `Site: ${input.website}` : null,
    input.instagram ? `Instagram: @${input.instagram}` : null,
    input.cnpj ? `CNPJ: ${input.cnpj}` : null,
  ].filter((line): line is string => line !== null);
  return `Pesquise esta empresa.\n${lines.join('\n')}`;
}

// --- what comes back ---------------------------------------------------------------------------

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?<!\d)(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\d)/g;
const CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;

/** A company's CNPJ may stay; an e-mail, a phone or a CPF the page happened to show never does. */
export function scrubResearchText(text: string): string {
  return text
    .replace(EMAIL, '[e-mail removido]')
    .replace(CPF, '[documento removido]')
    .replace(PHONE, '[telefone removido]');
}

const asText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = scrubResearchText(value).replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text.slice(0, max) : null;
};

/** Public http(s) pages only: no credentials in the address, no fragment. */
function sourceUrlOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || !url.hostname.includes('.')) return null;
  url.hash = '';
  return url.toString();
}

/** The pages the search returned (the `url_citation` annotations), deduplicated, at most `RESEARCH_MAX_RESULTS`. */
export function sourcesOf(annotations: unknown): WebResearchSource[] {
  const sources: WebResearchSource[] = [];
  for (const item of Array.isArray(annotations) ? annotations : []) {
    const citation =
      (item as { type?: unknown; url_citation?: { url?: unknown; title?: unknown } } | null) ?? {};
    if (citation.type !== 'url_citation') continue;
    const url = sourceUrlOf(citation.url_citation?.url);
    if (!url || sources.some((source) => source.url === url)) continue;
    sources.push({ url, title: asText(citation.url_citation?.title, 120) });
    if (sources.length >= RESEARCH_MAX_RESULTS) break;
  }
  return sources;
}

const NO_SOURCE = 'A busca não trouxe páginas para confirmar';
const NOT_SAID = 'As páginas encontradas não dizem isso';

/**
 * The model's text -> the five fields. Tolerant of text around the JSON; any
 * key it left out, or answered badly, is null with a reason. With no source,
 * nothing it said is kept.
 */
export function fieldsOf(content: unknown, hasSources: boolean): WebResearchField[] {
  let parsed: Record<string, unknown> = {};
  if (typeof content === 'string') {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const value: unknown = JSON.parse(content.slice(start, end + 1));
        if (value && typeof value === 'object' && !Array.isArray(value))
          parsed = value as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }
  }
  return WEB_RESEARCH_FIELD_KEYS.map((key: WebResearchFieldKey): WebResearchField => {
    if (!hasSources) return { key, value: null, reason: NO_SOURCE };
    const raw = parsed[key];
    const entry =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { value?: unknown; reason?: unknown })
        : { value: raw, reason: null };
    const value = asText(entry.value, VALUE_MAX_CHARS);
    if (value) return { key, value, reason: null };
    return { key, value: null, reason: asText(entry.reason, REASON_MAX_CHARS) ?? NOT_SAID };
  });
}

// --- the provider --------------------------------------------------------------------------------

interface OpenRouterAnswer {
  error?: unknown;
  choices?: { message?: { content?: unknown; annotations?: unknown } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
}

export function createOpenRouterResearch(config: {
  apiKey: string;
  model: AgentModel;
  /** What one call is expected to cost, in US dollars; reserved before the call. */
  reserveUsd: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: ShapeLogger;
}): LeadResearchProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    name: 'openrouter',
    reserveUsdMicro: Math.round(config.reserveUsd * 1_000_000),
    async research(input) {
      let response: Response;
      try {
        response = await fetchImpl(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'Wings System',
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0,
            // Reports tokens and the real cost of this call.
            usage: { include: true },
            // Only providers that neither store nor train on the prompt.
            provider: { data_collection: 'deny' },
            plugins: [{ id: 'web', max_results: RESEARCH_MAX_RESULTS }],
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: promptOf(input) },
            ],
          }),
          signal: AbortSignal.timeout(config.timeoutMs ?? 90_000),
        });
      } catch (error) {
        // Never the error's own text: it can quote the request, headers included.
        throw new Error(
          `OpenRouter did not answer (${error instanceof Error ? error.name : 'unknown'})`,
          { cause: error },
        );
      }
      if (!response.ok) throw new Error(`OpenRouter answered ${response.status}`);
      let body: OpenRouterAnswer;
      try {
        body = (await response.json()) as OpenRouterAnswer;
      } catch (error) {
        // The cause stays in memory; only the message above ever reaches the ledger or a log.
        throw new Error('OpenRouter answered with something that is not JSON', { cause: error });
      }
      // Key names and numbers only: the answer is about a company and quotes pages.
      config.log?.({ msg: 'lead research', model: config.model, shape: shapeOf(body) });
      if (body.error) throw new Error('OpenRouter reported an error');

      const message = body.choices?.[0]?.message;
      const sources = sourcesOf(message?.annotations);
      const fields = fieldsOf(message?.content, sources.length > 0);

      const reported =
        typeof body.usage?.cost === 'number' && body.usage.cost >= 0 ? body.usage.cost : null;
      const tokens = body.usage?.prompt_tokens;
      const out = body.usage?.completion_tokens;
      const costUsdMicro =
        reported !== null
          ? Math.round(reported * 1_000_000)
          : typeof tokens === 'number' && typeof out === 'number'
            ? estimateAgentCostMicroUsd(config.model, tokens, out) +
              sources.length * WEB_USD_MICRO_PER_RESULT
            : Math.round(config.reserveUsd * 1_000_000);
      return { fields, sources, model: config.model, costUsdMicro } satisfies LeadResearchFinding;
    },
  };
}

/** Null (the step is skipped) unless it is switched on AND the OpenRouter key is there. */
export function createLeadResearchProvider(config: {
  enabled: boolean;
  apiKey?: string;
  model: AgentModel;
  reserveUsd: number;
  fetchImpl?: typeof fetch;
  log?: ShapeLogger;
}): LeadResearchProvider | null {
  if (!config.enabled || !config.apiKey) return null;
  return createOpenRouterResearch({ ...config, apiKey: config.apiKey });
}
