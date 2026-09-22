import type { MediaProviderId } from '@wings/shared';
import type { Database } from '../../../db/client.js';
import type { Env } from '../../../env.js';
import { kairogenDepsOf } from '../../integrations/kairogen/service.js';
import { cloudflareProvider } from './cloudflare.js';
import { geminiProvider } from './gemini.js';
import { higgsfieldProvider } from './higgsfield.js';
import { kairogenProvider } from './kairogen.js';
import { mptProvider } from './mpt.js';
import type { MediaProvider, ShapeNoter } from './types.js';

export * from './types.js';
export { DEFAULT_ANIMATION_MODEL, clearModelCache, planOf, setPlan } from './kairogen.js';

/**
 * The registry: every provider the system knows, in the order they are tried
 * when one cannot serve. A provider without its variables is listed as "not
 * configured" and offers no model; nothing else changes.
 */

/** Writes a log line when a tool's answer shape is new, not once per call. Shapes only, never contents. */
export function shapeNoter(log: { info: (entry: object, message: string) => void }): ShapeNoter {
  const last = new Map<string, string>();
  return (entry) => {
    const seen = JSON.stringify(entry);
    if (last.get(entry.tool) === seen) return;
    last.set(entry.tool, seen);
    log.info(entry, 'provider answer shape');
  };
}

export function mediaProvidersOf(
  wings: {
    db: Database;
    env: Env;
    kairogenFetch?: typeof fetch;
    /** Set only by tests, so no test ever reaches a real provider. */
    mediaFetch?: typeof fetch;
  },
  log?: { info: (entry: object, message: string) => void },
): MediaProvider[] {
  const { env } = wings;
  const noteShape = log ? shapeNoter(log) : undefined;
  const fetchFn = wings.mediaFetch ?? fetch;
  return [
    kairogenProvider({
      kairogen: kairogenDepsOf(wings),
      db: wings.db,
      brlPerCredit: env.KAIROGEN_BRL_PER_CREDIT,
      monthlyCredits: env.KAIROGEN_MONTHLY_CREDITS,
      noteShape,
    }),
    cloudflareProvider({
      accountId: env.CF_ACCOUNT_ID,
      token: env.CF_WORKERS_AI_TOKEN,
      dailyImages: env.CF_WORKERS_AI_DAILY_IMAGES,
      fetch: fetchFn,
      noteShape,
    }),
    geminiProvider({
      apiKey: env.GEMINI_API_KEY,
      dailyImages: env.GEMINI_DAILY_IMAGES,
      imagesPerMinute: env.GEMINI_IMAGES_PER_MINUTE,
      fetch: fetchFn,
      noteShape,
    }),
    higgsfieldProvider({
      apiKey: env.HIGGSFIELD_API_KEY,
      apiSecret: env.HIGGSFIELD_API_SECRET,
      usdPerImage: env.HIGGSFIELD_USD_PER_IMAGE,
      usdPerVideoSecond: env.HIGGSFIELD_USD_PER_VIDEO_SECOND,
      brlPerUsd: env.BRL_PER_USD,
      fetch: fetchFn,
      noteShape,
    }),
    mptProvider({ baseUrl: env.MPT_BASE_URL, apiKey: env.MPT_API_KEY, fetch: fetchFn, noteShape }),
  ];
}

export const providerById = (providers: MediaProvider[], id: MediaProviderId) =>
  providers.find((provider) => provider.id === id);
