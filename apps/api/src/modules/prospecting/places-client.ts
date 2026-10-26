import { PROSPECT_PAGE_SIZE, type PlaceResult } from '@wings/shared';

/**
 * Google Places API (New), read only, for Prospecção (docs/crm/prospeccao.md).
 *
 * The key travels in the `X-Goog-Api-Key` header, never in a URL, and no
 * error built here carries the key, the URL or Google's text: a code and the
 * HTTP status, nothing else. What Google answers lives in the reply to the
 * seller and is never stored (Maps Platform terms: only the place_id may be).
 * A call is made once and never retried: it may have been billed.
 */

const API_BASE = 'https://places.googleapis.com/v1';
const TIMEOUT_MS = 10_000;

/** The fields asked for (Text Search Pro + Enterprise SKUs); nothing else comes back. */
export const SEARCH_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.businessStatus,places.googleMapsUri,places.types,nextPageToken';
export const DETAILS_FIELD_MASK =
  'id,displayName,formattedAddress,nationalPhoneNumber,websiteUri,rating,userRatingCount,businessStatus,googleMapsUri,types';

export type PlacesErrorCode =
  'timeout' | 'unavailable' | 'key_invalid' | 'quota_exceeded' | 'bad_request' | 'not_found';

export class PlacesError extends Error {
  constructor(
    readonly code: PlacesErrorCode,
    readonly status: number | null,
  ) {
    super(`places_api: ${code}${status === null ? '' : ` (${status})`}`);
    this.name = 'PlacesError';
  }
}

export interface PlacesClient {
  /** One Text Search call (one page of up to 20). */
  searchText(input: {
    textQuery: string;
    pageToken?: string;
    minRating?: number | null;
  }): Promise<{ places: PlaceResult[]; nextPageToken: string | null }>;
  /** One Place Details call; null when Google no longer knows the place (NOT_FOUND). */
  details(placeId: string): Promise<PlaceResult | null>;
}

/** Google's error (`{ error: { code, message, status, details } }`) as a code the screen knows. */
function codeOf(httpStatus: number, body: unknown): PlacesErrorCode {
  const error = (body as { error?: { status?: string; details?: { reason?: string }[] } })?.error;
  const reasons = (Array.isArray(error?.details) ? error.details : []).map((d) => d?.reason);
  if (error?.status === 'NOT_FOUND' || httpStatus === 404) return 'not_found';
  if (error?.status === 'RESOURCE_EXHAUSTED' || httpStatus === 429) return 'quota_exceeded';
  if (
    reasons.includes('API_KEY_INVALID') ||
    error?.status === 'PERMISSION_DENIED' ||
    httpStatus === 403
  )
    return 'key_invalid';
  if (httpStatus === 400) return 'bad_request';
  return 'unavailable';
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export function toPlaceResult(raw: unknown): PlaceResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const place = raw as Record<string, unknown>;
  const placeId = text(place.id);
  if (!placeId) return null;
  const reviews = number(place.userRatingCount);
  return {
    placeId,
    name: text((place.displayName as { text?: unknown } | undefined)?.text),
    address: text(place.formattedAddress),
    phone: text(place.nationalPhoneNumber),
    website: text(place.websiteUri),
    rating: number(place.rating),
    reviews: reviews === null ? null : Math.trunc(reviews),
    businessStatus: text(place.businessStatus),
    mapsUri: text(place.googleMapsUri),
    types: Array.isArray(place.types)
      ? place.types.filter((t): t is string => typeof t === 'string')
      : [],
  };
}

export function createPlacesClient(config: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): PlacesClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? TIMEOUT_MS;

  async function call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new PlacesError(
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable',
        null,
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new PlacesError(codeOf(response.status, body), response.status);
    if (!body || typeof body !== 'object') throw new PlacesError('unavailable', response.status);
    return body as Record<string, unknown>;
  }

  const headers = (fieldMask: string) => ({
    'X-Goog-Api-Key': config.apiKey,
    'X-Goog-FieldMask': fieldMask,
    accept: 'application/json',
  });

  return {
    async searchText({ textQuery, pageToken, minRating }) {
      const body = await call(`${API_BASE}/places:searchText`, {
        method: 'POST',
        headers: { ...headers(SEARCH_FIELD_MASK), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          textQuery,
          languageCode: 'pt-BR',
          regionCode: 'BR',
          pageSize: PROSPECT_PAGE_SIZE,
          ...(pageToken ? { pageToken } : {}),
          // Google takes 0.5 steps only; the exact floor is applied to the answer.
          ...(minRating && minRating > 0 ? { minRating: Math.floor(minRating * 2) / 2 } : {}),
        }),
      });
      const places = (Array.isArray(body.places) ? body.places : [])
        .map(toPlaceResult)
        .filter((p): p is PlaceResult => p !== null);
      return { places, nextPageToken: text(body.nextPageToken) };
    },

    async details(placeId) {
      const query = new URLSearchParams({ languageCode: 'pt-BR', regionCode: 'BR' });
      try {
        const body = await call(`${API_BASE}/places/${encodeURIComponent(placeId)}?${query}`, {
          method: 'GET',
          headers: headers(DETAILS_FIELD_MASK),
        });
        return toPlaceResult(body);
      } catch (error) {
        if (error instanceof PlacesError && error.code === 'not_found') return null;
        throw error;
      }
    },
  };
}
