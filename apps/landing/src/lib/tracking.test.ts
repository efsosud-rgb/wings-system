import { SITE_FORM_TRACKING_KEYS } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import {
  FIRST_TOUCH_STORAGE_KEY,
  TRACKING_KEYS,
  captureOrigin,
  dataLayerOriginOf,
  firstTouchOf,
  trackingOfSearch,
  trackingPayloadOf,
} from './tracking.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('tracking keys', () => {
  it('are exactly the API’s list, in the same order', () => {
    expect([...TRACKING_KEYS]).toEqual([...SITE_FORM_TRACKING_KEYS]);
  });
});

describe('trackingOfSearch', () => {
  it('keeps only the keys the API takes, never the referrer', () => {
    expect(
      trackingOfSearch(
        '?utm_source=meta&utm_id=9&msclkid=x&ttclid=y&gclid=abc&referrer=evil&hsa_ad=7&nome=Fulano',
      ),
    ).toEqual({ utm_source: 'meta', gclid: 'abc', hsa_ad: '7', utm_id: '9' });
  });

  it('keeps utm_id for the events, never in what the form sends (the API refuses the key)', () => {
    const origin = captureOrigin(
      '?utm_campaign=120252596733630076&utm_id=120252596733630076',
      '',
      null,
    );
    expect(origin.now.utm_id).toBe('120252596733630076');
    expect(trackingPayloadOf(origin)).toEqual({ utm_campaign: '120252596733630076' });
  });

  it('cuts every value to 500 characters', () => {
    expect(trackingOfSearch(`?utm_term=${'a'.repeat(900)}`).utm_term).toHaveLength(500);
  });
});

describe('firstTouchOf', () => {
  it('drops unknown keys and keeps the time it was stored', () => {
    expect(
      firstTouchOf(
        JSON.stringify({ ts: 5, utm_source: 'google', utm_id: '1', ttclid: 'y', referrer: 'x' }),
      ),
    ).toEqual({ ts: 5, utm_source: 'google', utm_id: '1' });
  });

  it('is null for nothing, garbage or a touch without keys', () => {
    expect(firstTouchOf(null)).toBeNull();
    expect(firstTouchOf('{oops')).toBeNull();
    expect(firstTouchOf('[1,2]')).toBeNull();
    expect(firstTouchOf(JSON.stringify({ ts: 1 }))).toBeNull();
  });
});

describe('captureOrigin', () => {
  it('stores the first visit with keys and never overwrites it', () => {
    const storage = memoryStorage();
    const first = captureOrigin('?utm_source=meta&utm_campaign=a', '', storage, () => 100);
    expect(first.first).toEqual({ ts: 100, utm_source: 'meta', utm_campaign: 'a' });
    const later = captureOrigin(
      '?utm_source=google',
      'https://www.google.com/',
      storage,
      () => 200,
    );
    expect(later.first).toEqual({ ts: 100, utm_source: 'meta', utm_campaign: 'a' });
    expect(later.now).toEqual({ utm_source: 'google' });
    expect(JSON.parse(storage.data.get(FIRST_TOUCH_STORAGE_KEY) ?? '{}')).toMatchObject({
      utm_source: 'meta',
    });
  });

  it('stores nothing for a visit without keys', () => {
    const storage = memoryStorage();
    expect(captureOrigin('', '', storage).first).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('works without storage, or with storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(captureOrigin('?gclid=1', '', throwing).first).toMatchObject({ gclid: '1' });
    expect(captureOrigin('?gclid=1', '', null).now).toEqual({ gclid: '1' });
  });
});

describe('trackingPayloadOf', () => {
  it('puts this visit over the first touch, adds the referrer and drops ts', () => {
    const payload = trackingPayloadOf({
      first: { ts: 1, utm_source: 'meta', utm_campaign: 'a' },
      now: { utm_source: 'google' },
      referrer: 'https://www.google.com/',
    });
    expect(payload).toEqual({
      utm_source: 'google',
      utm_campaign: 'a',
      referrer: 'https://www.google.com/',
    });
    expect(
      Object.keys(payload).every((key) => (TRACKING_KEYS as readonly string[]).includes(key)),
    ).toBe(true);
  });

  it('sends no empty referrer', () => {
    expect(trackingPayloadOf({ first: null, now: {}, referrer: '' })).toEqual({});
  });

  it('gives the dataLayer the first touch, else this visit', () => {
    expect(dataLayerOriginOf({ first: null, now: { gclid: '2' }, referrer: '' })).toEqual({
      gclid: '2',
    });
    expect(
      dataLayerOriginOf({ first: { ts: 1, gclid: '1' }, now: { gclid: '2' }, referrer: '' }),
    ).toEqual({ ts: 1, gclid: '1' });
  });
});

describe("Meta's browser ids (docs/ads/fechar-ciclo.md)", () => {
  const FBP = 'fb.1.1761955200000.1234567890';
  const FBC = 'fb.1.1761955200000.AbCdEf';

  it('sends the pixel cookies as they are', () => {
    const payload = trackingPayloadOf(
      { first: null, now: {}, referrer: '' },
      `other=1; _fbp=${FBP}; _fbc=${FBC}`,
    );
    expect(payload).toEqual({ fbp: FBP, fbc: FBC });
  });

  it('refuses a cookie out of Meta’s shape', () => {
    expect(
      trackingPayloadOf({ first: null, now: {}, referrer: '' }, '_fbp=x; _fbc=fb.1.1.'),
    ).toEqual({});
  });

  it('builds fbc from this visit’s fbclid with the moment it was seen', () => {
    const payload = trackingPayloadOf(
      { first: null, now: { fbclid: 'IwAR1' }, referrer: '' },
      '',
      () => 1_762_000_000_000,
    );
    expect(payload.fbc).toBe('fb.1.1762000000000.IwAR1');
  });

  it('builds fbc from the first touch’s fbclid with the first touch’s moment', () => {
    const payload = trackingPayloadOf(
      { first: { ts: 1_761_000_000_000, fbclid: 'IwAR0' }, now: {}, referrer: '' },
      '',
      () => 1_762_000_000_000,
    );
    expect(payload.fbc).toBe('fb.1.1761000000000.IwAR0');
  });

  it('never reads fbc or fbp from the address', () => {
    expect(trackingOfSearch(`?fbc=${FBC}&fbp=${FBP}`)).toEqual({});
  });
});
