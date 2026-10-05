import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { metaLeadForms, metaPollState } from '../../db/schema/index.js';
import { fetchFormLeads, MetaLeadFetchError, META_GRAPH_VERSION } from './meta-leads.js';
import {
  enqueueMetaLeadgenEvents,
  META_LEADGEN_JOB,
  META_PAYLOAD_RETENTION_DAYS,
  processMetaLeadgenEvents,
  type MetaIntakeDeps,
  type MetaIntakeRunResult,
} from './meta-intake.js';

/**
 * Lead Ads without the webhook: with only the access key, every few minutes
 * the API asks Meta which pages the key sees, which forms each page has and
 * which leads each form got since the last pass (the first pass goes back 90
 * days, the most Meta keeps). Each lead id then takes the same path as a
 * webhook event (`meta_leadgen_events`, `leadgen_id` unique, so nothing is
 * created twice and the webhook can keep running beside it as the fast
 * road). Only ids, names of forms and totals are read or kept here; the
 * lead's data is read one by one by the queue, as before.
 */

const POLL_ID = 'leads';
/** Asked again from a little before the last pass: a lead Meta listed late is not lost (the id dedupes). */
const OVERLAP_MS = 30 * 60_000;
const PAGE_LIMIT = 100;

export interface PollResult {
  pages: number;
  forms: number;
  listed: number;
  queued: number;
  alreadyKnown: number;
  /** Code per page or form id: `graph_403`, `graph_unreachable`... */
  failed: Record<string, string>;
  truncated: number;
  processed: MetaIntakeRunResult | null;
}

interface GraphPage<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** One GET with the token in a header (never in the URL); pages by cursor, never by `paging.next`. */
async function graphList<T>(
  path: string,
  fields: string,
  token: string,
  fetchImpl: typeof fetch | undefined,
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  let pages = 0;
  do {
    const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (after) url.searchParams.set('after', after);
    const response = await (fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new MetaLeadFetchError(response.status, `Graph API answered ${response.status}`);
    const body = ((await response.json().catch(() => null)) ?? {}) as GraphPage<T>;
    out.push(...(body.data ?? []));
    pages += 1;
    after = body.paging?.next && body.paging.cursors?.after ? body.paging.cursors.after : null;
  } while (after && pages < maxPages);
  return out;
}

const codeOf = (error: unknown) =>
  error instanceof MetaLeadFetchError ? `graph_${error.status}` : 'graph_unreachable';

interface PageRef {
  id: string;
  name: string | null;
  /** The page's own token, when the key hands one out; used only for this page's reads. */
  token: string;
}

interface FormRef {
  id: string;
  name: string | null;
  status: string | null;
  pageId: string;
  pageName: string | null;
  token: string;
}

/**
 * The pages the key sees (`/me/accounts`; a page that gives no token of its
 * own is read with the key itself) and, per page, its Lead Ads forms.
 * One failing page or listing never stops the others.
 */
export async function discoverForms(
  deps: Pick<MetaIntakeDeps, 'accessToken' | 'graphFetch'> & { extraPageIds?: string[] },
): Promise<{ pages: PageRef[]; forms: FormRef[]; failed: Record<string, string> }> {
  const token = deps.accessToken!;
  const failed: Record<string, string> = {};
  const pages = new Map<string, PageRef>();
  try {
    const accounts = await graphList<{ id?: string; name?: string; access_token?: string }>(
      'me/accounts',
      'id,name,access_token',
      token,
      deps.graphFetch,
    );
    for (const account of accounts)
      if (account.id)
        pages.set(account.id, {
          id: account.id,
          name: account.name ?? null,
          token: account.access_token || token,
        });
  } catch (error) {
    failed.accounts = codeOf(error);
  }
  for (const id of deps.extraPageIds ?? [])
    if (!pages.has(id)) pages.set(id, { id, name: null, token });
  const forms: FormRef[] = [];
  for (const page of pages.values()) {
    try {
      const list = await graphList<{ id?: string; name?: string; status?: string }>(
        `${page.id}/leadgen_forms`,
        'id,name,status',
        page.token,
        deps.graphFetch,
      );
      for (const form of list)
        if (form.id)
          forms.push({
            id: form.id,
            name: form.name ?? null,
            status: form.status ?? null,
            pageId: page.id,
            pageName: page.name,
            token: page.token,
          });
    } catch (error) {
      failed[`page:${page.id}`] = codeOf(error);
    }
  }
  return { pages: [...pages.values()], forms, failed };
}

export interface PollDeps extends MetaIntakeDeps {
  /** Page ids to read besides the ones the key lists (META_LEADS_PAGE_IDS), for a key that lists none. */
  extraPageIds?: string[];
  /** First pass and "Buscar agora" go back this many days (90 by default, the most Meta keeps). */
  days?: number;
}

const LOCK_KEY = 'leads:meta:poll';
export const POLL_EVERY_MS = 5 * 60_000;

/** `pollMetaLeads` under a database lock: a second process (or click) meanwhile gets `locked`. */
export async function pollMetaLeadsLocked(deps: PollDeps): Promise<PollResult | 'locked'> {
  return deps.db.transaction(async (tx) => {
    const lock = await tx.execute<{ got: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as got`,
    );
    if (!lock.rows[0]?.got) return 'locked' as const;
    return pollMetaLeads(deps);
  });
}

/** One pass: discover, list what is new, queue it, then let the queue create the deals. */
export async function pollMetaLeads(deps: PollDeps): Promise<PollResult> {
  if (!deps.accessToken) throw new Error('no_token');
  const now = deps.now?.() ?? new Date();
  const result: PollResult = {
    pages: 0,
    forms: 0,
    listed: 0,
    queued: 0,
    alreadyKnown: 0,
    failed: {},
    truncated: 0,
    processed: null,
  };
  await deps.db
    .insert(metaPollState)
    .values({ id: POLL_ID, lastRunAt: now })
    .onConflictDoUpdate({ target: metaPollState.id, set: { lastRunAt: now } });
  try {
    const found = await discoverForms(deps);
    result.pages = found.pages.length;
    result.forms = found.forms.length;
    result.failed = { ...found.failed };
    const known = new Map(
      (await deps.db.select().from(metaLeadForms)).map((row) => [row.formId, row] as const),
    );
    const firstSince = new Date(
      now.getTime() - (deps.days ?? META_PAYLOAD_RETENTION_DAYS) * 86_400_000,
    );
    for (const form of found.forms) {
      const before = known.get(form.id);
      await deps.db
        .insert(metaLeadForms)
        .values({
          formId: form.id,
          pageId: form.pageId,
          pageName: form.pageName,
          name: form.name,
          status: form.status,
        })
        .onConflictDoUpdate({
          target: metaLeadForms.formId,
          set: {
            pageId: form.pageId,
            pageName: form.pageName,
            name: form.name,
            status: form.status,
          },
        });
      const since = before?.polledThrough
        ? new Date(Math.max(before.polledThrough.getTime() - OVERLAP_MS, firstSince.getTime()))
        : firstSince;
      try {
        const listed = await fetchFormLeads(form.id, {
          accessToken: form.token,
          since,
          fetchImpl: deps.graphFetch,
        });
        result.listed += listed.leads.length;
        if (listed.truncated) result.truncated += 1;
        const queued = await enqueueMetaLeadgenEvents(
          deps.db,
          listed.leads.map((lead) => ({
            leadgenId: lead.leadgenId,
            formId: form.id,
            pageId: form.pageId,
            adId: lead.adId,
            adgroupId: lead.adsetId,
            createdTime: lead.createdTime,
            raw: {
              source: 'poll',
              id: lead.leadgenId,
              form_id: form.id,
              page_id: form.pageId,
              ad_id: lead.adId,
              adset_id: lead.adsetId,
              campaign_id: lead.campaignId,
            },
          })),
        );
        result.queued += queued;
        result.alreadyKnown += listed.leads.length - queued;
        await deps.db
          .update(metaLeadForms)
          .set({
            // A truncated listing did not reach the end: do not move the mark past what was read.
            ...(listed.truncated ? {} : { polledThrough: now }),
            lastPolledAt: now,
            lastError: null,
            leadsListed: sql`${metaLeadForms.leadsListed} + ${queued}`,
          })
          .where(eq(metaLeadForms.formId, form.id));
      } catch (error) {
        result.failed[`form:${form.id}`] = codeOf(error);
        await deps.db
          .update(metaLeadForms)
          .set({ lastPolledAt: now, lastError: codeOf(error) })
          .where(eq(metaLeadForms.formId, form.id));
      }
    }
    if (result.queued > 0) result.processed = await processMetaLeadgenEvents(deps);
    const ok = Object.keys(result.failed).length === 0;
    await deps.db
      .update(metaPollState)
      .set({
        lastResult: { ...result, failed: Object.keys(result.failed).length },
        lastError: ok ? null : 'partial',
        ...(ok ? { lastOkAt: now } : {}),
      })
      .where(eq(metaPollState.id, POLL_ID));
  } catch (error) {
    await deps.db
      .update(metaPollState)
      .set({ lastError: codeOf(error) })
      .where(eq(metaPollState.id, POLL_ID));
    throw error;
  }
  deps.log({
    job: META_LEADGEN_JOB,
    msg: 'meta poll',
    ...result,
    failed: Object.keys(result.failed).length,
  });
  return result;
}

export interface ConnectionTest {
  pages: number;
  forms: number;
  /** Leads of the last 90 days the key can list, counted by id (a count, never a person). */
  leads: number;
  /** True when a form had more leads than were counted (the count is a floor). */
  truncated: boolean;
  failed: Record<string, string>;
}

/** "Testar conexão": what the key sees, in totals. Reads ids only and writes nothing. */
export async function testMetaConnection(deps: PollDeps): Promise<ConnectionTest> {
  if (!deps.accessToken) throw new Error('no_token');
  const found = await discoverForms(deps);
  const out: ConnectionTest = {
    pages: found.pages.length,
    forms: found.forms.length,
    leads: 0,
    truncated: false,
    failed: { ...found.failed },
  };
  const since = new Date((deps.now?.() ?? new Date()).getTime() - 90 * 86_400_000);
  for (const form of found.forms) {
    try {
      const listed = await fetchFormLeads(form.id, {
        accessToken: form.token,
        since,
        fetchImpl: deps.graphFetch,
        maxPages: 10,
      });
      out.leads += listed.leads.length;
      if (listed.truncated) out.truncated = true;
    } catch (error) {
      out.failed[`form:${form.id}`] = codeOf(error);
    }
  }
  return out;
}

/** What the card shows: how the door works, when it last ran, what it found; ids and totals only. */
export async function pollStatus(db: Database) {
  const [state] = await db.select().from(metaPollState).where(eq(metaPollState.id, POLL_ID));
  const [counts] = await db
    .select({
      forms: sql<number>`count(*)::int`,
      withError: sql<number>`(count(*) filter (where ${metaLeadForms.lastError} is not null))::int`,
    })
    .from(metaLeadForms);
  const recent = await db
    .select({ lastPolledAt: metaLeadForms.lastPolledAt })
    .from(metaLeadForms)
    .orderBy(desc(metaLeadForms.lastPolledAt))
    .limit(1);
  return {
    lastRunAt: state?.lastRunAt?.toISOString() ?? null,
    lastOkAt: state?.lastOkAt?.toISOString() ?? null,
    lastError: state?.lastError ?? null,
    lastResult: (state?.lastResult as Record<string, number> | null) ?? null,
    forms: counts?.forms ?? 0,
    formsWithError: counts?.withError ?? 0,
    lastPolledAt: recent[0]?.lastPolledAt?.toISOString() ?? null,
  };
}
