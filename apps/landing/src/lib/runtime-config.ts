/**
 * The settings one built image takes from where it runs. nginx writes them
 * into the page's <meta> tags at request time (sub_filter of the
 * `__LANDING_*__` placeholders, docker/landing-nginx.conf); a page served
 * without nginx (vite dev or preview) still holds the placeholders and falls
 * back to the defaults.
 */
export const API_BASE_META = 'wings:api-base';
export const GTM_ID_META = 'wings:gtm-id';

export interface RuntimeConfig {
  /** Where the API answers, ending before `/public/...` (e.g. https://wingssystem.online/api). */
  apiBase: string;
  /** The Google Tag Manager container, or null to load no tag at all. */
  gtmId: string | null;
}

const PLACEHOLDER = /^__LANDING_[A-Z_]+__$/;
const GTM_ID = /^GTM-[A-Z0-9]{4,12}$/;

function filled(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed && !PLACEHOLDER.test(trimmed) ? trimmed : null;
}

/** An absolute http(s) address or a path on this host; anything else takes the fallback. */
export function apiBaseOf(value: string | null | undefined, fallback: string): string {
  const given = filled(value);
  if (!given) return fallback;
  if (given.startsWith('/') && !given.startsWith('//')) return given.replace(/\/+$/, '');
  try {
    const url = new URL(given);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return fallback;
    if (url.search || url.hash) return fallback;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

/** `GTM-XXXX`, or null when empty, a placeholder or anything else. */
export function gtmIdOf(value: string | null | undefined): string | null {
  const given = filled(value)?.toUpperCase() ?? null;
  return given && GTM_ID.test(given) ? given : null;
}

export function readRuntimeConfig(
  doc: Pick<Document, 'querySelector'>,
  fallbackApiBase: string,
): RuntimeConfig {
  const meta = (name: string) =>
    doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null;
  return {
    apiBase: apiBaseOf(meta(API_BASE_META), fallbackApiBase),
    gtmId: gtmIdOf(meta(GTM_ID_META)),
  };
}
