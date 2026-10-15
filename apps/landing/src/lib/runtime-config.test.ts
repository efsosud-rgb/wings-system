import { describe, expect, it } from 'vitest';
import { apiBaseOf, gtmIdOf, readRuntimeConfig } from './runtime-config.js';

describe('apiBaseOf', () => {
  it('takes an absolute address and drops the trailing slash', () => {
    expect(apiBaseOf('https://wingssystem.online/api/', '/api')).toBe(
      'https://wingssystem.online/api',
    );
    expect(apiBaseOf('https://staging.wingssystem.online/api', '/api')).toBe(
      'https://staging.wingssystem.online/api',
    );
  });

  it('falls back on a placeholder nginx did not fill, an empty value or anything odd', () => {
    expect(apiBaseOf('__LANDING_API_BASE__', '/api')).toBe('/api');
    expect(apiBaseOf('', '/api')).toBe('/api');
    expect(apiBaseOf(null, '/api')).toBe('/api');
    expect(apiBaseOf('javascript:alert(1)', '/api')).toBe('/api');
    expect(apiBaseOf('//evil.example/api', '/api')).toBe('/api');
    expect(apiBaseOf('https://wingssystem.online/api?x=1', '/api')).toBe('/api');
  });

  it('takes a path on this host', () => {
    expect(apiBaseOf('/api/', 'x')).toBe('/api');
  });
});

describe('gtmIdOf', () => {
  it('takes a container id and nothing else', () => {
    expect(gtmIdOf('GTM-MXJLC5HH')).toBe('GTM-MXJLC5HH');
    expect(gtmIdOf(' gtm-mxjlc5hh ')).toBe('GTM-MXJLC5HH');
    expect(gtmIdOf('')).toBeNull();
    expect(gtmIdOf('__LANDING_GTM_ID__')).toBeNull();
    expect(gtmIdOf('GTM-1"><script>')).toBeNull();
  });
});

describe('readRuntimeConfig', () => {
  it('reads the meta tags nginx filled', () => {
    const metas: Record<string, string> = {
      'meta[name="wings:api-base"]': 'https://wingssystem.online/api',
      'meta[name="wings:gtm-id"]': 'GTM-MXJLC5HH',
    };
    const doc = {
      querySelector: (selector: string) =>
        selector in metas ? ({ content: metas[selector] } as HTMLMetaElement) : null,
    } as unknown as Pick<Document, 'querySelector'>;
    expect(readRuntimeConfig(doc, '/api')).toEqual({
      apiBase: 'https://wingssystem.online/api',
      gtmId: 'GTM-MXJLC5HH',
    });
  });

  it('falls back when the page has no tags', () => {
    const doc = { querySelector: () => null } as unknown as Pick<Document, 'querySelector'>;
    expect(readRuntimeConfig(doc, '/api')).toEqual({ apiBase: '/api', gtmId: null });
  });
});
