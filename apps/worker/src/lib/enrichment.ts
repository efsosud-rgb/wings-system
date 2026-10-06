import type { WebResearchField, WebResearchSource } from '@wings/shared';
import type { Pool } from '../db/client.js';

/**
 * The outside services the `enrich_lead` job talks to, behind interfaces so
 * the job can be tested with fakes and no test ever reaches the network.
 *
 *  - Z-API: the WhatsApp profile (name and photo) of a number. Free.
 *  - Web search: LinkedIn / Instagram of "name + city". PAID per query.
 *  - BrasilAPI: a CNPJ's public record at the Receita. Free, no key.
 *
 * Every answer is logged as a shape (key names and numbers), never as text:
 * these calls carry a person's name.
 *
 * NOT verified live: Z-API's profile endpoints and Brave's response follow
 * their published references; BrasilAPI's CNPJ fields likewise. The shape
 * log is where the real formats get checked on the first run.
 */

export interface ZapiProfile {
  profileName: string | null;
  photoUrl: string | null;
}

export interface ZapiProfileClient {
  profileOf(phone: string): Promise<ZapiProfile>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearch {
  search(query: string): Promise<SearchResult[]>;
}

export interface CnpjRecord {
  cnpj: string;
  legalName: string;
  tradeName: string | null;
  capitalSocialBrl: number | null;
  openedAt: string | null;
  mainActivity: string | null;
  size: string | null;
  city: string | null;
  uf: string | null;
  status: string | null;
  partners: string[];
}

export interface CnpjLookup {
  /** Null when the Receita has no such CNPJ. */
  lookup(cnpj: string): Promise<CnpjRecord | null>;
}

export type ShapeLogger = (facts: Record<string, unknown>) => void;

/** Key names and numbers only; every string becomes its length. */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return `string(${value.length})`;
  if (depth >= 6) return '…';
  if (Array.isArray(value)) return { arrayOf: value.length, first: value.slice(0, 2).map((v) => shapeOf(v, depth + 1)) };
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return typeof value;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

function parseJsonOrEmpty(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// --- Z-API -------------------------------------------------------------------------

export function createZapiProfileClient(config: {
  instanceId: string;
  instanceToken: string;
  clientToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: ShapeLogger;
}): ZapiProfileClient {
  const base = `${config.baseUrl ?? 'https://api.z-api.io'}/instances/${config.instanceId}/token/${config.instanceToken}`;
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeout = config.timeoutMs ?? 10_000;
  async function get(path: string): Promise<unknown> {
    // Instance id and token sit in the path (Z-API's design): the URL is a secret and is never logged.
    const response = await fetchImpl(`${base}${path}`, {
      headers: { 'Client-Token': config.clientToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Z-API answered ${response.status}`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }
  return {
    async profileOf(phone) {
      const [picture, contact] = await Promise.allSettled([
        get(`/profile-picture?phone=${encodeURIComponent(phone)}`),
        get(`/contacts/${encodeURIComponent(phone)}`),
      ]);
      const pictureBody = picture.status === 'fulfilled' ? (picture.value as Record<string, unknown>) : {};
      const contactBody = contact.status === 'fulfilled' ? (contact.value as Record<string, unknown>) : {};
      config.log?.({ msg: 'zapi profile', picture: shapeOf(pictureBody), contact: shapeOf(contactBody) });
      if (picture.status === 'rejected' && contact.status === 'rejected') {
        throw new Error('Z-API answered neither the picture nor the contact');
      }
      return {
        photoUrl: asString(pictureBody.link) ?? asString(pictureBody.imgUrl) ?? asString(contactBody.imgUrl),
        profileName: asString(contactBody.name) ?? asString(contactBody.vname) ?? asString(contactBody.short),
      };
    },
  };
}

// --- Brave Search -------------------------------------------------------------------

export function createBraveSearch(config: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: ShapeLogger;
}): WebSearch {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    async search(query) {
      const url = new URL(`${config.baseUrl ?? 'https://api.search.brave.com'}/res/v1/web/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('count', '10');
      url.searchParams.set('country', 'BR');
      url.searchParams.set('search_lang', 'pt-br');
      const response = await fetchImpl(url, {
        headers: { 'X-Subscription-Token': config.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Brave Search answered ${response.status}`);
      const body = parseJsonOrEmpty(text);
      config.log?.({ msg: 'brave search', shape: shapeOf(body) });
      const results = ((body as { web?: { results?: unknown } }).web?.results ?? []) as Record<string, unknown>[];
      return (Array.isArray(results) ? results : [])
        .map((result) => ({
          title: asString(result.title) ?? '',
          url: asString(result.url) ?? '',
          snippet: asString(result.description) ?? '',
        }))
        .filter((result) => result.url.length > 0);
    },
  };
}

// --- BrasilAPI ------------------------------------------------------------------------

export function createBrasilApi(config: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: ShapeLogger;
}): CnpjLookup {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    async lookup(cnpj) {
      const digits = cnpj.replace(/\D/g, '');
      const response = await fetchImpl(`${config.baseUrl ?? 'https://brasilapi.com.br'}/api/cnpj/v1/${digits}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      });
      const text = await response.text();
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`BrasilAPI answered ${response.status}`);
      const body = parseJsonOrEmpty(text) as Record<string, unknown>;
      config.log?.({ msg: 'brasilapi cnpj', shape: shapeOf(body) });
      const qsa = Array.isArray(body.qsa) ? (body.qsa as Record<string, unknown>[]) : [];
      const capital = typeof body.capital_social === 'number' ? body.capital_social : Number(body.capital_social);
      return {
        cnpj: formatCnpj(digits),
        legalName: asString(body.razao_social) ?? '',
        tradeName: asString(body.nome_fantasia),
        capitalSocialBrl: Number.isFinite(capital) ? capital : null,
        openedAt: asString(body.data_inicio_atividade),
        mainActivity: asString(body.cnae_fiscal_descricao),
        size: asString(body.porte),
        city: asString(body.municipio),
        uf: asString(body.uf),
        status: asString(body.descricao_situacao_cadastral),
        partners: qsa.map((partner) => asString(partner.nome_socio)).filter((name): name is string => name !== null),
      };
    },
  };
}

export function formatCnpj(digits: string): string {
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

// --- the daily ceiling and the ledger ----------------------------------------------------

export interface EnrichmentBudget {
  dailyUsd: number;
  searchUsdPerQuery: number;
  /** The company research has its own ceiling (LEAD_RESEARCH_DAILY_USD), apart from `dailyUsd`. */
  researchDailyUsd: number;
}

export type LedgerStep = 'zapi_profile' | 'web_search' | 'brasilapi_cnpj' | 'ai_research';
export type LedgerStatus = 'started' | 'done' | 'failed' | 'skipped' | 'refused';

/** 00:00 of today in São Paulo (UTC-3, no DST since 2019). */
export function saoPauloDayStart(now: Date): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  return new Date(`${day}T03:00:00Z`);
}

export async function spentTodayUsdMicro(pool: Pool, now: Date): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `select coalesce(sum(usd_micro), 0)::bigint as total from lead_enrichment_ledger where created_at >= $1`,
    [saoPauloDayStart(now)],
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function writeLedger(
  pool: Pool,
  row: { leadId: string; jobId: string; step: LedgerStep; status: LedgerStatus; usdMicro: number; detail?: Record<string, unknown> },
): Promise<void> {
  await pool.query(
    `insert into lead_enrichment_ledger (lead_id, job_id, step, status, usd_micro, detail) values ($1, $2, $3, $4, $5, $6)`,
    [row.leadId, row.jobId, row.step, row.status, row.usdMicro, JSON.stringify(row.detail ?? {})],
  );
}

/**
 * Reserves the cost of one paid call under a lock: today's spend plus this
 * call must fit in the ceiling, and the ledger row is written BEFORE the
 * call, so two workers cannot both slip under the cap. Returns false (and a
 * `refused` row) when the ceiling is reached.
 */
export async function reserveSpend(
  pool: Pool,
  input: {
    leadId: string;
    jobId: string;
    step: LedgerStep;
    usdMicro: number;
    dailyUsd: number;
    now: Date;
    detail?: Record<string, unknown>;
  },
): Promise<boolean> {
  // Two ceilings, two sums: the company research (`ai_research`) counts only against its own,
  // and the searches and lookups count only against ENRICH_DAILY_USD.
  const research = input.step === 'ai_research';
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext('lead_enrichment_budget'))`);
    const spent = await client.query<{ total: string }>(
      `select coalesce(sum(usd_micro), 0)::bigint as total from lead_enrichment_ledger
        where created_at >= $1 and (step = 'ai_research') = $2`,
      [saoPauloDayStart(input.now), research],
    );
    const total = Number(spent.rows[0]?.total ?? 0);
    const ceiling = Math.round(input.dailyUsd * 1_000_000);
    const fits = total + input.usdMicro <= ceiling;
    await client.query(
      `insert into lead_enrichment_ledger (lead_id, job_id, step, status, usd_micro, detail) values ($1, $2, $3, $4, $5, $6)`,
      [
        input.leadId,
        input.jobId,
        input.step,
        fits ? 'started' : 'refused',
        fits ? input.usdMicro : 0,
        JSON.stringify({ ...(input.detail ?? {}), spentTodayUsdMicro: total, ceilingUsdMicro: ceiling }),
      ],
    );
    await client.query('commit');
    return fits;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// --- company research provider (OpenRouter: `lib/lead-research.ts`) -------------------------

/**
 * What the research may be told about a lead: the COMPANY's name, site,
 * Instagram and CNPJ, nothing else. There is no field for a person's name,
 * phone, e-mail or CPF, so none can be sent by mistake (`researchInputOf`
 * also drops a value that looks like one).
 */
export interface LeadResearchInput {
  leadId: string;
  companyName: string | null;
  website: string | null;
  instagram: string | null;
  cnpj: string | null;
}

export interface LeadResearchFinding {
  /** One entry per `WEB_RESEARCH_FIELD_KEYS`; a value is null, with the reason, when the sources did not say. */
  fields: WebResearchField[];
  /** The pages the search returned (never links the model wrote). */
  sources: WebResearchSource[];
  model: string;
  /** What the call cost, as the provider reported it (or an estimate), in millionths of a dollar. */
  costUsdMicro: number;
}

export interface LeadResearchProvider {
  readonly name: string;
  /** What one call is expected to cost: reserved under the ceiling before the call is made. */
  readonly reserveUsdMicro: number;
  /** One attempt, never retried: the call is paid even when its answer is useless. */
  research(input: LeadResearchInput): Promise<LeadResearchFinding>;
}
