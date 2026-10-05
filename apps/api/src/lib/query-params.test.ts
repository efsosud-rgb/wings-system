import { describe, expect, it } from 'vitest';
import { paramsOfAddress } from './query-params.js';

const keys = (value: string | null) => Object.fromEntries(paramsOfAddress(value));

describe('paramsOfAddress', () => {
  it('reads the query of a full URL', () => {
    expect(keys('https://x.com/contato/?utm_source=google&utm_campaign=a')).toEqual({
      utm_source: 'google',
      utm_campaign: 'a',
    });
  });

  it('reads a bare query string, with or without "?"', () => {
    expect(keys('utm_source=facebook&utm_medium=cpc')).toEqual({
      utm_source: 'facebook',
      utm_medium: 'cpc',
    });
    expect(keys('?utm_content=video-2')).toEqual({ utm_content: 'video-2' });
  });

  it('reads nothing from a label or an empty value', () => {
    expect(keys('(direct)')).toEqual({});
    expect(keys('')).toEqual({});
    expect(keys(null)).toEqual({});
  });
});
