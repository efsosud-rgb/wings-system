import type { Env } from '../../../env.js';
import { GoogleAdsPlatformClient, GoogleAdsWriteClient } from './google-ads-client.js';
import { createGoogleClient } from './google-client.js';
import { MetaReadOnlyClient } from './meta-client.js';
import { MetaWriteClient } from './meta-write-client.js';
import type { AdsPlatformClient } from './types.js';

/**
 * Builds the Meta client for a request.
 *
 * Writes require three separate things to be true: a write token, a matching
 * account id, and ADS_WRITES_ENABLED. Missing any of them yields a read-only
 * client, so the system degrades to "can look, cannot touch" rather than
 * failing open.
 */
export interface PlatformClientResult {
  client: AdsPlatformClient | null;
  canWrite: boolean;
  /** Why writes are unavailable, for an honest message to the operator. */
  reason?: 'writes_disabled' | 'no_write_token' | 'no_credentials';
}

/**
 * @param accountExternalId overrides the configured account, so a caller
 * looping over several accounts builds one client per account instead of
 * reusing a client bound to whichever account the environment happens to name.
 */
export function createMetaClient(
  env: Env,
  accountExternalId?: string,
  fetchImpl?: typeof fetch,
): PlatformClientResult {
  const adAccountId = accountExternalId ?? env.META_WRITE_ACCOUNT_ID;
  const writeReady = Boolean(env.META_WRITE_TOKEN && adAccountId);

  if (writeReady && env.ADS_WRITES_ENABLED) {
    return {
      client: new MetaWriteClient({
        accessToken: env.META_WRITE_TOKEN as string,
        adAccountId: adAccountId as string,
        confirmWrites: true,
        fetchImpl,
      }),
      canWrite: true,
    };
  }

  // A write token with the switch off still gives a perfectly good reader.
  if (writeReady) {
    return {
      client: new MetaReadOnlyClient({
        accessToken: env.META_WRITE_TOKEN as string,
        adAccountId: adAccountId as string,
        fetchImpl,
      }),
      canWrite: false,
      reason: 'writes_disabled',
    };
  }

  return { client: null, canWrite: false, reason: 'no_credentials' };
}

/**
 * The Google counterpart. Google credentials name exactly one customer, so an
 * account row for any other customer gets no client at all rather than a
 * client that would read — or write — the wrong account.
 */
export function createGooglePlatformClient(
  env: Env,
  accountExternalId: string,
  fetchImpl?: typeof fetch,
): PlatformClientResult {
  const reader = createGoogleClient(env, fetchImpl);
  if (!reader || reader.customerId !== accountExternalId.replace(/-/g, '')) {
    return { client: null, canWrite: false, reason: 'no_credentials' };
  }
  if (env.ADS_WRITES_ENABLED) {
    return { client: new GoogleAdsWriteClient(reader, { confirmWrites: true }), canWrite: true };
  }
  return {
    client: new GoogleAdsPlatformClient(reader),
    canWrite: false,
    reason: 'writes_disabled',
  };
}

/** The client for an account row, whichever platform it belongs to. */
export function createPlatformClient(
  env: Env,
  account: { platform: string; externalId: string },
  fetchImpl?: typeof fetch,
): PlatformClientResult {
  if (account.platform === 'meta') return createMetaClient(env, account.externalId, fetchImpl);
  if (account.platform === 'google') {
    return createGooglePlatformClient(env, account.externalId, fetchImpl);
  }
  return { client: null, canWrite: false, reason: 'no_credentials' };
}
