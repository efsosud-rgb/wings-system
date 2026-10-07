import type { WhatsAppConfig } from './graph.js';
import { readCallingSettings } from './graph.js';

/**
 * Whether calling is on for our number, as Meta's settings say (calls come
 * switched off on a test number until someone turns them on). Read at most
 * every 5 minutes; while Meta cannot be read, the last answer stands, and
 * with none, calling is off.
 */
const FRESH_MS = 5 * 60_000;
let cached: { on: boolean; at: number; key: string } | null = null;

export async function callingOn(
  fetchImpl: typeof fetch,
  config: WhatsAppConfig | null,
  now = Date.now(),
) {
  if (!config) return false;
  if (cached && cached.key === config.phoneNumberId && now - cached.at < FRESH_MS) return cached.on;
  const settings = await readCallingSettings(fetchImpl, config);
  const on = settings.ok
    ? (settings.data.calling?.status ?? '').toUpperCase() === 'ENABLED'
    : (cached?.key === config.phoneNumberId && cached.on) || false;
  cached = { on, at: now, key: config.phoneNumberId };
  return on;
}

/** Tests only: forget the last answer. */
export function forgetCallingSettings() {
  cached = null;
}
