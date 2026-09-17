import type { Database } from '../../../db/client.js';
import type { Env } from '../../../env.js';
import { ZapiClient } from '../../../lib/zapi.js';
import { LoggingAlertNotifier, type AlertNotifier } from '../alerts.js';
import { LoggingApprovalNotifier, type ApprovalNotifier } from '../approvals.js';
import { WhatsAppAlertNotifier } from './alert-whatsapp.js';
import { WhatsAppApprovalNotifier } from './whatsapp.js';

const split = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

function zapiClient(env: Env): ZapiClient | null {
  if (!env.ZAPI_INSTANCE_ID || !env.ZAPI_INSTANCE_TOKEN || !env.ZAPI_CLIENT_TOKEN) return null;
  return new ZapiClient({
    instanceId: env.ZAPI_INSTANCE_ID,
    instanceToken: env.ZAPI_INSTANCE_TOKEN,
    clientToken: env.ZAPI_CLIENT_TOKEN,
  });
}

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
  const client = zapiClient(env);

  if (!client) {
    log('[approvals] Z-API not configured; approval notifications will only be logged');
    return fallback;
  }

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

/**
 * Builds the notifier the alert engine should use.
 *
 * Same channel and the same three people as approvals, but reserved for
 * critical alerts. Without credentials it logs, and says that it only logged.
 */
export function createAlertNotifier(
  env: Env,
  db: Database,
  log: (message: string) => void = console.warn,
): AlertNotifier {
  const fallback = new LoggingAlertNotifier(log);
  const client = zapiClient(env);

  if (!client) {
    log('[alerts] Z-API not configured; critical alerts will only be logged');
    return fallback;
  }

  return new WhatsAppAlertNotifier({
    db,
    client,
    appBaseUrl: env.APP_BASE_URL,
    extraPhones: [
      ...split(env.ADS_APPROVAL_ADMIN_PHONES),
      ...split(env.ADS_APPROVAL_DIRETORIA_PHONES),
    ],
    fallback,
    log,
  });
}
