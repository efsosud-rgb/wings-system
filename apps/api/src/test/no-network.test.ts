import http from 'node:http';
import https from 'node:https';
import { describe, expect, it } from 'vitest';

/**
 * Proves the kill switch itself works. Without this, the guarantee "tests
 * cannot reach a live ad account" would rest on an untested assumption.
 */
describe('test network isolation', () => {
  it('blocks fetch', async () => {
    await expect(fetch('https://graph.facebook.com/v23.0/me')).rejects.toThrow(
      /Network access is disabled in tests/,
    );
  });

  it('blocks https.request, which a platform SDK might use instead of fetch', () => {
    expect(() => https.request('https://graph.facebook.com/v23.0/me')).toThrow(
      /Network access is disabled in tests/,
    );
    expect(() => https.get('https://graph.facebook.com/v23.0/me')).toThrow(
      /Network access is disabled in tests/,
    );
  });

  it('blocks plain http too', () => {
    expect(() => http.request('http://example.com')).toThrow(/Network access is disabled/);
  });

  it('keeps no live ad credentials in the environment', () => {
    for (const name of [
      'META_ACCESS_TOKEN',
      'META_SYSTEM_USER_TOKEN',
      'META_AD_ACCOUNT_ID',
      'ADS_TOKEN_KEY',
    ]) {
      expect(process.env[name] ?? '').toBe('');
    }
  });
});
