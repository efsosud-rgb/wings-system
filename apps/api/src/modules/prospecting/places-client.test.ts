import { describe, expect, it } from 'vitest';
import { fakePlace, fakePlacesApi } from './fake-places-api.js';
import {
  createPlacesClient,
  DETAILS_FIELD_MASK,
  PlacesError,
  SEARCH_FIELD_MASK,
} from './places-client.js';

const KEY = 'test-places-key-never-printed';

describe('Places client (recorded shapes, no real call)', () => {
  it('searches with the key in a header, the exact field mask and the body Google documents', async () => {
    const one = fakePlace(1);
    const api = fakePlacesApi({
      key: KEY,
      searches: { 'hamburguerias em Niterói': [[one], [fakePlace(2)]] },
    });
    const client = createPlacesClient({ apiKey: KEY, fetchImpl: api.fetch });
    const page = await client.searchText({ textQuery: 'hamburguerias em Niterói', minRating: 4.3 });

    const [call] = api.calls;
    expect(call?.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(call?.url).not.toContain(KEY);
    expect(call?.method).toBe('POST');
    expect(call?.headers['x-goog-api-key']).toBe(KEY);
    expect(call?.headers['x-goog-fieldmask']).toBe(SEARCH_FIELD_MASK);
    expect(call?.headers['content-type']).toBe('application/json');
    // 4.3 goes as Google's 0.5 step below it; the exact floor is applied to the answer.
    expect(call?.body).toEqual({
      textQuery: 'hamburguerias em Niterói',
      languageCode: 'pt-BR',
      regionCode: 'BR',
      pageSize: 20,
      minRating: 4,
    });
    expect(page.nextPageToken).toBe('hamburguerias em Niterói|1');
    expect(page.places).toEqual([
      {
        placeId: one.id,
        name: 'Hamburgueria Teste 1',
        address: one.formattedAddress,
        phone: '(21) 99000-0001',
        website: one.websiteUri,
        rating: 4.6,
        reviews: 320,
        businessStatus: 'OPERATIONAL',
        mapsUri: one.googleMapsUri,
        types: ['hamburger_restaurant', 'restaurant', 'food'],
      },
    ]);

    await client.searchText({
      textQuery: 'hamburguerias em Niterói',
      pageToken: 'hamburguerias em Niterói|1',
    });
    expect(api.calls[1]?.body).toMatchObject({ pageToken: 'hamburguerias em Niterói|1' });
    expect(api.calls[1]?.body).not.toHaveProperty('minRating');
  });

  it('maps a place with missing fields to nulls', async () => {
    const api = fakePlacesApi({
      key: KEY,
      searches: { 'x em y': [[{ id: 'ChIJonlyTheId0001' }]] },
    });
    const client = createPlacesClient({ apiKey: KEY, fetchImpl: api.fetch });
    const { places, nextPageToken } = await client.searchText({ textQuery: 'x em y' });
    expect(nextPageToken).toBeNull();
    expect(places[0]).toEqual({
      placeId: 'ChIJonlyTheId0001',
      name: null,
      address: null,
      phone: null,
      website: null,
      rating: null,
      reviews: null,
      businessStatus: null,
      mapsUri: null,
      types: [],
    });
  });

  it('reads one place, and Google NOT_FOUND as null', async () => {
    const place = fakePlace(7);
    const api = fakePlacesApi({ key: KEY, places: [place] });
    const client = createPlacesClient({ apiKey: KEY, fetchImpl: api.fetch });
    expect((await client.details(place.id))?.name).toBe('Hamburgueria Teste 7');
    const [call] = api.calls;
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe(
      `https://places.googleapis.com/v1/places/${place.id}?languageCode=pt-BR&regionCode=BR`,
    );
    expect(call?.headers['x-goog-fieldmask']).toBe(DETAILS_FIELD_MASK);
    expect(await client.details('ChIJgoneForGood0001')).toBeNull();
  });

  it.each([
    [{ httpStatus: 400, status: 'INVALID_ARGUMENT', reason: 'API_KEY_INVALID' }, 'key_invalid'],
    [{ httpStatus: 403, status: 'PERMISSION_DENIED' }, 'key_invalid'],
    [{ httpStatus: 429, status: 'RESOURCE_EXHAUSTED' }, 'quota_exceeded'],
    [{ httpStatus: 400, status: 'INVALID_ARGUMENT' }, 'bad_request'],
    [{ httpStatus: 500, status: 'INTERNAL' }, 'unavailable'],
  ])('turns %o into %s, never with the key or the URL', async (failWith, code) => {
    const api = fakePlacesApi({ key: KEY, failWith });
    const client = createPlacesClient({ apiKey: KEY, fetchImpl: api.fetch });
    const error = await client.searchText({ textQuery: 'a em b' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlacesError);
    expect((error as PlacesError).code).toBe(code);
    expect((error as PlacesError).status).toBe(failWith.httpStatus);
    expect(String((error as Error).message)).not.toContain(KEY);
    expect(String((error as Error).message)).not.toContain('googleapis');
  });

  it('gives up after its timeout, as `timeout`', async () => {
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const client = createPlacesClient({ apiKey: KEY, fetchImpl: hanging, timeoutMs: 20 });
    const error = await client.details('ChIJslowPlace00001').catch((e: unknown) => e);
    expect((error as PlacesError).code).toBe('timeout');
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it('a network failure is `unavailable`', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const client = createPlacesClient({ apiKey: KEY, fetchImpl: down });
    const error = await client.searchText({ textQuery: 'a em b' }).catch((e: unknown) => e);
    expect((error as PlacesError).code).toBe('unavailable');
  });
});
