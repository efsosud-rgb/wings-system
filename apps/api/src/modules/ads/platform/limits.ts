import type { Cents } from './money.js';

/**
 * What a platform itself still allows us to spend.
 *
 * Our internal monthly cap is a policy. This is a fact: Meta stops delivering
 * at `spend_cap`, and a prepaid Google account stops when the balance runs
 * out. Where the two disagree, the platform wins — an internal cap above what
 * the platform permits is fiction, and one below it is the real ceiling.
 */
export interface PlatformSpendLimit {
  /** Total the platform allows; null when it sets no limit at all. */
  limitCents: Cents | null;
  /** Spent against that limit so far. */
  spentCents: Cents;
  /** Headroom the platform still allows; null when uncapped. */
  remainingCents: Cents | null;
  /** Which field this came from, recorded so a number is always traceable. */
  source: string;
}

export function limitFrom(
  limitCents: Cents | null,
  spentCents: Cents,
  source: string,
): PlatformSpendLimit {
  return {
    limitCents,
    spentCents,
    remainingCents: limitCents === null ? null : Math.max(0, limitCents - spentCents),
    source,
  };
}

/**
 * The platform limit when funding is prepaid: the balance itself IS the
 * headroom. `spend_cap − amount_spent` is a proxy that only happens to agree
 * with it on an account that never had its cap raised or lowered mid-month —
 * the balance is the fact, read straight from the platform, never derived.
 */
export function prepaidLimitFrom(
  prepaidBalanceCents: Cents | null,
  spentCents: Cents,
  source: string,
): PlatformSpendLimit {
  return {
    limitCents: prepaidBalanceCents === null ? null : prepaidBalanceCents + spentCents,
    spentCents,
    remainingCents: prepaidBalanceCents,
    source,
  };
}

/**
 * The effective ceiling: the smaller of what we allow and what the platform
 * allows. Null platform headroom means "no platform limit", not "zero".
 */
export function effectiveHeadroomCents(
  internalHeadroomCents: Cents,
  platformRemainingCents: Cents | null,
): Cents {
  if (platformRemainingCents === null) return Math.max(0, internalHeadroomCents);
  return Math.max(0, Math.min(internalHeadroomCents, platformRemainingCents));
}
