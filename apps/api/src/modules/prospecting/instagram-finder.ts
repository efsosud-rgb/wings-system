import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  INSTAGRAM_DISCOVERY_REASONS as REASONS,
  INSTAGRAM_FROM_META_GUESS,
  INSTAGRAM_FROM_WEB,
  INSTAGRAM_FROM_WEB_UNCONFIRMED,
  PROSPECT_ENRICHMENT_SOURCE,
  instagramOfWebsite,
  normalizeInstagram,
  siteDomain,
  type InstagramMiss,
  type ProspectInstagramRef,
  type ProspectInstagramSource,
} from '@wings/shared';
import { and, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { auditLog, prospectInstagramLookups } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import type { PageTransport } from '../../lib/public-probe.js';
import { startOfDaySaoPaulo } from '../prospect-ai/classifier.js';
import { discoverInstagram, type DiscoveryDeps } from './instagram-discovery.js';
import { issueTicket } from './instagram-graph.js';
import { readCompanySite, type SiteReading } from './site-reader.js';
import type { WebSearchClient } from './web-search.js';

/**
 * Finding a company's Instagram on its own (t086, docs/crm/prospeccao.md), stopping at the first
 * path that resolves: (1) the company's site, home + contact + "sobre" pages, 12 s with a retry;
 * (2) Meta's Business Discovery on the @ its domain or name suggests, kept only if Meta confirms a
 * business account; (3) a web search for name + city + "instagram", each profile found checked
 * against the name and, when Meta is on, confirmed there. Never an @ nobody confirmed: with none,
 * the reasons say what each path met. One lookup per company is kept (`place_id`), so a company is
 * not read, asked or searched again until the retry date.
 */

/** What a company's Google result gives the finder; carried in the ticket, never saved. */
export interface FinderCompany {
  placeId: string;
  name: string | null;
  website: string | null;
  address: string | null;
}

export interface FinderDeps {
  db: Database;
  now: Date;
  employeeId: string;
  siteTransport?: PageTransport;
  /** Null while Business Discovery is off or unconfigured. */
  discovery: DiscoveryDeps | null;
  /** Null while `BRAVE_SEARCH_API_KEY` is missing. */
  search: WebSearchClient | null;
}

export interface FinderOutcome {
  instagram: Omit<ProspectInstagramRef, 'ticket'> | null;
  miss: InstagramMiss | null;
}

const DAY_MS = 86_400_000;
export const FOUND_DAYS = 30;
const NONE_DAYS = 7;
/** A site that did not answer is tried again the next day; Meta's hold or a search error sooner. */
const TIMEOUT_RETRY_MS = DAY_MS;
const TRANSIENT_RETRY_MS = 6 * 3_600_000;
/** Business Discovery calls spent guessing for one company, and web profiles checked after. */
const MAX_GUESSES = 2;
const MAX_WEB_CANDIDATES = 2;
/** Paid searches per day, all sellers together (US$ 0.50 at Brave's price). */
export const WEB_SEARCH_PER_DAY = 100;

// --- the ticket: the finder only works on a company a Google search showed this seller ------------

const TICKET_TTL_MS = 12 * 3_600_000;
const FIELD_MAX = { name: 120, website: 200, address: 160 };

export const finderKeyOf = (sessionSecret: string): Buffer =>
  createHmac('sha256', sessionSecret).update('wings-instagram-finder-ticket').digest();

const macOf = (key: Buffer, employeeId: string, payload: string) =>
  createHmac('sha256', key).update(`${employeeId}\n${payload}`).digest('base64url');

const clip = (value: string | null, max: number) => (value && value.length <= max ? value : null);

/** `payload.mac`: the company's three fields and an expiry, signed for this seller. */
export function issueFinderTicket(
  key: Buffer,
  employeeId: string,
  company: FinderCompany,
  now: Date,
): string {
  const payload = Buffer.from(
    JSON.stringify([
      company.placeId,
      clip(company.name, FIELD_MAX.name),
      clip(company.website, FIELD_MAX.website),
      clip(company.address, FIELD_MAX.address),
      now.getTime() + TICKET_TTL_MS,
    ]),
  ).toString('base64url');
  return `${payload}.${macOf(key, employeeId, payload)}`;
}

export function readFinderTicket(
  key: Buffer,
  employeeId: string,
  ticket: string,
  now: Date,
): FinderCompany | null {
  const [payload, signature] = ticket.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(macOf(key, employeeId, payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const [placeId, name, website, address, expires] = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as [unknown, unknown, unknown, unknown, unknown];
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    if (typeof placeId !== 'string' || typeof expires !== 'number' || expires < now.getTime())
      return null;
    return { placeId, name: text(name), website: text(website), address: text(address) };
  } catch {
    return null;
  }
}

// --- the @ a company's name and site suggest ------------------------------------------------------

const strip = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
const STOPWORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'em',
  'a',
  'o',
  'ltda',
  'me',
  'epp',
]);

/** The words of a business name that identify it: no accents, no articles, no legal suffix. */
export function nameTokens(name: string | null): string[] {
  // "Padaria Central - Icaraí" and "Padaria Central | Niterói": the branch after the dash is out.
  const head = (name ?? '').split(/\s[-–|]\s/)[0] ?? '';
  return strip(head)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/** The probable @s, the site's domain first (the company's own word), then its name run together. */
export function guessHandles(company: Pick<FinderCompany, 'name' | 'website'>): string[] {
  const label = siteDomain(company.website)?.split('.')[0] ?? null;
  const joined = nameTokens(company.name).join('');
  const handles: string[] = [];
  for (const candidate of [label, joined]) {
    const handle = candidate ? normalizeInstagram(candidate.replace(/-/g, '')) : null;
    if (handle && handle.length >= 4 && !handles.includes(handle)) handles.push(handle);
  }
  return handles.slice(0, MAX_GUESSES);
}

/** "Rua X, 12 - Icaraí, Niterói - RJ, 24220-000, Brasil" → "Niterói". */
export function cityOf(address: string | null): string | null {
  const match = /,\s*([^,]+?)\s*-\s*[A-Z]{2}\b/.exec(address ?? '');
  return match?.[1]?.trim() || null;
}

/**
 * Whether a profile found on the web can be this company: every identifying word of its name is in
 * the @ or in the result's title. Strict on purpose; a miss only leaves "—".
 */
export function profileMatches(name: string | null, username: string, title: string): boolean {
  const tokens = nameTokens(name).filter((token) => token.length >= 3);
  if (tokens.length === 0) return false;
  const haystack = `${strip(username).replace(/[._]/g, '')} ${strip(title)}`;
  return tokens.every((token) => haystack.includes(token));
}

// --- the keep ---------------------------------------------------------------------------------------

type LookupRow = typeof prospectInstagramLookups.$inferSelect;

export async function lookupsFor(
  db: Pick<Database, 'select'>,
  placeIds: string[],
  now: Date,
): Promise<Map<string, LookupRow>> {
  if (placeIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(prospectInstagramLookups)
    .where(
      and(
        eq(prospectInstagramLookups.tenantId, WINGS_TENANT_ID),
        inArray(prospectInstagramLookups.placeId, placeIds),
        gt(prospectInstagramLookups.expiresAt, now),
      ),
    );
  return new Map(rows.map((row) => [row.placeId, row]));
}

export function outcomeOf(row: LookupRow): FinderOutcome {
  if (row.outcome === 'found' && row.username)
    return {
      instagram: {
        username: row.username,
        source: row.source as ProspectInstagramSource,
        at: row.checkedAt.toISOString(),
      },
      miss: null,
    };
  return {
    instagram: null,
    miss: { reasons: row.reasons as string[], at: row.checkedAt.toISOString() },
  };
}

async function keep(
  db: Database,
  placeId: string,
  outcome: FinderOutcome,
  retryMs: number,
  now: Date,
): Promise<void> {
  const found = outcome.instagram;
  const values = {
    outcome: found ? 'found' : 'none',
    username: found?.username ?? null,
    source: found?.source ?? null,
    reasons: outcome.miss?.reasons ?? [],
    checkedAt: now,
    expiresAt: new Date(now.getTime() + (found ? FOUND_DAYS * DAY_MS : retryMs)),
  };
  await db
    .insert(prospectInstagramLookups)
    .values({ placeId, ...values })
    .onConflictDoUpdate({
      target: [prospectInstagramLookups.tenantId, prospectInstagramLookups.placeId],
      set: values,
    });
}

/** Rows past their retry date; the housekeeping runs it with the other Instagram purges. */
export async function purgeInstagramLookups(
  db: Pick<Database, 'delete'>,
  now: Date,
): Promise<number> {
  const gone = await db
    .delete(prospectInstagramLookups)
    .where(lt(prospectInstagramLookups.expiresAt, now))
    .returning({ id: prospectInstagramLookups.id });
  return gone.length;
}

// --- the paid search's daily ceiling ------------------------------------------------------------------

/** One search reserved under a lock before it goes (lição 5); false at the day's ceiling. */
export async function reserveWebSearch(
  db: Database,
  employeeId: string,
  perDay: number,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('instagram_finder_web_search'))`);
    const [row] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'prospect.web_search'), gte(auditLog.at, startOfDaySaoPaulo(now))),
      );
    if ((row?.total ?? 0) >= perDay) return false;
    await writeAudit(tx, {
      actorEmployeeId: employeeId,
      action: 'prospect.web_search',
      entity: 'prospect_instagram_lookup',
      metadata: { purpose: 'instagram_finder' },
    });
    return true;
  });
}

// --- the three paths --------------------------------------------------------------------------------------

interface Step {
  /** The @ and where it came from; null when the path did not resolve. */
  found: { username: string; source: ProspectInstagramSource } | null;
  /** Why not, as the seller reads it. */
  reason: string | null;
  /** The reason may pass (a timeout, Meta's hold): the company is tried again after this long. */
  retryMs?: number;
}

const miss = (reason: string, retryMs?: number): Step => ({ found: null, reason, retryMs });

/** Path 1. `reading` is the one the Enriquecer click already made, so the site is read once. */
async function fromSite(
  deps: FinderDeps,
  company: FinderCompany,
  reading?: SiteReading,
): Promise<Step> {
  if (!company.website) return miss('Site: o Google não informa o site da empresa.');
  if (!siteDomain(company.website))
    return miss('Site: o endereço do Google é uma página de rede social, não o site da empresa.');
  const read =
    reading ??
    (await readCompanySite(company.website, {
      transport: deps.siteTransport,
      stopAtInstagram: true,
    }));
  const username = read.found.instagram ? normalizeInstagram(read.found.instagram) : null;
  if (username) return { found: { username, source: PROSPECT_ENRICHMENT_SOURCE }, reason: null };
  if (read.pagesRead > 0)
    return miss(
      `Site: ${read.pagesRead} ${read.pagesRead === 1 ? 'página lida' : 'páginas lidas'} sem link do Instagram.`,
    );
  return miss(
    `Site: ${read.skipped.join(' ') || 'não foi possível ler.'}`,
    read.timedOut ? TIMEOUT_RETRY_MS : undefined,
  );
}

/** Whether Meta confirms a business account for the @, or why it does not. */
async function confirmed(deps: FinderDeps, username: string) {
  const meta = deps.discovery!;
  const answer = await discoverInstagram(meta, deps.employeeId, {
    items: [{ username, ticket: issueTicket(meta.ticketKey, deps.employeeId, username, deps.now) }],
  });
  const item = answer.items[0];
  if (item?.snapshot?.status === 'encontrada') return { ok: true as const };
  const reason = item?.reason ?? REASONS.failed;
  return { ok: false as const, reason, transient: reason !== REASONS.notBusiness };
}

/** Path 2. */
async function fromMetaGuess(deps: FinderDeps, company: FinderCompany): Promise<Step> {
  if (!deps.discovery) return miss('Meta: a consulta ao Instagram está desligada neste ambiente.');
  const handles = guessHandles(company);
  if (handles.length === 0) return miss('Meta: sem nome nem site para tirar um @ provável.');
  for (const handle of handles) {
    const answer = await confirmed(deps, handle);
    if (answer.ok)
      return { found: { username: handle, source: INSTAGRAM_FROM_META_GUESS }, reason: null };
    if (answer.transient)
      return miss(
        `Meta: não deu para confirmar o @ provável (${answer.reason}).`,
        TRANSIENT_RETRY_MS,
      );
  }
  return miss('Meta: conta não confirmada (o @ provável não existe ou não é comercial).');
}

/** Path 3. */
async function fromWebSearch(deps: FinderDeps, company: FinderCompany): Promise<Step> {
  if (!deps.search) return miss('Web: a busca na web não está configurada neste ambiente.');
  const name = company.name?.trim();
  if (!name) return miss('Web: sem o nome da empresa para buscar.');
  if (!(await reserveWebSearch(deps.db, deps.employeeId, WEB_SEARCH_PER_DAY, deps.now)))
    return miss('Web: limite de buscas na web do dia.', TRANSIENT_RETRY_MS);
  const city = cityOf(company.address);
  let results;
  try {
    results = await deps.search.search([name, city, 'instagram'].filter(Boolean).join(' '));
  } catch {
    return miss('Web: a busca na web não respondeu.', TRANSIENT_RETRY_MS);
  }
  const candidates: string[] = [];
  for (const result of results) {
    const username = instagramOfWebsite(result.url);
    if (username && !candidates.includes(username) && profileMatches(name, username, result.title))
      candidates.push(username);
  }
  if (candidates.length === 0)
    return miss('Web: nenhum perfil do Instagram nos resultados bate com o nome da empresa.');
  let transient = false;
  for (const username of candidates.slice(0, MAX_WEB_CANDIDATES)) {
    if (!deps.discovery)
      return { found: { username, source: INSTAGRAM_FROM_WEB_UNCONFIRMED }, reason: null };
    const answer = await confirmed(deps, username);
    if (answer.ok) return { found: { username, source: INSTAGRAM_FROM_WEB }, reason: null };
    transient ||= answer.transient;
  }
  return transient
    ? miss('Web: achou um perfil, mas a Meta não deu para confirmar agora.', TRANSIENT_RETRY_MS)
    : miss('Web: o perfil achado não foi confirmado na Meta (não é conta comercial).');
}

/**
 * The company's Instagram, from the kept lookup or the three paths in order. `reading` is a site
 * reading already made (the Enriquecer click), so path 1 does not read the site twice.
 */
export async function findInstagram(
  deps: FinderDeps,
  company: FinderCompany,
  options: { reading?: SiteReading } = {},
): Promise<FinderOutcome> {
  // A reading that just showed a link is news; anything else is answered from what was kept.
  if (!options.reading?.found.instagram) {
    const kept = (await lookupsFor(deps.db, [company.placeId], deps.now)).get(company.placeId);
    if (kept) return outcomeOf(kept);
  }
  const reasons: string[] = [];
  let retryMs = NONE_DAYS * DAY_MS;
  let found: Step['found'] = null;
  const paths = [
    () => fromSite(deps, company, options.reading),
    () => fromMetaGuess(deps, company),
    () => fromWebSearch(deps, company),
  ];
  for (const path of paths) {
    const step = await path();
    if (step.found) {
      found = step.found;
      break;
    }
    reasons.push(step.reason!);
    retryMs = Math.min(retryMs, step.retryMs ?? retryMs);
  }
  const at = deps.now.toISOString();
  const outcome: FinderOutcome = found
    ? { instagram: { ...found, at }, miss: null }
    : { instagram: null, miss: { reasons, at } };
  await keep(deps.db, company.placeId, outcome, retryMs, deps.now);
  return outcome;
}
