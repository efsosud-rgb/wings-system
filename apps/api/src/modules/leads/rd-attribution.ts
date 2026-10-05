import { paramsOfAddress } from '../../lib/query-params.js';
import type { LeadAttribution } from './service.js';

/**
 * The attribution (spec §1.4) an RD Station conversion carries, read from, in
 * this order, the first place that has each key:
 *
 *  1. the form's own fields: hidden `utm_*` / click-id fields a landing page
 *     fills from the address (as `utm_source` or RD's `cf_utm_source`);
 *  2. the query string of the page the form was sent from;
 *  3. RD's `traffic_source` ("encoded_" + base64 of the current and the first
 *     session, each with its landing URL and `extra_params`), the format read
 *     live from contact events on 2026-09-28 (`expansion/rd.ts`).
 *
 * Only UTMs, click ids and numeric ad ids come out; nothing personal. NOT
 * verified live on a webhook delivery: whether RD puts `traffic_source` and the
 * hidden fields in `last_conversion.content` there too is what the shape log
 * of the first delivery answers.
 */

const UTM_KEYS = ['source', 'medium', 'campaign', 'content', 'term'] as const;
const CLICK_KEYS = ['gclid', 'fbclid', 'gbraid', 'wbraid'] as const;

/** URL parameters that carry an ad platform's own ids (Meta URL params, Google ValueTrack and auto-tagging). */
const CAMPAIGN_ID_KEYS = ['campaign_id', 'campaignid', 'gad_campaignid', 'hsa_cam'];
const AD_SET_ID_KEYS = ['adset_id', 'ad_set_id', 'adgroupid', 'adgroup_id', 'hsa_grp'];
const AD_ID_KEYS = ['ad_id', 'creative', 'hsa_ad'];

type Params = Map<string, string>;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : null;

/** Adds the keys `params` does not have yet (the first source of a key wins). */
function merge(into: Params, entries: Iterable<[string, unknown]>) {
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.toLowerCase().replace(/^cf_/, '');
    const value = text(rawValue);
    if (value && !into.has(key)) into.set(key, value);
  }
}

function queryOf(url: string | null): [string, string][] {
  return [...paramsOfAddress(url)];
}

interface Session {
  value?: unknown;
  referrer?: unknown;
  extra_params?: Record<string, unknown>;
}

function sessionsOf(trafficSource: string | null): Session[] {
  if (!trafficSource) return [];
  try {
    const raw = trafficSource.startsWith('encoded_') ? trafficSource.slice(8) : trafficSource;
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as {
      current_session?: Session;
      first_session?: Session;
    };
    return [decoded.current_session, decoded.first_session].filter((session): session is Session =>
      Boolean(session && typeof session === 'object'),
    );
  } catch {
    return [];
  }
}

/** Origin and path of an address, never its query string; null when not one ("(direct)" and the like). */
function pageOf(value: string | null): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

const idOf = (params: Params, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = params.get(key);
    // Unfilled templates ("{{ad.id}}") and anything else that is not an id stay out.
    if (value && /^\d{3,30}$/.test(value)) return value;
  }
  return null;
};

export function rdAttributionOf(input: {
  content: Record<string, unknown>;
  url: string | null;
  trafficSource: string | null;
}): LeadAttribution | null {
  const params: Params = new Map();
  merge(params, Object.entries(input.content));
  merge(params, queryOf(input.url));
  for (const session of sessionsOf(input.trafficSource)) {
    merge(params, queryOf(text(session.value)));
    merge(params, Object.entries(session.extra_params ?? {}));
    if (!params.has('referrer') && text(session.referrer)) {
      params.set('referrer', text(session.referrer) as string);
    }
  }

  const utm = Object.fromEntries(UTM_KEYS.map((key) => [key, params.get(`utm_${key}`) ?? null]));
  const click = Object.fromEntries(CLICK_KEYS.map((key) => [key, params.get(key) ?? null]));
  const source = (utm.source ?? '').toLowerCase();
  const adPlatform =
    click.gclid || click.gbraid || click.wbraid || /google|adwords|gads/.test(source)
      ? 'google'
      : click.fbclid || /facebook|instagram|meta|^fb$|^ig$/.test(source)
        ? 'meta'
        : null;
  const referrer = pageOf(params.get('referrer') ?? null);

  const attribution: LeadAttribution = {
    utmSource: utm.source,
    utmMedium: utm.medium,
    utmCampaign: utm.campaign,
    utmContent: utm.content,
    utmTerm: utm.term,
    gclid: click.gclid,
    fbclid: click.fbclid,
    gbraid: click.gbraid,
    wbraid: click.wbraid,
    adPlatform,
    adCampaignExternalId: idOf(params, CAMPAIGN_ID_KEYS),
    adSetExternalId: idOf(params, AD_SET_ID_KEYS),
    adExternalId: idOf(params, AD_ID_KEYS),
    referrer,
  };
  return Object.values(attribution).some((value) => value !== null) ? attribution : null;
}
