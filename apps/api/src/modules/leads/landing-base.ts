import { FRANCHISE_LP_HOST, LANDING_PAGE_BASE_URL, normalizeSourcePattern } from '@wings/shared';

/**
 * Where new landing pages live (LANDING_PAGE_BASE_URL, set once at startup):
 * franquia.wingscompany.com.br, RD Station's, by default. A new rule's address
 * is `<base>/<slug>`; the rules made before keep the address they were made
 * with. A conversion's first path segment is read as the slug on the old host
 * and on the configured one, so a page keeps mapping while it moves.
 */
let baseUrl: string = LANDING_PAGE_BASE_URL;
let franchiseHosts: readonly string[] = [FRANCHISE_LP_HOST];

/** `undefined` is the default: every call sets both values, so nothing leaks between apps. */
export function configureLandingBase(url: string | undefined): void {
  baseUrl = url ? new URL(url).origin : LANDING_PAGE_BASE_URL;
  franchiseHosts = [...new Set([FRANCHISE_LP_HOST, normalizeSourcePattern(new URL(baseUrl).host)])];
}

export function landingPageBaseUrl(): string {
  return baseUrl;
}

export function franchiseLpHosts(): readonly string[] {
  return franchiseHosts;
}

/** The env rule: an https origin, nothing after the host (no path, query or fragment). */
export function isLandingBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !/[?#]$/.test(value)
    );
  } catch {
    return false;
  }
}
