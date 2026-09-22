import { MetaApiError } from './meta-client.js';

/**
 * Whether a platform refused a read for lack of permission, whichever
 * platform it was. Such a read is "não disponível": the ingest job records
 * it and moves on, because a field the token may not see is not a broken
 * account, and one denied breakdown must not cost the account its
 * reconciliation.
 */
export function isPermissionDenied(error: unknown): boolean {
  if (error instanceof MetaApiError) return error.isPermissionDenied;
  if (error instanceof Error) return /PERMISSION_DENIED|Permission Denied/i.test(error.message);
  return false;
}
