import type { Database } from '../../../db/client.js';
import type { Env } from '../../../env.js';
import { ZapiClient } from '../../../lib/zapi.js';
import { LoggingApprovalNotifier, type ApprovalNotifier } from '../approvals.js';
import { WhatsAppApprovalNotifier } from './whatsapp.js';

/**
 * Builds the notifier the approvals gate should use.
 *
 * Without Z-API credentials the gate keeps working and logs instead: a missing
 * channel must never stop a request from being recorded, and never make an
 * undelivered notification look delivered.
 */
export function createApprovalNotifier(
  env: Env,
  db: Database,
  log: (message: string) => void = console.warn,
): ApprovalNotifier {
  const fallback = new LoggingApprovalNotifier(log);

  if (!env.ZAPI_INSTANCE_ID || !env.ZAPI_INSTANCE_TOKEN || !env.ZAPI_CLIENT_TOKEN) {
    log('[approvals] Z-API not configured; approval notifications will only be logged');
    return fallback;
  }

  const client = new ZapiClient({
    instanceId: env.ZAPI_INSTANCE_ID,
    instanceToken: env.ZAPI_INSTANCE_TOKEN,
    clientToken: env.ZAPI_CLIENT_TOKEN,
  });

  const split = (value: string | undefined): string[] =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

  return new WhatsAppApprovalNotifier({
    db,
    client,
    appBaseUrl: env.APP_BASE_URL,
    extraAdminPhones: split(env.ADS_APPROVAL_ADMIN_PHONES),
    extraDiretoriaPhones: split(env.ADS_APPROVAL_DIRETORIA_PHONES),
    fallback,
    log,
  });
}
