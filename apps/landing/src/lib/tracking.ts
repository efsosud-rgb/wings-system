/**
 * The lead's origin the page sends with the form and puts in the dataLayer:
 * the UTMs, click ids and ad ids of the address, the first touch kept in this
 * browser (`wings_ft` in localStorage) and the referrer.
 *
 * The keys are the API's, `SITE_FORM_TRACKING_KEYS` in @wings/shared: the
 * POST rejects any other key. The list is copied here so the page does not
 * bundle the shared package (and zod); tracking.test.ts checks both are equal.
 */
export const TRACKING_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'fbclid',
  'gbraid',
  'wbraid',
  'campaign_id',
  'campaignid',
  'gad_campaignid',
  'adset_id',
  'adgroupid',
  'ad_id',
  'creative',
  'hsa_cam',
  'hsa_grp',
  'hsa_ad',
  'referrer',
] as const;

export type TrackingKey = (typeof TRACKING_KEYS)[number];
/** `utm_id` (Meta's campaign id) is read and kept for the server events only; the form's POST refuses it. */
export type OriginKey = TrackingKey | 'utm_id';
export type Tracking = Partial<Record<OriginKey, string>>;

/** The keys read from the address; the referrer comes from the document. */
export const URL_TRACKING_KEYS: readonly OriginKey[] = [
  ...TRACKING_KEYS.filter((key) => key !== 'referrer'),
  'utm_id',
];

export const FIRST_TOUCH_STORAGE_KEY = 'wings_ft';

/** The API's limit for each value. */
export const TRACKING_VALUE_MAX = 500;

const KNOWN = new Set<string>(URL_TRACKING_KEYS);

/** The first touch as stored: the address keys plus when it was kept. */
export type FirstTouch = Tracking & { ts?: number };

export interface Origin {
  /** This visit's address keys. */
  now: Tracking;
  /** The first visit's, kept in this browser; null when none was kept. */
  first: FirstTouch | null;
  referrer: string;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** The tracking keys of a query string (`?utm_source=…`). */
export function trackingOfSearch(search: string): Tracking {
  const query = new URLSearchParams(search);
  const found: Tracking = {};
  for (const key of URL_TRACKING_KEYS) {
    const value = query.get(key);
    if (value) found[key] = value.slice(0, TRACKING_VALUE_MAX);
  }
  return found;
}

/** The stored first touch, keeping only known keys; null when absent or unreadable. */
export function firstTouchOf(raw: string | null): FirstTouch | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || 'null');
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const kept: FirstTouch = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === 'ts' && typeof value === 'number') kept.ts = value;
    else if (KNOWN.has(key) && typeof value === 'string' && value) {
      kept[key as OriginKey] = value.slice(0, TRACKING_VALUE_MAX);
    }
  }
  return Object.keys(kept).some((key) => key !== 'ts') ? kept : null;
}

/**
 * This visit's origin. The first visit that arrives with any key is stored as
 * the first touch and never overwritten (the approved page's rule).
 */
export function captureOrigin(
  search: string,
  referrer: string,
  storage: StorageLike | null,
  now: () => number = Date.now,
): Origin {
  const current = trackingOfSearch(search);
  let stored: string | null = null;
  try {
    stored = storage?.getItem(FIRST_TOUCH_STORAGE_KEY) ?? null;
  } catch {
    // no storage in this browser
  }
  let first = firstTouchOf(stored);
  if (!first && Object.keys(current).length) {
    first = { ts: now(), ...current };
    try {
      storage?.setItem(FIRST_TOUCH_STORAGE_KEY, JSON.stringify(first));
    } catch {
      // no storage in this browser: the first touch lives for this visit only
    }
  }
  return { now: current, first, referrer: referrer.slice(0, TRACKING_VALUE_MAX) };
}

/** What the POST sends: the first touch, this visit's keys over it, and the referrer. */
export function trackingPayloadOf(origin: Origin): Tracking {
  const merged: Record<string, unknown> = {
    ...(origin.first ?? {}),
    ...origin.now,
    ...(origin.referrer ? { referrer: origin.referrer } : {}),
  };
  const payload: Tracking = {};
  for (const key of TRACKING_KEYS) {
    const value = merged[key];
    if (typeof value === 'string' && value) payload[key] = value.slice(0, TRACKING_VALUE_MAX);
  }
  return payload;
}

/** The `origem` the dataLayer events carry: the first touch, else this visit's keys. */
export function dataLayerOriginOf(origin: Origin): Tracking | FirstTouch {
  return origin.first ?? origin.now;
}
