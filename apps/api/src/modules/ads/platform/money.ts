/**
 * Money handling for paid traffic.
 *
 * Everything internal is integer **cents of BRL**. Floats never touch money.
 *
 * Meta's documentation is contradictory about units: the ad-account reference
 * describes `spend_cap` in whole currency units ("23.50"), while the campaign
 * reference and field guides describe it as an integer in the currency's
 * subunit. Getting this wrong means a 100x error in either direction, so:
 *   - conversion happens only at the platform boundary, never in business code;
 *   - every outbound amount passes a plausibility check first;
 *   - Stage 3 verifies the real units read-only against a live account before
 *     any write is ever attempted.
 */

export type Cents = number;

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function assertCents(value: number, label = 'amount'): Cents {
  if (!isCents(value)) {
    throw new Error(`${label} must be a non-negative integer in cents, got ${String(value)}`);
  }
  return value;
}

export function formatBrl(cents: Cents): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Last-ditch guard against unit mistakes and runaway values.
 *
 * Any amount sent to an ad platform must be inside a sane window relative to
 * the monthly cap. A 100x unit error, a misplaced decimal or a corrupted
 * agent proposal fails here rather than at the platform.
 */
export interface PlausibilityLimits {
  /** Monthly cap for the account, in cents. */
  monthlyCapCents: Cents;
  /** Smallest amount worth sending; below this it is almost certainly a bug. */
  minCents?: Cents;
}

export function assertPlausibleAmount(
  amountCents: number,
  limits: PlausibilityLimits,
  label = 'amount',
): Cents {
  const amount = assertCents(amountCents, label);
  const min = limits.minCents ?? 100; // R$1,00
  if (amount < min) {
    throw new Error(
      `${label} of ${formatBrl(amount)} is below the minimum of ${formatBrl(min)} — likely a unit error`,
    );
  }
  if (amount > limits.monthlyCapCents) {
    throw new Error(
      `${label} of ${formatBrl(amount)} exceeds the monthly cap of ${formatBrl(limits.monthlyCapCents)} — refusing to send`,
    );
  }
  return amount;
}
