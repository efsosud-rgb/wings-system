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
 *
 * `readPublicPage` is the same guard for a page whose body is read (a company's
 * site, Prospecção): GET only, the body cut at a byte cap.
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
    const g = ipv6Groups(ip);
    if (!g) return false;
    const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const zeros = (n: number) => g.slice(0, n).every((group) => group === 0);
    const [first, second, third, , , sixth, seventh, eighth] = g as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    // An IPv4 inside an IPv6 is judged as that IPv4, whatever the spelling (the
    // URL parser turns `::ffff:169.254.169.254` into `::ffff:a9fe:a9fe`):
    // unspecified, loopback and compatible (::/96; `::` and `::1` read as
    // 0.0.0.0 and 0.0.0.1, refused), mapped (::ffff:0:0/96), translated
    // (::ffff:0:0:0/96) and 6to4 (2002::/16).
    if (zeros(6)) return isPublicAddress(v4(seventh, eighth));
    if (zeros(5) && sixth === 0xffff) return isPublicAddress(v4(seventh, eighth));
    if (zeros(4) && g[4] === 0xffff && sixth === 0) return isPublicAddress(v4(seventh, eighth));
    if (first === 0x2002) return isPublicAddress(v4(second, third));
    if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return false; // link/site-local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (first === 0x64 && second === 0xff9b) return false; // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
    if (first === 0x2001 && (second === 0xdb8 || second === 0)) return false; // documentation, Teredo
    if (first === 0x100 && second === 0 && third === 0 && g[3] === 0) return false; // discard 100::/64
    return true;
  }
  return false;
}

/** The eight 16-bit groups of an IPv6 address (`::` expanded, a dotted IPv4 tail as two groups). */
function ipv6Groups(ip: string): number[] | null {
  let x = ip.toLowerCase().replace(/%.*$/, '');
  const dotted = x.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    x = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = x.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
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
  // An address typed as an IP is checked like any resolved one. A final dot names the same host
  // ("postgres."), so it is dropped first: a bare internal name never passes.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
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
      return failureOf(error, deadline);
    }
  }
  return { kind: 'error' };
};

function failureOf(error: unknown, deadline: number): Exclude<ProbeResult, { kind: 'ok' }> {
  if (error instanceof Blocked) return { kind: 'blocked' };
  if (error instanceof NotFound) return { kind: 'not_found' };
  if (error instanceof Error && error.message === 'timeout') return { kind: 'timeout' };
  if (Date.now() >= deadline) return { kind: 'timeout' };
  return { kind: 'error' };
}

// --- reading a page -------------------------------------------------------------------

export type PageResult =
  | { kind: 'ok'; status: number; /** Where the redirects ended. */ url: string; body: string }
  /** `permits` said no to a hop. */
  | { kind: 'disallowed' }
  | Exclude<ProbeResult, { kind: 'ok' }>;

/** One GET, no redirect followed, the body read up to `maxBytes`; tests pass their own. */
export type PageTransport = (
  url: URL,
  limits: { maxBytes: number; deadline: number; userAgent: string },
) => Promise<{ status: number; location: string | null; body: string }>;

const requestPage: PageTransport = (url, { maxBytes, deadline, userAgent }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup as unknown as typeof dnsLookup,
        headers: { 'user-agent': userAgent, accept: 'text/html,text/plain,*/*;q=0.5' },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location =
          typeof response.headers.location === 'string' ? response.headers.location : null;
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => {
          clearTimeout(timer);
          resolve({ status, location, body: Buffer.concat(chunks).toString('utf8') });
        };
        if (status < 200 || status >= 300) {
          response.destroy();
          return done();
        }
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk.subarray(0, maxBytes - size));
          size += Math.min(chunk.length, maxBytes - size);
          // Past the cap: stop reading and keep what arrived.
          if (size >= maxBytes) {
            response.destroy();
            done();
          }
        });
        response.on('end', done);
        response.on('error', reject);
      },
    );
    // The whole page, not just an idle socket, must fit in the time.
    const timer = setTimeout(
      () => {
        request.destroy();
        reject(new Error('timeout'));
      },
      Math.max(1, deadline - Date.now()),
    );
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });

/**
 * GET a public page and read its body up to `maxBytes`, with the same guard as
 * `probePublicUrl`: every hop (at most 4 redirects) checked before it is asked,
 * and by `permits` too when given (robots.txt, for a reader that obeys it).
 */
export async function readPublicPage(
  raw: string,
  options: {
    maxBytes: number;
    timeoutMs: number;
    userAgent: string;
    transport?: PageTransport;
    permits?: (url: URL) => Promise<boolean>;
  },
): Promise<PageResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'error' };
  }
  const transport = options.transport ?? requestPage;
  const deadline = Date.now() + options.timeoutMs;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowed(url)) return { kind: 'blocked' };
    if (options.permits && !(await options.permits(url))) return { kind: 'disallowed' };
    try {
      const answer = await transport(url, {
        maxBytes: options.maxBytes,
        deadline,
        userAgent: options.userAgent,
      });
      if (answer.status >= 300 && answer.status < 400 && answer.location) {
        url = new URL(answer.location, url);
        continue;
      }
      if (answer.status >= 200 && answer.status < 300)
        return { kind: 'ok', status: answer.status, url: url.href, body: answer.body };
      return { kind: 'http_error', status: answer.status };
    } catch (error) {
      return failureOf(error, deadline);
    }
  }
  return { kind: 'error' };
}
