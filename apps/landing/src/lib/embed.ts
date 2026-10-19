import type { Tracking } from './tracking.js';

/**
 * The form embedded in the Wings site (`/embed/formulario`, an iframe on
 * wingscompany.com.br): what the site passes in the address, where the page
 * talks to the site that frames it, and how its leads are marked.
 */

/** The only origins that may frame the form and hear its messages (frame-ancestors in docker/landing-nginx.conf). */
export const SITE_ORIGINS = ['https://wingscompany.com.br', 'https://www.wingscompany.com.br'];

/** What the lead's record says about where the form was: the site's home. */
export const HOME_SOURCE = 'site';
export const HOME_MEDIUM = 'formulario-home';

/** The messages to the site (`window.parent.postMessage`); the site's listener reads `tipo`. */
export const LEAD_MESSAGE = { tipo: 'wings-lead', origem: 'site-home' } as const;
export const heightMessageOf = (altura: number) => ({ tipo: 'wings-form-altura', altura });

export interface EmbedOptions {
  /** `titulo=1`: show the form's title and subtitle (the site has its own text by default). */
  title: boolean;
  /** `ref`: the visitor's own referrer, as the site saw it; '' when none. */
  referrer: string;
  /** `pagina`: the address of the site's page that holds the form; null unless it is the Wings site's. */
  page: string | null;
}

const ADDRESS_MAX = 2000;

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

const isHttp = (value: string) => /^https?:\/\//i.test(value) && originOf(value) !== '';

export function embedOptionsOf(search: string): EmbedOptions {
  const query = new URLSearchParams(search);
  const ref = (query.get('ref') ?? '').trim();
  const page = (query.get('pagina') ?? '').trim().slice(0, ADDRESS_MAX);
  return {
    title: query.get('titulo') === '1',
    referrer: isHttp(ref) ? ref : '',
    page: SITE_ORIGINS.includes(originOf(page)) ? page : null,
  };
}

/**
 * Where to post to the site: the one origin that frames the page when the
 * browser says so (`ancestorOrigins`, else the referrer), else both site
 * origins. Never "*": a message to any other origin is dropped by the browser.
 */
export function parentTargetsOf(ancestorOrigin: string | undefined, referrer: string): string[] {
  const known = [ancestorOrigin ?? '', originOf(referrer)].find((origin) =>
    SITE_ORIGINS.includes(origin),
  );
  return known ? [known] : [...SITE_ORIGINS];
}

/**
 * A visit with no source of its own (no utm_source, no click id) is the home's:
 * `utm_source=site`, `utm_medium=formulario-home`. A visit that came by an ad or
 * a campaign link keeps its own, so paid attribution is never overwritten.
 */
export function withHomeSource(tracking: Tracking): Tracking {
  const sourced = [
    tracking.utm_source,
    tracking.gclid,
    tracking.fbclid,
    tracking.gbraid,
    tracking.wbraid,
  ].some(Boolean);
  return sourced ? tracking : { ...tracking, utm_source: HOME_SOURCE, utm_medium: HOME_MEDIUM };
}
