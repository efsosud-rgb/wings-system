import { describe, expect, it } from 'vitest';
import { auditConversions } from './audit.js';
import { adsOfTrafficSource, type Conversion, type CrmContact } from './rd.js';

const now = new Date('2026-09-29T18:00:00Z'); // 15:00 in São Paulo

function conv(over: Partial<Conversion>): Conversion {
  return {
    contactUuid: 'u1',
    identifier: 'lp-x',
    occurredAt: new Date('2026-09-29T14:00:00Z'),
    name: 'Fulano Secreto',
    email: 'secreto@example.com',
    phone: '11999990000',
    company: null,
    utms: null,
    page: null,
    eventType: 'CONVERSION',
    ads: null,
    ...over,
  };
}

function run(
  byContact: Record<string, Conversion[]>,
  contacts: Record<string, CrmContact | null>,
  deals: Record<string, { createdAt: Date | null; pipeline: string; stage: string }>,
) {
  return auditConversions({
    now,
    days: 90,
    marketing: {
      contactsConvertedSince: async () => Object.keys(byContact),
      conversionsOf: async (uuid) => byContact[uuid] ?? [],
    },
    crm: {
      findContact: async (email) => contacts[email ?? ''] ?? null,
      dealPlacement: async (id) => deals[id]!,
    },
  });
}

describe('landing page audit', () => {
  it('counts conversions with and without a deal, per identifier, with funnel and stage', async () => {
    const result = await run(
      {
        u1: [conv({ identifier: 'lp-a', email: 'a@example.com' })],
        u2: [conv({ contactUuid: 'u2', identifier: 'lp-a', email: 'b@example.com' })],
        u3: [conv({ contactUuid: 'u3', identifier: 'lp-b', email: 'c@example.com' })],
      },
      { 'a@example.com': { id: 'c1', deals: [{ id: 'd1', win: null }] } },
      {
        d1: {
          createdAt: new Date('2026-09-29T14:05:00Z'),
          pipeline: 'Formatação',
          stage: 'Sem contato',
        },
      },
    );
    const a = result.pages.find((p) => p.identifier === 'lp-a')!;
    expect(a).toMatchObject({ conversions: 2, people: 2, withDeal: 1, leaked: 1 });
    expect(a.funnels).toEqual({ 'Formatação / Sem contato': 1 });
    expect(result.pages.find((p) => p.identifier === 'lp-b')).toMatchObject({
      leaked: 1,
      withDeal: 0,
    });
  });

  it("lists today's conversions with the platform, event type and one number per person", async () => {
    const result = await run(
      {
        u1: [
          conv({
            ads: 'meta',
            utms: {
              source: 'facebook',
              medium: 'cpc',
              campaign: 'Jimmy Ogro 28Set',
              content: null,
            },
          }),
          conv({
            ads: 'google',
            occurredAt: new Date('2026-09-29T15:00:00Z'),
            eventType: 'OPPORTUNITY',
          }),
        ],
        u2: [
          conv({
            contactUuid: 'u2',
            email: 'outra@example.com',
            ads: 'google',
            occurredAt: new Date('2026-09-28T10:00:00Z'),
          }),
        ],
      },
      {},
      {},
    );
    expect(result.today).toMatchObject({ day: '2026-09-29', conversions: 2, people: 1 });
    expect(result.today.rows.map((r) => [r.hour, r.ads, r.person, r.deal, r.eventType])).toEqual([
      ['11:00', 'meta', 1, null, 'CONVERSION'],
      ['12:00', 'google', 1, null, 'OPPORTUNITY'],
    ]);
  });

  it('never puts a name, e-mail or phone in the answer', async () => {
    const result = await run({ u1: [conv({})] }, {}, {});
    const text = JSON.stringify(result);
    for (const secret of ['Fulano', 'secreto@', '11999990000']) expect(text).not.toContain(secret);
  });

  it('reads the ad platform from click ids and UTM sources', () => {
    const encode = (value: string) =>
      'encoded_' + Buffer.from(JSON.stringify({ current_session: { value } })).toString('base64');
    expect(adsOfTrafficSource(encode('https://x.com/?gclid=abc'))).toBe('google');
    expect(adsOfTrafficSource(encode('https://x.com/?fbclid=abc'))).toBe('meta');
    expect(adsOfTrafficSource(encode('https://x.com/?utm_source=instagram'))).toBe('meta');
    expect(adsOfTrafficSource(encode('https://x.com/'))).toBeNull();
    expect(adsOfTrafficSource('(direct)')).toBeNull();
  });
});
