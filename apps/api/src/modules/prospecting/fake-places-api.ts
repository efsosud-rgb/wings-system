/**
 * A scripted Places API (New) for tests, so no test ever reaches Google. The
 * places follow the shape of Google's documentation (Text Search and Place
 * Details, v1, field masks as `places-client.ts` asks): made-up companies,
 * Niterói-style addresses and fake phones, never a real business.
 */

export interface RawPlace {
  id: string;
  displayName?: { text: string; languageCode?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  googleMapsUri?: string;
  types?: string[];
}

export const fakePlace = (n: number, overrides: Partial<RawPlace> = {}): RawPlace => ({
  id: `ChIJfakePlace${String(n).padStart(4, '0')}xyz`,
  displayName: { text: `Hamburgueria Teste ${n}`, languageCode: 'pt-BR' },
  formattedAddress: `Rua Fictícia, ${n} - Icaraí, Niterói - RJ, 24220-000, Brasil`,
  nationalPhoneNumber: `(21) 99000-${String(n).padStart(4, '0')}`,
  websiteUri: `https://hamburgueria-teste-${n}.example.com.br/`,
  rating: 4.6,
  userRatingCount: 320,
  businessStatus: 'OPERATIONAL',
  googleMapsUri: `https://maps.google.com/?cid=1000${n}`,
  types: ['hamburger_restaurant', 'restaurant', 'food'],
  ...overrides,
});

export interface FakePlacesCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export interface FakePlacesOptions {
  key: string;
  /** Pages of places per textQuery ("segmento em local"); an unknown query answers no places. */
  searches?: Record<string, RawPlace[][]>;
  /** The places Place Details knows; any other id answers NOT_FOUND. */
  places?: RawPlace[];
  /** Every call answers this Google error. */
  failWith?: { httpStatus: number; status: string; reason?: string };
}

const googleError = (httpStatus: number, status: string, reason?: string) =>
  Response.json(
    {
      error: {
        code: httpStatus,
        message: 'Fake Google error.',
        status,
        ...(reason
          ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] }
          : {}),
      },
    },
    { status: httpStatus },
  );

export function fakePlacesApi(options: FakePlacesOptions) {
  const calls: FakePlacesCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, method: init?.method ?? 'GET', headers, body });
    if (options.failWith)
      return googleError(
        options.failWith.httpStatus,
        options.failWith.status,
        options.failWith.reason,
      );
    if (headers['x-goog-api-key'] !== options.key)
      return googleError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID');
    const path = new URL(url).pathname;
    if (path === '/v1/places:searchText') {
      const query = String(body?.textQuery ?? '');
      const pages = options.searches?.[query] ?? [[]];
      const token = typeof body?.pageToken === 'string' ? body.pageToken : null;
      const index = token ? Number(token.split('|')[1]) : 0;
      const page = pages[index] ?? [];
      return Response.json({
        places: page,
        ...(index + 1 < pages.length ? { nextPageToken: `${query}|${index + 1}` } : {}),
      });
    }
    const id = decodeURIComponent(path.replace('/v1/places/', ''));
    const place = options.places?.find((p) => p.id === id);
    return place ? Response.json(place) : googleError(404, 'NOT_FOUND');
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}
