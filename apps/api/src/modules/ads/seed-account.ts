import type { Database } from '../../db/client.js';
import { openPeriod } from './budget-guard.js';
import { ensureAdAccount } from './metrics.js';
import { periodMonthOf } from './reconcile.js';

/** Platforms the ingestion job can actually read. TikTok has no client yet. */
export const SEEDABLE_PLATFORMS = ['meta', 'google'] as const;
export type SeedablePlatform = (typeof SEEDABLE_PLATFORMS)[number];

export interface SeedAccountInput {
  /** Defaults to `meta`, which is what `--seed` always meant. */
  platform?: string;
  account?: string;
  name?: string;
  /** Internal monthly cap, in cents. */
  cap?: string;
  /** Share of the cap that may be planned, 1–100. */
  usable?: string;
}

export interface SeededAccount {
  accountId: string;
  platform: SeedablePlatform;
  externalId: string;
  name: string;
  capCents: number;
  usablePercent: number;
  periodMonth: string;
}

const DEFAULT_CAP_CENTS = 400_000;
const DEFAULT_USABLE_PERCENT = 70;

const digitsOnly = (value: string): string => value.replace(/-/g, '');

/**
 * Creates (or renames) the account row and opens this month's budget period —
 * what `ingest-cli --seed` runs before the first ingestion.
 *
 * A Google row only makes sense for the customer the environment is
 * credentialed for: the Google client reads `GOOGLE_ADS_CUSTOMER_ID` and
 * nothing else, so a row for any other customer would be filed with that
 * account's spending limit. Same shape as the Meta bug in tetos-reais.md.
 */
export async function seedAdAccount(
  db: Database,
  env: { META_WRITE_ACCOUNT_ID?: string; GOOGLE_ADS_CUSTOMER_ID?: string },
  input: SeedAccountInput,
  now = new Date(),
): Promise<SeededAccount> {
  const platform = (input.platform ?? 'meta') as SeedablePlatform;
  if (!SEEDABLE_PLATFORMS.includes(platform)) {
    throw new Error(`--platform must be one of: ${SEEDABLE_PLATFORMS.join(', ')}`);
  }

  const capCents = input.cap === undefined ? DEFAULT_CAP_CENTS : Number(input.cap);
  if (!Number.isInteger(capCents) || capCents <= 0) {
    throw new Error('--cap must be a positive whole number of cents (R$ 2.500 is 250000)');
  }
  const usablePercent = input.usable === undefined ? DEFAULT_USABLE_PERCENT : Number(input.usable);
  if (!Number.isInteger(usablePercent) || usablePercent < 1 || usablePercent > 100) {
    throw new Error('--usable must be a whole percentage between 1 and 100');
  }

  let externalId: string;
  let name: string;
  if (platform === 'google') {
    if (!input.account) throw new Error('--account <customer id> is required for google');
    externalId = digitsOnly(input.account);
    if (!/^\d{10}$/.test(externalId)) {
      throw new Error('a Google Ads customer id has 10 digits (dashes are ignored)');
    }
    const configured = env.GOOGLE_ADS_CUSTOMER_ID && digitsOnly(env.GOOGLE_ADS_CUSTOMER_ID);
    if (configured !== externalId) {
      throw new Error(
        'this environment is not credentialed for that Google Ads customer: ' +
          '--account must match GOOGLE_ADS_CUSTOMER_ID, the only account the client reads',
      );
    }
    if (!input.name) throw new Error('--name "…" is required for google');
    name = input.name;
  } else {
    externalId = input.account ?? env.META_WRITE_ACCOUNT_ID ?? '';
    if (!externalId) throw new Error('--account act_… is required when seeding');
    name = input.name ?? 'Wings Matriz';
  }

  const accountId = await ensureAdAccount(db, { platform, externalId, name });
  const periodMonth = periodMonthOf(now);
  await openPeriod(db, { adAccountId: accountId, periodMonth, capCents, usablePercent });

  return { accountId, platform, externalId, name, capCents, usablePercent, periodMonth };
}
