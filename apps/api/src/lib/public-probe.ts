import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * "Does this site answer?" for an address a lead typed into a form.
 *
 * The address is someone else's input, so the request must never reach our
 * own network (SSRF): only http/https on the standard ports, the name is
 * resolved and every address must be public, and the check runs again at
 * connect time (the `lookup` hook), so a name that changes its answer between
 * the check and the connection (DNS rebinding) is still refused. Redirects are
 * followed by hand, each hop checked the same way. Only the status line is
 * read; the body is dropped.
 */

export type ProbeResult =
  | { kind: 'ok'; status: number }
  | { kind: 'http_error'; status: number }
  | { kind: 'blocked' }
  | { kind: 'not_found' }
  | { kind: 'timeout' }
  | { kind: 'error' };

export type Probe = (url: string) => Promise<ProbeResult>;

const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 6000;
const USER_AGENT = 'Mozilla/5.0 (compatible; WingsSystem-LinkCheck/1.0)';

/** False for loopback, private, link-local, carrier-grade NAT, multicast and reserved ranges. */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return false;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    if (/^(fe[89ab]|fc|fd|ff)/.test(x)) return false;
    if (x.startsWith('64:ff9b:') || x.startsWith('2001:db8:')) return false;
    return true;
  }
  return false;
}

class Blocked extends Error {}
class NotFound extends Error {}

/** dns.lookup that refuses any non-public answer; used at connect time. */
export function guardedLookup(
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err.code === 'ENOTFOUND' ? new NotFound(hostname) : err, '');
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new Blocked(hostname), '');
    }
    const wantsAll =
      typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    if (wantsAll) return callback(null, addresses);
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
}

function allowed(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '80' && url.port !== '443') return false;
  // An address typed as an IP is checked like any resolved one.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPublicAddress(host);
  return host.includes('.') && !host.endsWith('.local') && !host.endsWith('.internal');
}

function once(
  url: URL,
  method: 'HEAD' | 'GET',
  deadline: number,
): Promise<{ status: number; location: string | null }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method,
        lookup: guardedLookup as unknown as typeof dnsLookup,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*;q=0.5' },
        timeout: Math.max(1, deadline - Date.now()),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location =
          typeof response.headers.location === 'string' ? response.headers.location : null;
        response.destroy();
        resolve({ status, location });
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

export const probePublicUrl: Probe = async (raw) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'error' };
  }
  const deadline = Date.now() + TIMEOUT_MS;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowed(url)) return { kind: 'blocked' };
    try {
      let answer = await once(url, 'HEAD', deadline);
      // Some servers refuse HEAD; a GET (body dropped) settles it.
      if (answer.status === 405 || answer.status === 501 || answer.status === 403) {
        answer = await once(url, 'GET', deadline);
      }
      if (answer.status >= 300 && answer.status < 400 && answer.location) {
        url = new URL(answer.location, url);
        continue;
      }
      if (answer.status >= 200 && answer.status < 400) return { kind: 'ok', status: answer.status };
      return { kind: 'http_error', status: answer.status };
    } catch (error) {
      if (error instanceof Blocked) return { kind: 'blocked' };
      if (error instanceof NotFound) return { kind: 'not_found' };
      if (error instanceof Error && error.message === 'timeout') return { kind: 'timeout' };
      if (Date.now() >= deadline) return { kind: 'timeout' };
      return { kind: 'error' };
    }
  }
  return { kind: 'error' };
};
