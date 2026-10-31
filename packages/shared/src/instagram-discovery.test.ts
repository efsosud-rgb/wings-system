import { describe, expect, it } from 'vitest';
import {
  graphErrorKindOf,
  instagramDiscoverySchema,
  instagramMetricsOf,
  instagramOfWebsite,
  type InstagramSnapshotView,
} from './instagram-discovery.js';
import { instagramProspectingSettingsSchema } from './prospect-ai.js';

describe('instagramOfWebsite', () => {
  it('takes the @ of a profile address', () => {
    expect(instagramOfWebsite('https://www.instagram.com/padaria.exemplo/')).toBe(
      'padaria.exemplo',
    );
    expect(instagramOfWebsite('instagram.com/Padaria_Exemplo?igsh=abc')).toBe('padaria_exemplo');
    expect(instagramOfWebsite('http://m.instagram.com/loja.ficticia')).toBe('loja.ficticia');
  });

  it('is null for a post, a reel, another site or a deeper path', () => {
    expect(instagramOfWebsite('https://www.instagram.com/p/AbC123/')).toBeNull();
    expect(instagramOfWebsite('https://www.instagram.com/reel/AbC123/')).toBeNull();
    expect(instagramOfWebsite('https://www.instagram.com/padaria.exemplo/reels/')).toBeNull();
    expect(instagramOfWebsite('https://padaria.exemplo.com.br/')).toBeNull();
    expect(instagramOfWebsite('https://notinstagram.com/padaria')).toBeNull();
    expect(instagramOfWebsite(null)).toBeNull();
  });
});

describe('graphErrorKindOf', () => {
  it('maps the codes the site-form check already treats, plus 80002', () => {
    expect(graphErrorKindOf({ code: 110 })).toBe('not_business');
    expect(graphErrorKindOf({ code: 24 })).toBe('not_business');
    expect(graphErrorKindOf({ code: 100, error_subcode: 2207013 })).toBe('not_business');
    expect(graphErrorKindOf({ code: 100, message: 'Invalid user id' })).toBe('not_business');
    expect(graphErrorKindOf({ code: 100, message: 'Unsupported get request' })).toBe('other');
    for (const code of [10, 190, 200]) expect(graphErrorKindOf({ code })).toBe('permission');
    for (const code of [4, 17, 32, 613, 80002])
      expect(graphErrorKindOf({ code })).toBe('rate_limit');
    expect(graphErrorKindOf(undefined)).toBe('other');
  });
});

describe('instagramDiscoverySchema', () => {
  it('takes 1 to 20 at a time', () => {
    const item = { username: 'loja.ficticia', ticket: 't' };
    expect(instagramDiscoverySchema.safeParse({ items: [item] }).success).toBe(true);
    expect(instagramDiscoverySchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      instagramDiscoverySchema.safeParse({ items: Array.from({ length: 21 }, () => item) }).success,
    ).toBe(false);
  });
});

describe('instagramMetricsOf', () => {
  const base: InstagramSnapshotView = {
    username: 'loja.ficticia',
    status: 'encontrada',
    followers: 10,
    posts: 2,
    recentMediaRead: 2,
    avgLikesMilli: 1000,
    avgCommentsMilli: null,
    postsLast30d: 1,
    lastPostAt: null,
    source: 'meta_business_discovery',
    fetchedAt: '2026-10-31T12:00:00.000Z',
  };
  it('has numbers only for a business account found', () => {
    expect(instagramMetricsOf(base)?.followers).toBe(10);
    expect(instagramMetricsOf({ ...base, status: 'nao_comercial' })).toBeNull();
    expect(instagramMetricsOf({ ...base, status: 'erro' })).toBeNull();
    expect(instagramMetricsOf(null)).toBeNull();
  });
});

describe('Instagram settings', () => {
  it('a row saved before the discovery limits reads their defaults, keeping the rest', () => {
    const saved = instagramProspectingSettingsSchema.parse({
      paste: { maxChars: 50_000, maxComments: 300, perSellerPerDay: 10 },
      thresholds: { listar: 70, revisar: 40 },
      retention: { instagramSemLeadDias: 30 },
      messages: {
        primeiraAbordagemDirect: 'Oi {link_politica}',
        linkPolitica: 'https://exemplo.com.br/p',
      },
    });
    expect(saved.discovery).toEqual({ cacheDias: 7, porDia: 500, recentPosts: 12 });
    expect(saved.messages.linkPolitica).toBe('https://exemplo.com.br/p');
  });
});
