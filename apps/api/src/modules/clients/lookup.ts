import {
  EMPTY_ADDRESS,
  normalizeCep,
  normalizeCnpj,
  type BrazilUf,
  type ClientAddress,
  type ClientCompany,
  type TaxRegime,
  BRAZIL_UFS,
} from '@wings/shared';
import type { FastifyBaseLogger } from 'fastify';
import { shapeOf } from '../media/kairogen-adapter.js';

/**
 * The public registries the client record is filled from: the Receita's CNPJ
 * data (BrasilAPI, then ReceitaWS) and addresses by CEP (BrasilAPI v2, then
 * ViaCEP). Every answer only pre-fills the form; nothing is stored until a
 * person saves. Formats checked against the real services on 2026-09-24.
 *
 * Nothing here logs a CNPJ, a CEP or any value from an answer: a failure is
 * logged as the supplier, the status and `shapeOf` the body.
 */

export type LookupFailure = 'not_found' | 'unavailable';
export type LookupResult<T> = { ok: true; value: T } | { ok: false; reason: LookupFailure };

export interface CnpjLookup {
  source: 'brasilapi' | 'receitaws';
  /** "ATIVA", "BAIXADA"… as the Receita writes it. */
  registrationStatus: string | null;
  company: Partial<ClientCompany>;
  /** The Receita's partner list (QSA): names and roles only, never a CPF. */
  partners: { name: string; role: string | null }[];
}

export interface CepLookup {
  source: 'brasilapi' | 'viacep';
  address: ClientAddress;
}

const TIMEOUT_MS = 8_000;
const CACHE_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;

type Json = Record<string, unknown>;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const uf = (value: unknown): BrazilUf | null => {
  const text = str(value)?.toUpperCase();
  return text && (BRAZIL_UFS as readonly string[]).includes(text) ? (text as BrazilUf) : null;
};

/** 9430800 -> 9430-8/00 */
export const formatCnae = (code: unknown, description?: unknown): string | null => {
  const digits = String(code ?? '').replace(/\D/g, '');
  if (digits.length !== 7) return null;
  const label = `${digits.slice(0, 4)}-${digits.slice(4, 5)}/${digits.slice(5)}`;
  const text = str(description);
  return text ? `${label} ${text}` : label;
};

const phoneDigits = (value: unknown): string | null => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return /^\d{10,11}$/.test(digits) ? digits : null;
};

/** The Receita's "forma de tributação" of the latest year, and the Simples/MEI options. */
function taxRegimeOf(body: Json): TaxRegime | null {
  if (body.opcao_pelo_mei === true) return 'mei';
  if (body.opcao_pelo_simples === true) return 'simples_nacional';
  const years = Array.isArray(body.regime_tributario) ? (body.regime_tributario as Json[]) : [];
  const latest = [...years].sort((a, b) => Number(b.ano ?? 0) - Number(a.ano ?? 0))[0];
  const form = str(latest?.forma_de_tributacao)?.toUpperCase() ?? '';
  if (form.includes('PRESUMIDO')) return 'lucro_presumido';
  if (form.includes('REAL')) return 'lucro_real';
  if (form.includes('IMUNE') || form.includes('ISENT')) return 'imune_isenta';
  if (form.includes('SIMPLES')) return 'simples_nacional';
  return null;
}

/** 3999 -> 399-9 */
const legalNatureCode = (code: unknown) => {
  const digits = String(code ?? '').replace(/\D/g, '');
  return digits.length === 4 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : null;
};

export function fromBrasilApiCnpj(body: Json): CnpjLookup {
  const street = [str(body.descricao_tipo_de_logradouro), str(body.logradouro)]
    .filter(Boolean)
    .join(' ');
  const nature = str(body.natureza_juridica);
  const natureCode = legalNatureCode(body.codigo_natureza_juridica);
  const secondary = Array.isArray(body.cnaes_secundarios) ? (body.cnaes_secundarios as Json[]) : [];
  const partners = Array.isArray(body.qsa) ? (body.qsa as Json[]) : [];
  const capital = typeof body.capital_social === 'number' ? body.capital_social : null;
  return {
    source: 'brasilapi',
    registrationStatus: str(body.descricao_situacao_cadastral),
    company: {
      legalName: str(body.razao_social),
      tradeName: str(body.nome_fantasia),
      cnpj: normalizeCnpj(String(body.cnpj ?? '')) || null,
      openedOn: str(body.data_inicio_atividade),
      legalNature: nature && natureCode ? `${natureCode} - ${nature}` : nature,
      taxRegime: taxRegimeOf(body),
      cnaeMain: formatCnae(body.cnae_fiscal, body.cnae_fiscal_descricao),
      cnaeSecondary: secondary
        .map((item) => formatCnae(item.codigo, item.descricao))
        .filter((item): item is string => item !== null),
      shareCapitalCents: capital !== null && capital > 0 ? Math.round(capital * 100) : null,
      address: {
        cep: normalizeCep(String(body.cep ?? '')) || null,
        street: street || null,
        number: str(body.numero),
        complement: str(body.complemento),
        district: str(body.bairro),
        city: str(body.municipio),
        state: uf(body.uf),
      },
      phone: phoneDigits(body.ddd_telefone_1),
      email: str(body.email)?.toLowerCase() ?? null,
    },
    partners: partners
      .map((item) => ({ name: str(item.nome_socio), role: str(item.qualificacao_socio) }))
      .filter((item): item is { name: string; role: string | null } => item.name !== null),
  };
}

/** dd/mm/yyyy -> yyyy-mm-dd */
const isoDay = (value: unknown) => {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(str(value) ?? '');
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
};

export function fromReceitaWsCnpj(body: Json): CnpjLookup {
  const main = Array.isArray(body.atividade_principal)
    ? (body.atividade_principal as Json[])[0]
    : undefined;
  const secondary = Array.isArray(body.atividades_secundarias)
    ? (body.atividades_secundarias as Json[])
    : [];
  const partners = Array.isArray(body.qsa) ? (body.qsa as Json[]) : [];
  const capital = Number.parseFloat(String(body.capital_social ?? ''));
  const cnae = (item: Json | undefined) => (item ? formatCnae(item.code, item.text) : null);
  const simples = (body.simples as Json | undefined)?.optante === true;
  const mei = (body.simei as Json | undefined)?.optante === true;
  return {
    source: 'receitaws',
    registrationStatus: str(body.situacao),
    company: {
      legalName: str(body.nome),
      tradeName: str(body.fantasia),
      cnpj: normalizeCnpj(String(body.cnpj ?? '')) || null,
      openedOn: isoDay(body.abertura),
      legalNature: str(body.natureza_juridica),
      taxRegime: mei ? 'mei' : simples ? 'simples_nacional' : null,
      cnaeMain: cnae(main),
      cnaeSecondary: secondary.map(cnae).filter((item): item is string => item !== null),
      shareCapitalCents: Number.isFinite(capital) && capital > 0 ? Math.round(capital * 100) : null,
      address: {
        cep: normalizeCep(String(body.cep ?? '')) || null,
        street: str(body.logradouro),
        number: str(body.numero),
        complement: str(body.complemento),
        district: str(body.bairro),
        city: str(body.municipio),
        state: uf(body.uf),
      },
      phone: phoneDigits(String(body.telefone ?? '').split('/')[0]),
      email: str(body.email)?.toLowerCase() ?? null,
    },
    partners: partners
      .map((item) => ({
        name: str(item.nome),
        role: str(item.qual)?.replace(/^\d+-/, '') ?? null,
      }))
      .filter((item): item is { name: string; role: string | null } => item.name !== null),
  };
}

export function fromBrasilApiCep(body: Json): CepLookup {
  return {
    source: 'brasilapi',
    address: {
      ...EMPTY_ADDRESS,
      cep: normalizeCep(String(body.cep ?? '')) || null,
      street: str(body.street),
      district: str(body.neighborhood),
      city: str(body.city),
      state: uf(body.state),
    },
  };
}

export function fromViaCep(body: Json): CepLookup {
  return {
    source: 'viacep',
    address: {
      ...EMPTY_ADDRESS,
      cep: normalizeCep(String(body.cep ?? '')) || null,
      street: str(body.logradouro),
      district: str(body.bairro),
      city: str(body.localidade),
      state: uf(body.uf),
    },
  };
}

interface Attempt<T> {
  supplier: string;
  url: string;
  /** Statuses that mean "no such CNPJ/CEP" rather than "the supplier failed". */
  notFound: number[];
  /** A 200 whose body still means "not found" (ViaCEP answers `{ erro: true }`). */
  emptyBody?: (body: Json) => boolean;
  map: (body: Json) => T;
}

export function createRegistryLookup(deps: { fetch?: typeof fetch; log: FastifyBaseLogger }) {
  const doFetch = deps.fetch ?? fetch;
  const cache = new Map<string, { at: number; value: LookupResult<unknown> }>();

  async function firstAnswer<T>(key: string, attempts: Attempt<T>[]): Promise<LookupResult<T>> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as LookupResult<T>;

    let notFound = false;
    for (const attempt of attempts) {
      try {
        const response = await doFetch(attempt.url, {
          headers: { accept: 'application/json', 'user-agent': 'WingsSystem/1.0' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = (await response.json().catch(() => null)) as Json | null;
        if (attempt.notFound.includes(response.status) || (body && attempt.emptyBody?.(body))) {
          notFound = true;
          continue;
        }
        if (!response.ok || !body || typeof body !== 'object') {
          deps.log.warn(
            { supplier: attempt.supplier, status: response.status, shape: shapeOf(body) },
            'registry lookup failed',
          );
          continue;
        }
        const result: LookupResult<T> = { ok: true, value: attempt.map(body) };
        remember(key, result);
        return result;
      } catch (error) {
        deps.log.warn(
          { supplier: attempt.supplier, error: error instanceof Error ? error.name : 'unknown' },
          'registry lookup failed',
        );
      }
    }
    const result: LookupResult<T> = { ok: false, reason: notFound ? 'not_found' : 'unavailable' };
    // "Not found" is worth remembering for a while; "unavailable" is retried at once.
    if (notFound) remember(key, result);
    return result;
  }

  function remember(key: string, value: LookupResult<unknown>) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), value });
  }

  return {
    cnpj(raw: string): Promise<LookupResult<CnpjLookup>> {
      const cnpj = normalizeCnpj(raw);
      return firstAnswer(`cnpj:${cnpj}`, [
        {
          supplier: 'brasilapi',
          url: `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
          notFound: [404],
          map: fromBrasilApiCnpj,
        },
        {
          supplier: 'receitaws',
          url: `https://receitaws.com.br/v1/cnpj/${cnpj}`,
          notFound: [404],
          // ReceitaWS answers 200 with status ERROR for a CNPJ it does not know.
          emptyBody: (body) => body.status === 'ERROR',
          map: fromReceitaWsCnpj,
        },
      ]);
    },
    cep(raw: string): Promise<LookupResult<CepLookup>> {
      const cep = normalizeCep(raw);
      return firstAnswer(`cep:${cep}`, [
        {
          supplier: 'brasilapi',
          url: `https://brasilapi.com.br/api/cep/v2/${cep}`,
          notFound: [404],
          map: fromBrasilApiCep,
        },
        {
          supplier: 'viacep',
          url: `https://viacep.com.br/ws/${cep}/json/`,
          notFound: [400],
          emptyBody: (body) => body.erro === true || body.erro === 'true',
          map: fromViaCep,
        },
      ]);
    },
  };
}

export type RegistryLookup = ReturnType<typeof createRegistryLookup>;
