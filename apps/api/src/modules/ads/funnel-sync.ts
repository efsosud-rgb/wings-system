import { isTestDeal } from '@wings/shared';
import type { Database } from '../../db/client.js';
import { ga4TrafficDaily, rdCrmDeals } from '../../db/schema/index.js';
import type { Ga4Client } from '../../lib/ga4.js';

/**
 * The two reads after the click, run by the full ingestion cycle: the site's
 * sessions from GA4 and the RD Station CRM deals. Both read only, both
 * non-fatal for the cycle, and both keep no personal data (see
 * `db/schema/analytics.ts`).
 */

const GA4_DIMENSIONS = ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName'];
const GA4_METRICS = [
  'sessions',
  'engagedSessions',
  'userEngagementDuration',
  'screenPageViews',
  'keyEvents',
];

/** GA4's "(not set)" and empty values become one readable label. */
const label = (value: string) => (value === '' || value === '(not set)' ? '(não definido)' : value);

export async function syncGa4Traffic(
  db: Database,
  client: Ga4Client,
  input: { propertyId: string; since: string; until: string; now?: Date },
): Promise<{ rows: number; sessions: number }> {
  const rows = await client.runReport({
    startDate: input.since,
    endDate: input.until,
    dimensions: GA4_DIMENSIONS,
    metrics: GA4_METRICS,
  });
  const now = input.now ?? new Date();
  let sessions = 0;
  for (const row of rows) {
    const [date = '', source = '', medium = '', campaign = ''] = row.dimensions;
    const [rowSessions = 0, engaged = 0, engagement = 0, views = 0, keyEvents = 0] = row.metrics;
    if (!/^\d{8}$/.test(date)) continue;
    const day = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    sessions += rowSessions;
    const values = {
      sessions: Math.round(rowSessions),
      engagedSessions: Math.round(engaged),
      engagementSeconds: Math.round(engagement),
      pageViews: Math.round(views),
      keyEvents: Math.round(keyEvents),
      fetchedAt: now,
    };
    await db
      .insert(ga4TrafficDaily)
      .values({
        propertyId: input.propertyId,
        day,
        source: label(source),
        medium: label(medium),
        campaign: label(campaign),
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          ga4TrafficDaily.propertyId,
          ga4TrafficDaily.day,
          ga4TrafficDaily.source,
          ga4TrafficDaily.medium,
          ga4TrafficDaily.campaign,
        ],
        set: values,
      });
  }
  return { rows: rows.length, sessions };
}

/**
 * Which paid platform RD's labels point at. Conservative: a label that does
 * not name the platform stays null ("Tráfego pago - msg direta" could be
 * either), and the screen counts it apart.
 */
export function platformOfRdLabels(
  source: string | null,
  campaign: string | null,
): 'meta' | 'google' | null {
  const text = `${source ?? ''} | ${campaign ?? ''}`.toLowerCase();
  if (/busca paga \| (facebook|instagram)|facebook ads|meta ads|\bmeta\b/.test(text)) return 'meta';
  if (/busca paga \| google|google ads/.test(text)) return 'google';
  return null;
}

export interface RdDeal {
  id: string;
  name?: string;
  win: boolean | null;
  created_at: string;
  closed_at?: string | null;
  deal_stage?: { id?: string };
  user?: { id?: string; _id?: string } | null;
  deal_source?: { name?: string } | null;
  campaign?: { name?: string } | null;
  deal_lost_reason?: { name?: string } | null;
}

export interface RdPipeline {
  name: string;
  deal_stages: { id: string; name: string }[];
}

const RD_CRM = 'https://crm.rdstation.com/api/v1';

/**
 * The deals created in the last `days` days, with their current stage. RD
 * keeps no stage history, so "reached a meeting" is the current stage being
 * "Reunião realizada" or later in its pipeline, or the deal won; a deal lost
 * after a meeting is not counted, and the screen says so.
 */
/** A GET against RD CRM with its token, waiting out 429s; errors name the path and status only. */
export function rdCrmGetter(
  token: string,
  fetchImpl: typeof fetch = fetch,
  options: { minIntervalMs?: number } = {},
) {
  // Optional pacing: a long read (the Funil import) spaces its calls so it
  // does not eat the per-minute limit it shares with the intake jobs.
  let nextAt = 0;
  const pace = async () => {
    const interval = options.minIntervalMs ?? 0;
    if (interval <= 0) return;
    const wait = nextAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    nextAt = Date.now() + interval;
  };
  return async <T>(path: string, params: Record<string, string>): Promise<T> => {
    const url = new URL(`${RD_CRM}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // RD CRM takes the token in the query string; the URL is never logged or thrown.
    url.searchParams.set('token', token);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await pace();
      const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(30_000) });
      if (response.status === 429) {
        // The limit is per minute: wait a little longer each time (3 s … 24 s).
        await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`RD CRM ${path} answered ${response.status}`);
      return (await response.json()) as T;
    }
    throw new Error(`RD CRM ${path} kept answering 429`);
  };
}

export async function syncRdCrmDeals(
  db: Database,
  input: { token: string; since: string; until: string; fetchImpl?: typeof fetch; now?: Date },
): Promise<{ deals: number; raw: RdDeal[]; pipelines: RdPipeline[] }> {
  const get = rdCrmGetter(input.token, input.fetchImpl ?? fetch);

  const pipelines = await get<RdPipeline[]>('/deal_pipelines', {});
  const stageOf = new Map<
    string,
    { pipeline: string; stage: string; order: number; meetingOrder: number | null }
  >();
  for (const pipeline of pipelines) {
    const meeting = pipeline.deal_stages.findIndex((stage) =>
      /reuni[aã]o realizada/i.test(stage.name),
    );
    pipeline.deal_stages.forEach((stage, index) => {
      stageOf.set(stage.id, {
        pipeline: pipeline.name,
        stage: stage.name,
        order: index + 1,
        meetingOrder: meeting === -1 ? null : meeting + 1,
      });
    });
  }

  const period = {
    limit: '200',
    created_at_period: 'true',
    start_date: `${input.since}T00:00:00`,
    end_date: `${input.until}T23:59:59`,
  };
  const deals: RdDeal[] = [];
  let next: string | null = null;
  do {
    const page: { deals?: RdDeal[]; has_more?: boolean; next_page?: string } = await get('/deals', {
      ...period,
      ...(next ? { next_page: next } : {}),
    });
    deals.push(...(page.deals ?? []));
    next = page.has_more && page.next_page ? page.next_page : null;
  } while (next);

  const now = input.now ?? new Date();
  for (const deal of deals) {
    const stage = stageOf.get(deal.deal_stage?.id ?? '');
    const sourceLabel = deal.deal_source?.name ?? null;
    const campaignLabel = deal.campaign?.name ?? null;
    const reachedMeeting =
      deal.win === true ||
      (deal.win !== false && stage?.meetingOrder != null && stage.order >= stage.meetingOrder);
    const values = {
      pipeline: stage?.pipeline ?? '(desconhecido)',
      stage: stage?.stage ?? '(desconhecida)',
      stageOrder: stage?.order ?? 0,
      reachedMeeting,
      win: deal.win,
      createdAt: new Date(deal.created_at),
      closedAt: deal.closed_at ? new Date(deal.closed_at) : null,
      sourceLabel,
      campaignLabel,
      platform: platformOfRdLabels(sourceLabel, campaignLabel),
      lostReason: deal.deal_lost_reason?.name ?? null,
      isTest: isTestDeal(deal.name ?? null, deal.deal_lost_reason?.name ?? null),
      fetchedAt: now,
    };
    await db
      .insert(rdCrmDeals)
      .values({ rdId: deal.id, ...values })
      .onConflictDoUpdate({ target: rdCrmDeals.rdId, set: values });
  }
  return { deals: deals.length, raw: deals, pipelines };
}
