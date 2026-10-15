import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Cross-origin access for the public landing pages (apps/landing, docs/leads/formularios.md):
 * a page served from another host (LANDING_ORIGINS) reads and sends the site
 * form at `/public/*`. Nothing else is opened: every other path, and every
 * origin not listed, answers as before (the CSRF hook still refuses a foreign
 * Origin). No cookie travels: the answer never allows credentials.
 */

const PUBLIC_PREFIX = '/public/';

/** The only hosts an `http://` origin may name: this machine, for tests and the e2e. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export const LANDING_ORIGINS_RULE =
  'must be https:// origins (scheme and host, no path) separated by commas or spaces; http:// only for localhost, 127.0.0.1 or [::1]';

/**
 * Each entry of LANDING_ORIGINS as the browser sends it in `Origin`, or null
 * when it is not one: https, or http on this machine only.
 */
export function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) return null;
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return null;
    }
    return /[?#]$/.test(value) ? null : url.origin;
  } catch {
    return null;
  }
}

/** The exact origins LANDING_ORIGINS lists, separated by commas or spaces. */
export function landingOriginsOf(value: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of (value ?? '').split(/[\s,]+/)) {
    const origin = entry ? originOf(entry) : null;
    if (origin) origins.add(origin);
  }
  return origins;
}

/** The env rule (LANDING_ORIGINS_RULE): every entry is an origin, https unless local. */
export function isLandingOriginList(value: string): boolean {
  const entries = value.split(/[\s,]+/).filter(Boolean);
  return entries.length > 0 && entries.every((entry) => originOf(entry) !== null);
}

export type LandingCorsDecision =
  /** Not a cross-origin call to `/public/*`: nothing changes. */
  | { kind: 'none' }
  /** A preflight from an origin not listed. */
  | { kind: 'refuse' }
  /** A preflight from a listed origin: 204 with these headers. */
  | { kind: 'preflight'; headers: Record<string, string> }
  /** A call from a listed origin: the answer carries these headers. */
  | { kind: 'allow'; headers: Record<string, string> };

/** What the request gets, from its method, path (no query), Origin and the list. */
export function landingCorsOf(input: {
  method: string;
  path: string;
  origin: string | undefined;
  allowed: ReadonlySet<string>;
}): LandingCorsDecision {
  if (!input.origin || !input.path.startsWith(PUBLIC_PREFIX)) return { kind: 'none' };
  const listed = input.allowed.has(input.origin);
  const base = { 'Access-Control-Allow-Origin': input.origin, Vary: 'Origin' };
  if (input.method === 'OPTIONS') {
    return listed
      ? {
          kind: 'preflight',
          headers: {
            ...base,
            'Access-Control-Allow-Methods': 'GET, POST',
            'Access-Control-Allow-Headers': 'content-type',
            'Access-Control-Max-Age': '600',
          },
        }
      : { kind: 'refuse' };
  }
  return listed ? { kind: 'allow', headers: base } : { kind: 'none' };
}

/**
 * The path the decision is made on: the matched route's pattern when there is
 * one (so only real `/public/*` routes are opened), else the address without
 * its query (a preflight has no route of its own).
 */
export function corsPathOf(request: FastifyRequest): string {
  return request.routeOptions.url ?? request.url.split('?')[0] ?? '';
}

/** A POST to `/public/*` from a listed origin: the one foreign Origin the CSRF hook lets through. */
export function isLandingPost(request: FastifyRequest, allowed: ReadonlySet<string>): boolean {
  return (
    request.method === 'POST' &&
    landingCorsOf({
      method: request.method,
      path: corsPathOf(request),
      origin: request.headers.origin,
      allowed,
    }).kind === 'allow'
  );
}

/**
 * Registered before the CSRF hook. Answers the preflight itself (no OPTIONS
 * route exists, so the route-access declaration is not involved) and adds the
 * CORS headers to the real answer, errors and rate limits included.
 */
export function installLandingCors(app: FastifyInstance, allowed: ReadonlySet<string>): void {
  app.addHook('onRequest', async (request, reply) => {
    const decision = landingCorsOf({
      method: request.method,
      path: corsPathOf(request),
      origin: request.headers.origin,
      allowed,
    });
    if (decision.kind === 'refuse') {
      return reply.status(403).send({ error: 'bad_origin', message: 'Origem inválida' });
    }
    if (decision.kind === 'none') return;
    reply.headers(decision.headers);
    if (decision.kind === 'preflight') return reply.status(204).send();
  });
}
