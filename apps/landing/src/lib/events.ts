import { formUrlOf } from './api.js';
import type { Tracking } from './tracking.js';

/**
 * What the visitor does, counted on the server: one small beacon per step to
 * the API's `POST /public/site-forms/:slug/events` (apps/api leads
 * site-events.ts), beside the dataLayer events the GTM reads. Nothing
 * personal travels: the event, its step, the ad's UTMs and a random id of this
 * visit kept in sessionStorage only (no cookie). A beacon is never awaited and
 * never in the form's way: one that fails is lost and the page goes on.
 *
 * The names are the API's (`SITE_EVENT_NAMES`, `SITE_EVENT_STEPS` and
 * `SITE_EVENT_UTM_KEYS` in @wings/shared), copied here so the page does not
 * bundle the shared package; events.test.ts checks they are equal.
 */
export const EVENT_NAMES = [
  'page_view',
  'form_view',
  'form_start',
  'submit_attempt',
  'submit_error',
  'submit_ok',
  'whatsapp_click',
] as const;
export const EVENT_STEPS = [
  'header',
  'final',
  'thanks',
  'validation',
  'captcha',
  'network',
  'rate_limited',
] as const;
export const EVENT_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const;

export type EventName = (typeof EVENT_NAMES)[number];
export type EventStep = (typeof EVENT_STEPS)[number];
type EventUtmKey = (typeof EVENT_UTM_KEYS)[number];

/** The API's limit for each UTM. */
export const EVENT_UTM_MAX = 100;
export const VISIT_STORAGE_KEY = 'wings_visit';
const VISIT_ID = /^[a-z0-9]{8,32}$/;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export type EventBody = { event: EventName; step?: EventStep; visit: string } & Partial<
  Record<EventUtmKey, string>
>;

export const eventsUrlOf = (apiBase: string, slug: string): string =>
  `${formUrlOf(apiBase, slug)}/events`;

/** 24 hex characters from the browser's random source; a browser without one gets a weaker id, never a broken page. */
export function randomVisitId(): string {
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  }
}

/** This tab's visit id: the one kept in sessionStorage, else a new one kept there (when it can be). */
export function visitIdOf(
  storage: StorageLike | null,
  random: () => string = randomVisitId,
): string {
  try {
    const kept = storage?.getItem(VISIT_STORAGE_KEY);
    if (kept && VISIT_ID.test(kept)) return kept;
  } catch {
    // no storage in this browser
  }
  let id: string;
  try {
    id = random();
  } catch {
    id = randomVisitId();
  }
  try {
    storage?.setItem(VISIT_STORAGE_KEY, id);
  } catch {
    // no storage: the id lives for this page load only
  }
  return id;
}

/** The body one event sends: only the four UTMs of the origin, cut to the API's limit; never a click id or the referrer. */
export function eventBodyOf(
  event: EventName,
  step: EventStep | undefined,
  visit: string,
  origin: Tracking,
): EventBody {
  const body: EventBody = { event, visit };
  if (step) body.step = step;
  for (const key of EVENT_UTM_KEYS) {
    const value = origin[key];
    if (value) body[key] = value.slice(0, EVENT_UTM_MAX);
  }
  return body;
}

/** `navigator.sendBeacon`'s shape: true when the browser queued the beacon. */
export type Beacon = (url: string, body: string) => boolean;

/** The browser's beacon, or null in a browser without one (then no event is counted). */
export function browserBeacon(nav: Navigator = navigator): Beacon | null {
  return typeof nav.sendBeacon === 'function' ? (url, body) => nav.sendBeacon(url, body) : null;
}

/**
 * The page's sender: `send('form_start')`, `send('whatsapp_click', 'header')`.
 * Says whether the beacon was queued; never throws, never waits.
 */
export function eventSender(input: {
  apiBase: string;
  slug: string;
  visit: string;
  origin: () => Tracking;
  beacon: Beacon | null;
}): (event: EventName, step?: EventStep) => boolean {
  const url = eventsUrlOf(input.apiBase, input.slug);
  return (event, step) => {
    if (!input.beacon) return false;
    try {
      return input.beacon(
        url,
        JSON.stringify(eventBodyOf(event, step, input.visit, input.origin())),
      );
    } catch {
      return false;
    }
  };
}
