import { scrubSensitive } from '../../agent/scrub.js';
import { shapeOf } from '../kairogen-adapter.js';
import { ProviderError, type ShapeNoter } from './types.js';

/**
 * What the HTTP providers share: one request, its outcome sorted into the
 * provider error codes, and the answer's SHAPE on record so an unverified
 * format can be corrected from the log instead of from a guess.
 */

type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const fold = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A field by any of its spellings: `task_id`, `taskId` and `TaskID` are one name. */
export function pick(source: unknown, ...names: string[]): unknown {
  if (!isObject(source)) return undefined;
  const wanted = names.map(fold);
  for (const [key, value] of Object.entries(source)) {
    if (wanted.includes(fold(key)) && value !== null && value !== undefined) return value;
  }
  return undefined;
}

export const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

export const asNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

/** A field found at any depth, first match wins. For answers that nest their payload under `data`, `result`, `response`… */
export function find(source: unknown, names: string[], depth = 0): unknown {
  if (depth > 6) return undefined;
  const direct = pick(source, ...names);
  if (direct !== undefined) return direct;
  if (Array.isArray(source)) {
    for (const item of source.slice(0, 8)) {
      const found = find(item, names, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isObject(source)) return undefined;
  for (const value of Object.values(source)) {
    if (isObject(value) || Array.isArray(value)) {
      const found = find(value, names, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** A provider's words, safe for a screen: filtered and cut. Never an order. */
export const said = (text: string | null | undefined, max = 200) =>
  text ? scrubSensitive(text).slice(0, max) : null;

export interface HttpAnswer {
  status: number;
  contentType: string;
  json: unknown;
  bytes: Buffer;
}

export interface HttpCall {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** For the shape log: the provider and the call, never the address. */
  label: string;
  /** True for the one call that spends: a timeout is then `outcome_unknown`. */
  spends?: boolean;
}

/**
 * One HTTP request. A timeout or a dropped connection is `unavailable` for a
 * read and `outcome_unknown` for a call that spends; 401/403 is `unauthorized`;
 * 429 is `quota`; another 4xx is `rejected`; 5xx is `unavailable`. The body is
 * returned parsed when it is JSON and raw otherwise, and its shape is noted.
 */
export async function http(
  fetchFn: typeof fetch,
  call: HttpCall,
  noteShape?: ShapeNoter,
): Promise<HttpAnswer> {
  let response: Response;
  try {
    response = await fetchFn(call.url, {
      method: call.method,
      headers: {
        Accept: 'application/json, image/*, video/*',
        ...(call.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...call.headers,
      },
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
      signal: AbortSignal.timeout(call.timeoutMs),
    });
  } catch {
    throw new ProviderError(
      call.spends ? 'outcome_unknown' : 'unavailable',
      call.spends
        ? 'Não sabemos se o pedido chegou ao provedor. Confira lá antes de gerar de novo.'
        : 'O provedor não respondeu agora.',
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  const bytes = Buffer.from(await response.arrayBuffer());
  let json: unknown = null;
  if (/json/i.test(contentType) || (bytes.length > 0 && bytes[0] === 0x7b)) {
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      json = null;
    }
  }
  noteShape?.({
    tool: call.label,
    shape: { status: response.status, contentType: contentType.slice(0, 60), body: shapeOf(json) },
    text: json === null ? `bytes(${bytes.length})` : null,
  });

  if (response.ok) return { status: response.status, contentType, json, bytes };

  const message =
    asText(find(json, ['message', 'error_description', 'detail', 'error'])) ??
    asText(pick(find(json, ['error']), 'message'));
  const words = said(message) ?? `HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError('unauthorized', 'O provedor não aceitou a chave configurada.');
  }
  if (response.status === 429) {
    throw new ProviderError('quota', `O provedor limitou as chamadas agora. Resposta dele: ${words}`);
  }
  if (response.status >= 500) {
    throw new ProviderError(
      call.spends ? 'outcome_unknown' : 'unavailable',
      call.spends
        ? `O provedor falhou ao receber o pedido e não sabemos se ele ficou registrado lá. Resposta dele: ${words}`
        : 'O provedor não respondeu agora.',
    );
  }
  throw new ProviderError('rejected', `O provedor recusou o pedido. Resposta dele: ${words}`);
}

/** A reading kept for a while: balances and pings are not asked on every screen. */
export function memo<T>(ttlMs: number, read: () => Promise<T>): (now: () => Date) => Promise<T> {
  let at = 0;
  let value: Promise<T> | null = null;
  return (now) => {
    const time = now().getTime();
    if (!value || time - at >= ttlMs) {
      at = time;
      value = read().catch((error: unknown) => {
        value = null;
        throw error;
      });
    }
    return value;
  };
}

/** Base64 (plain or URL-safe, with or without a data: prefix) to bytes, or null when it is not that. */
export function bytesFromBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length < 16) return null;
  const raw = value.replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(raw)) return null;
  const bytes = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return bytes.length > 0 ? bytes : null;
}
