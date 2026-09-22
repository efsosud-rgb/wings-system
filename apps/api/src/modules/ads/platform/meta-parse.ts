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

/**
 * The sum of an insights action list such as `video_thruplay_watched_actions`:
 * `[{ action_type: 'video_view', value: '12' }]`. Absent or malformed is zero,
 * because these fields are only present on entities that played video.
 */
export function sumActionValues(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let total = 0;
  for (const entry of value as { value?: unknown }[]) {
    const parsed = Number(entry?.value ?? 0);
    if (Number.isFinite(parsed)) total += parsed;
  }
  return Math.round(total);
}

/**
 * Meta's `funding_source_details.type`, as far as the numbering is documented:
 * card and invoice accounts pay afterwards; the prepaid kinds hold a balance.
 * Anything else is `unknown`, never guessed. NOT verified against the live
 * account: the type it reports is recorded on `ad_account_daily.funding_kind`
 * for the day somebody checks.
 */
export function fundingKindOf(type: unknown): string {
  const code = Number(type);
  if (!Number.isFinite(code)) return 'unknown';
  if (code === 1 || code === 14) return 'credit_card';
  if (code === 6 || code === 4) return 'invoice';
  if (code === 2 || code === 3 || code === 7 || code === 15 || code === 20) return 'prepaid';
  return `meta:${code}`;
}

/**
 * The prepaid balance Meta prints in `funding_source_details.display_string`
 * ("Saldo pré-pago: R$ 1.234,56", "Prepaid balance: $1,234.56"). Meta has no
 * numeric field for it, so the amount is read from the text, and only when the
 * text says it is a balance. Null otherwise. NOT verified live.
 */
export function prepaidBalanceFromDisplay(display: unknown): Cents | null {
  if (typeof display !== 'string' || !/pr[eé]-?pa|saldo|balance/i.test(display)) return null;
  const start = display.search(/\d/);
  if (start === -1) return null;
  const raw = /^\d[\d.,]*\d|^\d/.exec(display.slice(start))?.[0];
  if (!raw) return null;
  // Two digits after the last separator are the cents; every other separator groups thousands.
  const fraction = /[.,](\d{2})$/.exec(raw)?.[1];
  const whole = (fraction ? raw.slice(0, -3) : raw).replace(/[.,]/g, '');
  const cents = Number(whole) * 100 + Number(fraction ?? '0');
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * What a creative is made of, from the fields Meta exposes on it. A video
 * story or a VIDEO object type is a video; a link story with several child
 * attachments is a carousel; a photo, an image story or a single-link story
 * is an image. Anything else is unknown: the format is a grouping key for the
 * creative ranking and a wrong guess would file spend under the wrong row.
 */
export function creativeFormatOf(creative: {
  object_type?: string;
  object_story_spec?: {
    video_data?: unknown;
    photo_data?: unknown;
    link_data?: { child_attachments?: unknown[]; picture?: string; image_hash?: string };
  };
  asset_feed_spec?: { videos?: unknown[]; images?: unknown[] };
}): 'image' | 'video' | 'carousel' | 'unknown' {
  const story = creative.object_story_spec;
  if (creative.object_type === 'VIDEO' || story?.video_data) return 'video';
  if ((story?.link_data?.child_attachments?.length ?? 0) > 1) return 'carousel';
  if (creative.object_type === 'PHOTO' || story?.photo_data) return 'image';
  if (story?.link_data?.picture || story?.link_data?.image_hash) return 'image';
  const feed = creative.asset_feed_spec;
  if (feed?.videos?.length) return 'video';
  if (feed?.images?.length) return 'image';
  return 'unknown';
}
