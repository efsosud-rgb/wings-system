import {
  SITE_EVENT_NAMES,
  SITE_EVENT_STEPS,
  SITE_EVENT_UTM_KEYS,
  siteEventSchema,
} from '@wings/shared';
import { describe, expect, it } from 'vitest';
import {
  EVENT_NAMES,
  EVENT_STEPS,
  EVENT_UTM_KEYS,
  VISIT_STORAGE_KEY,
  browserBeacon,
  eventBodyOf,
  eventSender,
  eventsUrlOf,
  randomVisitId,
  visitIdOf,
} from './events.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const broken = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('event names', () => {
  it('are exactly the API’s lists, in the same order', () => {
    expect([...EVENT_NAMES]).toEqual([...SITE_EVENT_NAMES]);
    expect([...EVENT_STEPS]).toEqual([...SITE_EVENT_STEPS]);
    expect([...EVENT_UTM_KEYS]).toEqual([...SITE_EVENT_UTM_KEYS]);
  });

  it('the address is the form’s with /events after the slug', () => {
    expect(eventsUrlOf('https://wingssystem.online/api', 'fale-com-a-wings')).toBe(
      'https://wingssystem.online/api/public/site-forms/fale-com-a-wings/events',
    );
  });
});

describe('visitIdOf', () => {
  it('keeps the id already in sessionStorage', () => {
    const storage = memoryStorage({ [VISIT_STORAGE_KEY]: 'abcdef0123456789abcdef01' });
    expect(visitIdOf(storage, () => 'new')).toBe('abcdef0123456789abcdef01');
  });

  it('makes and keeps a new one when there is none or the kept one is not an id', () => {
    const storage = memoryStorage({ [VISIT_STORAGE_KEY]: 'Fulano <script>' });
    expect(visitIdOf(storage, () => 'a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
    expect(storage.data.get(VISIT_STORAGE_KEY)).toBe('a1b2c3d4e5f6');
    expect(visitIdOf(memoryStorage(), () => 'ffffffff')).toBe('ffffffff');
  });

  it('still answers an id with no storage, a storage that throws or a random source that throws', () => {
    expect(visitIdOf(null, () => 'a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
    expect(visitIdOf(broken, () => 'a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
    expect(
      visitIdOf(memoryStorage(), () => {
        throw new Error('no crypto');
      }),
    ).toMatch(/^[0-9a-f]{24}$/);
  });

  it('the random id is 24 hex characters the API accepts, different each time', () => {
    const a = randomVisitId();
    const b = randomVisitId();
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(a).not.toBe(b);
    expect(siteEventSchema.safeParse({ event: 'page_view', visit: a }).success).toBe(true);
  });
});

describe('eventBodyOf', () => {
  it('carries the event, the step, the visit and the UTMs only, never a click id, the referrer or a person', () => {
    const body = eventBodyOf('whatsapp_click', 'header', 'a1b2c3d4e5f6', {
      utm_source: 'ig',
      utm_medium: 'cpc',
      utm_campaign: 'lancamento',
      utm_content: 'video-2',
      utm_term: 'franquia',
      utm_id: '9',
      gclid: 'TESTE123',
      fbclid: 'x',
      referrer: 'https://l.instagram.com/',
    });
    expect(body).toEqual({
      event: 'whatsapp_click',
      step: 'header',
      visit: 'a1b2c3d4e5f6',
      utm_source: 'ig',
      utm_medium: 'cpc',
      utm_campaign: 'lancamento',
      utm_content: 'video-2',
      utm_term: 'franquia',
      utm_id: '9',
    });
    expect(siteEventSchema.safeParse(body).success).toBe(true);
  });

  it('sends the ids Meta puts in the address whole, and the API takes them', () => {
    const meta = {
      utm_source: 'ig',
      utm_medium: 'paid',
      utm_campaign: '120252596733630076',
      utm_content: '120252596746630076',
      utm_term: '120252596743640076',
      utm_id: '120252596733630076',
    };
    const body = eventBodyOf('page_view', undefined, 'a1b2c3d4e5f60718293a4b5c', meta);
    expect(body).toEqual({ event: 'page_view', visit: 'a1b2c3d4e5f60718293a4b5c', ...meta });
    expect(siteEventSchema.safeParse(body).success).toBe(true);
    // Under the route's 1 KB body limit even with every UTM at the 100-character cap.
    const longest = eventBodyOf('whatsapp_click', 'thanks', 'a'.repeat(32), {
      utm_source: 'x'.repeat(300),
      utm_medium: 'x'.repeat(300),
      utm_campaign: 'x'.repeat(300),
      utm_content: 'x'.repeat(300),
      utm_term: 'x'.repeat(300),
      utm_id: 'x'.repeat(300),
    });
    expect(new TextEncoder().encode(JSON.stringify(longest)).length).toBeLessThan(1024);
  });

  it('leaves the step out when there is none and cuts a UTM to the API’s limit', () => {
    const body = eventBodyOf('page_view', undefined, 'a1b2c3d4e5f6', {
      utm_source: 'x'.repeat(300),
    });
    expect(body).toEqual({
      event: 'page_view',
      visit: 'a1b2c3d4e5f6',
      utm_source: 'x'.repeat(100),
    });
    expect(siteEventSchema.safeParse(body).success).toBe(true);
  });
});

describe('eventSender', () => {
  const input = {
    apiBase: '/api',
    slug: 'fale-com-a-wings',
    visit: 'a1b2c3d4e5f6',
    origin: () => ({ utm_source: 'ig', gclid: 'no' }),
  };

  it('queues one text beacon per event at the events address', () => {
    const sent: [string, string][] = [];
    const send = eventSender({
      ...input,
      beacon: (url, body) => {
        sent.push([url, body]);
        return true;
      },
    });
    expect(send('form_start')).toBe(true);
    expect(send('submit_error', 'captcha')).toBe(true);
    expect(sent.map(([url, body]) => [url, JSON.parse(body)])).toEqual([
      [
        '/api/public/site-forms/fale-com-a-wings/events',
        { event: 'form_start', visit: 'a1b2c3d4e5f6', utm_source: 'ig' },
      ],
      [
        '/api/public/site-forms/fale-com-a-wings/events',
        { event: 'submit_error', step: 'captcha', visit: 'a1b2c3d4e5f6', utm_source: 'ig' },
      ],
    ]);
  });

  it('never throws: no beacon in this browser, or one that fails, is a false and the page goes on', () => {
    expect(eventSender({ ...input, beacon: null })('page_view')).toBe(false);
    expect(
      eventSender({
        ...input,
        beacon: () => {
          throw new Error('blocked');
        },
      })('page_view'),
    ).toBe(false);
    expect(eventSender({ ...input, beacon: () => false })('page_view')).toBe(false);
  });

  it('browserBeacon binds navigator.sendBeacon, and is null without one', () => {
    const calls: unknown[] = [];
    const nav = {
      sendBeacon(url: string, body: string) {
        calls.push([url, body]);
        return true;
      },
    } as unknown as Navigator;
    expect(browserBeacon(nav)?.('/x', '{}')).toBe(true);
    expect(calls).toEqual([['/x', '{}']]);
    expect(browserBeacon({} as Navigator)).toBeNull();
  });
});
