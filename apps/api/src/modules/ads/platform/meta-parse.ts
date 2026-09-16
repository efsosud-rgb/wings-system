import type { Cents } from './money.js';

/**
 * Parsing Meta's money fields.
 *
 * Meta mixes two representations, and confusing them is a 100x error:
 *   - budgets and `spend_cap`  → integer **cents** as a string: "5000"
 *   - Insights `spend`         → decimal **reais** as a string: "48.71"
 *
 * Each conversion is a separate, explicitly named function so a call site can
 * never quietly use the wrong one, and both reject anything malformed instead
 * of coercing it to a number that looks plausible.
 */

export function centsFromMinorUnitString(value: unknown, field: string): Cents {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${field}: expected an integer string in cents, got ${JSON.stringify(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field}: value out of safe range`);
  return parsed;
}

export function centsFromDecimalCurrencyString(value: unknown, field: string): Cents {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new Error(
      `${field}: expected a decimal currency string like "48.71", got ${JSON.stringify(value)}`,
    );
  }
  const [whole = '0', fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`${field}: value out of safe range`);
  return cents;
}

/** `spend_cap` of "0" means "no cap", not "a cap of zero". */
export function spendCapFromString(value: unknown): Cents | null {
  const cents = centsFromMinorUnitString(value, 'spend_cap');
  return cents === 0 ? null : cents;
}
