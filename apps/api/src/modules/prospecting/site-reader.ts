import type { ProspectEnrichmentKey } from '@wings/shared';
import { readPublicPage, type PageResult, type PageTransport } from '../../lib/public-probe.js';

/**
 * Enriquecer (docs/crm/prospeccao.md): the company's own site, read on the
 * seller's click, one prospect at a time. At most two pages (the one Google
 * listed and one contact page linked from it), robots.txt obeyed, every
 * request through the SSRF guard of `public-probe.ts`. What comes back is the
 * first Instagram, Facebook, LinkedIn, WhatsApp link and e-mail found; the
 * pages and the URL are not kept.
 */

const USER_AGENT = 'WingsSystem-Prospeccao/1.0';
const ROBOTS_AGENT = 'wingssystem-prospeccao';
const PAGE_MAX_BYTES = 1_000_000;
const ROBOTS_MAX_BYTES = 100_000;
/** Each rule costs up to its length times the path's, so a longer (hostile) path is not tried. */
const ROBOTS_MAX_PATH = 512;
const TIMEOUT_MS = 5_000;

export type FoundContacts = Partial<Record<ProspectEnrichmentKey, string>>;

export interface SiteReading {
  found: FoundContacts;
  pagesRead: number;
  /** Why a page was not read, in Portuguese. */
  skipped: string[];
}

// --- robots.txt -------------------------------------------------------------------------

interface RobotsRule {
  allow: boolean;
  path: string;
}

/**
 * Whether robots.txt lets our agent read `path` (path + query). The group naming
 * `wingssystem-prospeccao` wins over `*`; the longest matching rule decides, an
 * Allow winning a tie; an empty Disallow allows everything. `*` and `$` are honoured.
 * A path longer than ROBOTS_MAX_PATH is not tried and counts as disallowed.
 */
export function robotsAllows(robots: string, path: string): boolean {
  if (path.length > ROBOTS_MAX_PATH) return false;
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let open = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!open) groups.push({ agents: [], rules: [] });
      groups.at(-1)!.agents.push(value.toLowerCase());
      open = true;
    } else if ((key === 'allow' || key === 'disallow') && groups.length > 0) {
      groups.at(-1)!.rules.push({ allow: key === 'allow', path: value });
      open = false;
    } else open = false;
  }
  const ours = groups.filter((g) => g.agents.includes(ROBOTS_AGENT));
  const rules = (ours.length > 0 ? ours : groups.filter((g) => g.agents.includes('*'))).flatMap(
    (g) => g.rules,
  );
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!rule.path || !matches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow)
    )
      best = rule;
  }
  return best?.allow ?? true;
}

/**
 * Whether the rule's pattern (`*` any run, a final `$` the end) matches the start of the path.
 * One pass that backtracks only to the last `*`, never a regex: the rules and the path are the
 * site's text, and a backtracking pattern over them can hold the server for minutes.
 */
function matches(pattern: string, path: string): boolean {
  const glob = pattern.endsWith('$') ? pattern.slice(0, -1) : `${pattern}*`;
  let g = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (p < path.length) {
    if (glob[g] === '*') {
      star = g++;
      mark = p;
    } else if (g < glob.length && glob[g] === path[p]) {
      g++;
      p++;
    } else if (star >= 0) {
      g = star + 1;
      p = ++mark;
    } else return false;
  }
  while (glob[g] === '*') g++;
  return g === glob.length;
}

// --- extraction --------------------------------------------------------------------------

const decode = (value: string) =>
  value
    .replace(/&amp;/gi, '&')
    .replace(/&#x2F;|&#47;/gi, '/')
    .trim();

const INSTAGRAM_SKIP = new Set([
  'p',
  'reel',
  'reels',
  'explore',
  'accounts',
  'stories',
  'tv',
  'direct',
  'sharer',
]);
const FACEBOOK_SKIP = new Set([
  'sharer',
  'sharer.php',
  'share',
  'share.php',
  'plugins',
  'tr',
  'dialog',
  'login',
  'profile.php',
]);

/** One link as a value we keep, or null. */
function linkValue(href: string): [ProspectEnrichmentKey, string] | null {
  const instagram = href.match(
    /^(?:https?:)?\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#]|$)/i,
  );
  if (instagram?.[1] && !INSTAGRAM_SKIP.has(instagram[1].toLowerCase()))
    return ['instagram', `https://www.instagram.com/${instagram[1].toLowerCase()}/`];
  const facebook = href.match(
    /^(?:https?:)?\/\/(?:www\.|m\.|[a-z]{2}-[a-z]{2}\.)?facebook\.com\/([A-Za-z0-9.-]{2,80})\/?(?:[?#]|$)/i,
  );
  if (facebook?.[1] && !FACEBOOK_SKIP.has(facebook[1].toLowerCase()))
    return ['facebook', `https://www.facebook.com/${facebook[1]}`];
  const linkedin = href.match(
    /^(?:https?:)?\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company|in)\/([A-Za-z0-9_%.-]{2,100})\/?(?:[?#]|$)/i,
  );
  if (linkedin?.[1] && linkedin[2])
    return ['linkedin', `https://www.linkedin.com/${linkedin[1].toLowerCase()}/${linkedin[2]}`];
  const whatsapp =
    href.match(/^(?:https?:)?\/\/wa\.me\/\+?(\d{8,15})(?:[/?#]|$)/i) ??
    href.match(
      /^(?:https?:)?\/\/(?:api|web)\.whatsapp\.com\/send\/?\?(?:[^#]*&)?phone=\+?(\d{8,15})/i,
    );
  if (whatsapp?.[1]) return ['whatsapp', `https://wa.me/${whatsapp[1]}`];
  const mailto = href.match(/^mailto:([^?]+)/i);
  const email = mailto?.[1] ? emailValue(decodeOr(mailto[1])) : null;
  if (email) return ['email', email];
  return null;
}

const decodeOr = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// Bounded, and starting only where a word starts: a page is someone else's text, and an
// unbounded pattern over a long run of letters takes quadratic time.
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,6}\.[A-Za-z]{2,24}/g;
const HREF = /href\s*=\s*["']([^"']{1,2000})["']/gi;
const TAG_HREF = /href\s*=\s*["']([^"']{1,2000})["']/i;
const PLACEHOLDER_EMAIL =
  /@(?:[\w-]+\.)*(?:example|sentry|sentry-next|wixpress|domain|dominio|seudominio|email)\.[a-z.]+$|^(?:seu-?e-?mail|email|nome|user|usuario)@/i;
const IMAGE_NAME = /\.(?:png|jpe?g|gif|svg|webp|avif|ico)$/i;

function emailValue(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) return null;
  if (IMAGE_NAME.test(email) || PLACEHOLDER_EMAIL.test(email)) return null;
  return email;
}

/** The first link of each kind on a page, then a plain-text e-mail when no mailto gave one. */
export function extractContacts(html: string): FoundContacts {
  const found: FoundContacts = {};
  for (const match of html.matchAll(HREF)) {
    const value = linkValue(decode(match[1] ?? ''));
    if (value && !found[value[0]]) found[value[0]] = value[1];
  }
  if (!found.email) {
    for (const match of html.matchAll(EMAIL)) {
      const email = emailValue(match[0]);
      if (email) {
        found.email = email;
        break;
      }
    }
  }
  return found;
}

const CONTACT = /contato|contact|fale[-_ ]conosco|atendimento/i;

/**
 * One contact page linked from the page, on the same host; null when there is none. Anchors are
 * walked with indexOf, each tag and label bounded: a backtracking pattern over a whole hostile
 * page took the server for seconds per click.
 */
export function contactPageOf(html: string, base: URL): URL | null {
  const starts = /<a\b/gi;
  const ends = /<\/a\s*>/gi;
  let close = -1;
  for (let start = starts.exec(html); start; start = starts.exec(html)) {
    const tagEnd = html.indexOf('>', start.index);
    if (tagEnd < 0) break;
    starts.lastIndex = tagEnd + 1;
    if (close < tagEnd) {
      ends.lastIndex = tagEnd;
      close = ends.exec(html)?.index ?? html.length;
    }
    const tag = html.slice(start.index, Math.min(tagEnd, start.index + 3000));
    const href = decode(tag.match(TAG_HREF)?.[1] ?? '');
    if (!href) continue;
    const label =
      close - tagEnd <= 2000 ? html.slice(tagEnd + 1, close).replace(/<[^<>]*>/g, ' ') : '';
    if (!CONTACT.test(href) && !CONTACT.test(label)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    url.hash = '';
    if (!/^https?:$/.test(url.protocol) || url.host !== base.host || url.href === base.href)
      continue;
    return url;
  }
  return null;
}

// --- reading -------------------------------------------------------------------------------

function failureText(result: Exclude<PageResult, { kind: 'ok' }>): string {
  switch (result.kind) {
    // One answer for both: two would tell the seller which internal names exist.
    case 'blocked':
    case 'not_found':
      return 'endereço bloqueado ou inexistente (só sites públicos, http ou https, portas 80 e 443)';
    case 'disallowed':
      return 'o site redireciona para um endereço que o robots.txt não deixa ler';
    case 'timeout':
      return 'o site não respondeu em 5 segundos';
    case 'http_error':
      return `o site respondeu com erro ${result.status}`;
    default:
      return 'o site não respondeu';
  }
}

export async function readCompanySite(
  website: string,
  transport?: PageTransport,
): Promise<SiteReading> {
  const found: FoundContacts = {};
  const skipped: string[] = [];
  let pagesRead = 0;
  const robots = new Map<string, Promise<string | { refused: string }>>();

  /** robots.txt of the page's origin: its text, or why nothing may be read there. */
  const robotsOf = (url: URL) => {
    const robotsUrl = new URL('/robots.txt', url).href;
    let pending = robots.get(robotsUrl);
    if (!pending) {
      pending = readPublicPage(robotsUrl, {
        maxBytes: ROBOTS_MAX_BYTES,
        timeoutMs: TIMEOUT_MS,
        userAgent: USER_AGENT,
        transport,
      }).then((result) => {
        if (result.kind === 'ok') return result.body;
        // No robots.txt (4xx) allows everything; a server error or no answer allows nothing.
        if (result.kind === 'http_error' && result.status < 500) return '';
        if (result.kind === 'blocked' || result.kind === 'not_found')
          return { refused: failureText(result) };
        return {
          refused: `o robots.txt não respondeu (${failureText(result)}), então nada foi lido`,
        };
      });
      robots.set(robotsUrl, pending);
    }
    return pending;
  };

  /** Every redirect hop is asked too: a page may send us where its robots.txt forbids. */
  const permits = async (hop: URL) => {
    const rules = await robotsOf(hop);
    return typeof rules === 'string' && robotsAllows(rules, `${hop.pathname}${hop.search}`);
  };

  const read = async (url: URL, label: string) => {
    const rules = await robotsOf(url);
    if (typeof rules !== 'string') {
      skipped.push(`${label}: ${rules.refused}.`);
      return null;
    }
    if (!robotsAllows(rules, `${url.pathname}${url.search}`)) {
      skipped.push(`${label}: o robots.txt do site não permite a leitura.`);
      return null;
    }
    const page = await readPublicPage(url.href, {
      maxBytes: PAGE_MAX_BYTES,
      timeoutMs: TIMEOUT_MS,
      userAgent: USER_AGENT,
      transport,
      permits,
    });
    if (page.kind !== 'ok') {
      skipped.push(`${label}: ${failureText(page)}.`);
      return null;
    }
    pagesRead += 1;
    for (const [key, value] of Object.entries(extractContacts(page.body)))
      found[key as ProspectEnrichmentKey] ??= value;
    return page;
  };

  let start: URL;
  try {
    start = new URL(website);
  } catch {
    return { found, pagesRead, skipped: ['Página inicial: o endereço do site não é válido.'] };
  }
  if (!/^https?:$/.test(start.protocol))
    return { found, pagesRead, skipped: [`Página inicial: ${failureText({ kind: 'blocked' })}.`] };
  const home = await read(start, 'Página inicial');
  if (home) {
    const contact = contactPageOf(home.body, new URL(home.url));
    if (contact) await read(contact, 'Página de contato');
  }
  return { found, pagesRead, skipped };
}
