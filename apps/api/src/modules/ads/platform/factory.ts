import type { Env } from '../../../env.js';
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

export function createMetaClient(env: Env): PlatformClientResult {
  const writeReady = Boolean(env.META_WRITE_TOKEN && env.META_WRITE_ACCOUNT_ID);

  if (writeReady && env.ADS_WRITES_ENABLED) {
    return {
      client: new MetaWriteClient({
        accessToken: env.META_WRITE_TOKEN as string,
        adAccountId: env.META_WRITE_ACCOUNT_ID as string,
        confirmWrites: true,
      }),
      canWrite: true,
    };
  }

  // A write token with the switch off still gives a perfectly good reader.
  if (writeReady) {
    return {
      client: new MetaReadOnlyClient({
        accessToken: env.META_WRITE_TOKEN as string,
        adAccountId: env.META_WRITE_ACCOUNT_ID as string,
      }),
      canWrite: false,
      reason: 'writes_disabled',
    };
  }

  return { client: null, canWrite: false, reason: 'no_credentials' };
}
