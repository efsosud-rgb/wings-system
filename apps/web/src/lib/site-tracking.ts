import { SITE_FORM_TRACKING_KEYS, type SiteFormTrackingKey } from '@wings/shared';

/**
 * The invisible origin of a site-form lead (CRM phase 1, T5): the UTMs, click
 * ids and ad ids of the address the person FIRST arrived by, kept in a
 * first-party cookie so a later visit without them does not erase the first
 * touch. Only those keys and the external referrer are kept; nothing typed.
 */

export const FIRST_TOUCH_COOKIE = 'wings_ft';
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export type Tracking = Partial<Record<SiteFormTrackingKey, string>>;

const KEYS = new Set<string>(SITE_FORM_TRACKING_KEYS);

/** The tracking keys of an address's query string. */
export function trackingOfUrl(href: string): Tracking {
  const found: Tracking = {};
  try {
    for (const [rawKey, value] of new URL(href).searchParams) {
      const key = rawKey.toLowerCase();
      if (KEYS.has(key) && key !== 'referrer' && value.trim()) {
        found[key as SiteFormTrackingKey] = value.trim().slice(0, 500);
      }
    }
  } catch {
    // not an address: nothing to keep
  }
  return found;
}

export function readFirstTouch(cookie: string): Tracking | null {
  const raw = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${FIRST_TOUCH_COOKIE}=`));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      decodeURIComponent(raw.slice(FIRST_TOUCH_COOKIE.length + 1)),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const kept: Tracking = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (KEYS.has(key) && typeof value === 'string') kept[key as SiteFormTrackingKey] = value;
    }
    return kept;
  } catch {
    return null;
  }
}

/**
 * The first touch: the cookie's, when there is one; else this visit's address
 * and referrer (another site's only), which then become the cookie.
 */
export function captureFirstTouch(
  doc: Pick<Document, 'cookie' | 'referrer'>,
  href: string,
): Tracking {
  const existing = readFirstTouch(doc.cookie);
  if (existing) return existing;
  const tracking = trackingOfUrl(href);
  try {
    const referrer = doc.referrer ? new URL(doc.referrer) : null;
    if (referrer && referrer.host !== new URL(href).host) {
      tracking.referrer = `${referrer.origin}${referrer.pathname}`.slice(0, 500);
    }
  } catch {
    // no usable referrer
  }
  doc.cookie = `${FIRST_TOUCH_COOKIE}=${encodeURIComponent(JSON.stringify(tracking))}; Max-Age=${MAX_AGE_SECONDS}; Path=/; SameSite=Lax${href.startsWith('https:') ? '; Secure' : ''}`;
  return tracking;
}
