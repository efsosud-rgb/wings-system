import http from 'node:http';
import https from 'node:https';

/**
 * Test-suite network kill switch.
 *
 * Wings Company has no sandbox ad accounts — every Meta credential points at a
 * live account spending real money. So the test suite must be physically
 * unable to reach the network, not merely expected to avoid it.
 *
 * Loaded as a vitest setupFile, this:
 *   1. refuses any outbound HTTP through fetch, http or https;
 *   2. fails the run outright if live ad-platform credentials are present in
 *      the environment, so tests can never execute "armed".
 *
 * A test that needs platform behaviour uses the fake client instead.
 */

const BLOCKED_MESSAGE =
  'Network access is disabled in tests. Wings has no sandbox ad accounts, so a ' +
  'real request could spend real money. Use the fake platform client instead.';

class NetworkBlockedError extends Error {
  constructor(target: string) {
    super(`${BLOCKED_MESSAGE} (blocked: ${target})`);
    this.name = 'NetworkBlockedError';
  }
}

/** Credentials that must never be present while tests run. */
const FORBIDDEN_ENV = [
  'META_ACCESS_TOKEN',
  'META_SYSTEM_USER_TOKEN',
  'META_APP_SECRET',
  'META_AD_ACCOUNT_ID',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'TIKTOK_ADS_ACCESS_TOKEN',
  'ADS_TOKEN_KEY',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
];

const present = FORBIDDEN_ENV.filter((name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
});

if (present.length > 0) {
  throw new Error(
    `Refusing to run tests with live ad-platform credentials in the environment: ${present.join(', ')}. ` +
      'Unset them. Tests must never be able to reach a live ad account.',
  );
}

globalThis.fetch = ((input: unknown): Promise<Response> => {
  const target =
    typeof input === 'string' ? input : input instanceof URL ? input.href : 'fetch request';
  return Promise.reject(new NetworkBlockedError(target));
}) as typeof fetch;

function blockAgent(module: typeof http | typeof https, name: string): void {
  const blocked = (...args: unknown[]): never => {
    const first = args[0];
    const target =
      typeof first === 'string'
        ? first
        : first instanceof URL
          ? first.href
          : `${name}.request(${typeof first})`;
    throw new NetworkBlockedError(target);
  };
  // Cast through unknown: we are deliberately replacing the real signatures.
  (module as unknown as Record<string, unknown>).request = blocked;
  (module as unknown as Record<string, unknown>).get = blocked;
}

blockAgent(http, 'http');
blockAgent(https, 'https');

export { NetworkBlockedError };
