import {
  adPlatformOfUtmSource,
  CAMPAIGN_LEADS_SINCE,
  campaignDelivering,
  effectiveCampaignEnd,
  isFormatacaoPipeline,
  isPaidUtmMedium,
  isTestDeal,
  maskEmail,
  maskPhone,
  type AdPlatform,
  type AttributionMethod,
  utmSourceName,
  type UnattributedReason,
} from '@wings/shared';
import { and, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAds,
  adCampaignDrafts,
  adCampaigns,
  adMetricsDaily,
  adSets,
  campaignLeads,
  employees,
  leads,
} from '../../db/schema/index.js';
import { paramsOfAddress } from '../../lib/query-params.js';
import type { SecretBox } from '../../lib/secret-box.js';
import { platformOfRdLabels, rdCrmGetter, type RdPipeline } from './funnel-sync.js';

/**
 * Leads das Campanhas: every 15 minutes (with `ingest-cli --reconcile-only`),
 * the Formatação deals RD CRM created since 28/09 are copied with their
 * contact (name in text, e-mail and phone sealed), their owner, their stage
 * and the campaign and ad they came from.
 *
 * Attribution, in this order (see `attribute`):
 *  0. a person who arrived before 28/09 (an old lead copied to RD later) is
 *     out of the account;
 *  1. the Wings lead behind the deal names its campaign and ad (Meta instant forms);
 *  2. the UTMs of the contact's conversion in RD Marketing (asked once per
 *     lead): utm_campaign names the campaign (id, name, a slug of the name, the
 *     UTM of its drafts or ads), utm_content the ad;
 *  3. RD's own source label ("Busca Paga | Facebook" / "| Google") when the
 *     platform has exactly one campaign in force;
 *  4. otherwise not attributed, with the reason.
 * "In force" is judged on the day the deal entered, not on the day of the sync.
 *
 * Read only on both RD products. Nothing personal reaches a log: the caller
 * prints the counts this returns, and errors carry no RD text.
 */

interface RdDeal {
  id: string;
  name?: string;
  created_at: string;
  updated_at?: string;
  closed_at?: string | null;
  win: boolean | null;
  rating?: number | null;
  amount_total?: number | null;
  last_activity_at?: string | null;
  deal_stage?: { id?: string };
  deal_source?: { name?: string } | null;
  campaign?: { name?: string } | null;
  deal_lost_reason?: { name?: string } | null;
  user?: { id?: string; name?: string; email?: string } | null;
  organization?: {
    name?: string;
    organization_segments?: { name?: string }[];
    address?: { city?: string } | null;
  } | null;
  contacts?: {
    name?: string;
    emails?: { email?: string }[];
    phones?: { phone?: string }[];
  }[];
}

export interface RdMarketingCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface Utms {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
}

const norm = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/**
 * RD Marketing keeps a conversion's origin as `traffic_source`:
 * "encoded_" + base64 of `{ first_session, current_session }`, each with the
 * landing URL or query string (`value`) and `extra_params`. The UTMs are read
 * from the current session's `value`, then its extra params, then the first session's.
 */
export function utmsOfTrafficSource(trafficSource: string | null | undefined): Utms | null {
  if (!trafficSource) return null;
  let decoded: {
    first_session?: { value?: string; extra_params?: Record<string, unknown> };
    current_session?: { value?: string; extra_params?: Record<string, unknown> };
  };
  try {
    const raw = trafficSource.startsWith('encoded_') ? trafficSource.slice(8) : trafficSource;
    decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as typeof decoded;
  } catch {
    return null;
  }
  const read = (session?: { value?: string; extra_params?: Record<string, unknown> }) => {
    const params = new Map<string, string>();
    for (const [key, value] of paramsOfAddress(session?.value)) params.set(key, value);
    for (const [key, value] of Object.entries(session?.extra_params ?? {})) {
      if (typeof value === 'string' && !params.has(key)) params.set(key, value);
    }
    const pick = (key: string) => params.get(`utm_${key}`)?.trim() || null;
    const source = pick('source');
    return {
      // Meta's {{site_source_name}} (fb, ig, msg, an) spelled out.
      source: source ? utmSourceName(source) : null,
      medium: pick('medium'),
      campaign: pick('campaign'),
      content: pick('content'),
    };
  };
  const current = read(decoded.current_session);
  if (current.campaign || current.source) return current;
  const first = read(decoded.first_session);
  return first.campaign || first.source ? first : null;
}

/** An RD Marketing reader: the UTMs of a contact's conversion nearest before `before`. */
export function rdMarketingReader(
  credentials: RdMarketingCredentials,
  fetchImpl: typeof fetch = fetch,
) {
  let token: string | null = null;
  const accessToken = async () => {
    if (token) return token;
    const response = await fetchImpl('https://api.rd.services/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string };
    if (!response.ok || !body.access_token) {
      throw new Error(`RD Marketing token refused (${response.status})`);
    }
    token = body.access_token;
    return token;
  };
  const get = async <T>(path: string): Promise<{ status: number; body: T | null }> => {
    const response = await fetchImpl(`https://api.rd.services${path}`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as T | null };
  };
  return {
    /** Null: the contact or its conversion has no UTM. Throws when RD could not answer. */
    async utmsOf(email: string, before: Date): Promise<Utms | null> {
      const contact = await get<{ uuid?: string }>(
        `/platform/contacts/email:${encodeURIComponent(email)}`,
      );
      if (contact.status === 404 || !contact.body?.uuid) return null;
      if (contact.status !== 200)
        throw new Error(`RD Marketing contact answered ${contact.status}`);
      const events = await get<
        { event_timestamp?: string; payload?: { traffic_source?: string } }[]
      >(`/platform/contacts/${contact.body.uuid}/events?event_type=CONVERSION`);
      if (events.status !== 200) throw new Error(`RD Marketing events answered ${events.status}`);
      // The conversion that created the deal: the latest one up to a few
      // minutes after it (RD creates the deal right after the conversion).
      const limit = before.getTime() + 10 * 60_000;
      const ordered = (events.body ?? [])
        .filter((event) => event.event_timestamp && Date.parse(event.event_timestamp) <= limit)
        .sort((a, b) => Date.parse(b.event_timestamp!) - Date.parse(a.event_timestamp!));
      for (const event of ordered) {
        const utms = utmsOfTrafficSource(event.payload?.traffic_source);
        if (utms) return utms;
      }
      return null;
    },
  };
}

/** What attribution knows of a campaign: the words a UTM may use for it and its ads, and when it was in force. */
export interface AttributionCampaign {
  id: string;
  platform: AdPlatform;
  /** The platform's own id, normalized. */
  externalId?: string;
  /** The campaign's id, name, the UTMs of its drafts and of its ads' URL tags, normalized. */
  keys: string[];
  /** The campaign's name, normalized: a UTM slug of it ("formatacao_videos_thais_out26") sits inside it. */
  nameKey?: string;
  ads: { id: string; externalId?: string; keys: string[] }[];
  startDate?: string | null;
  endDate?: string | null;
  /** Delivering as of the sync (`campaignDelivering`). */
  deliveringNow?: boolean;
  /** São Paulo days (YYYY-MM-DD) on which the campaign spent. */
  spendDays?: ReadonlySet<string>;
}

/** What the Wings lead behind a deal says about where it came from. */
export interface LeadOrigin {
  /** When the person really arrived, not when the deal was copied to RD. */
  enteredAt: Date;
  adPlatform: string | null;
  adCampaignExternalId: string | null;
  adExternalId: string | null;
}

const saoPauloDayOf = (at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(at);

const dayBefore = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - 24 * 3600_000).toISOString().slice(0, 10);

/**
 * Whether a campaign was in force on `day`: inside its start and end dates and
 * either delivering now or having spent that day or the day before. Judging
 * "now" instead would drop a lead the day its campaign ends. Without a day
 * (callers that only have the words), every campaign counts.
 */
export function inForceOn(campaign: AttributionCampaign, day: string | undefined): boolean {
  if (!day) return true;
  if (campaign.startDate && campaign.startDate > day) return false;
  if (campaign.endDate && campaign.endDate < day) return false;
  if (campaign.deliveringNow) return true;
  const spent = campaign.spendDays;
  return Boolean(spent && (spent.has(day) || spent.has(dayBefore(day))));
}

const only = <T>(items: T[]): T | undefined => (items.length === 1 ? items[0] : undefined);

/** The static `utm_campaign` a URL tag string carries; the ones with a {{macro}} expand to the name already. */
export function utmCampaignOfUrlTags(urlTags: string | null | undefined): string | null {
  if (!urlTags) return null;
  const value = new URLSearchParams(urlTags.replace(/^\?/, '')).get('utm_campaign')?.trim();
  return value && !value.includes('{{') ? value : null;
}

type CampaignRow = typeof adCampaigns.$inferSelect;
type DraftRow = typeof adCampaignDrafts.$inferSelect;
type AdRow = typeof adAds.$inferSelect;

/**
 * Every campaign, with the words a UTM may use for each and for their ads and
 * the days they spent: the lead is judged by the campaigns in force the day it
 * entered, not by the ones delivering when the sync happens to run. Pure, so a
 * read-only rehearsal on a copy of the rows gives what the sync will give.
 */
export function buildAttributionCampaigns(input: {
  campaigns: { campaign: CampaignRow; platform: string }[];
  drafts: Pick<DraftRow, 'campaignId' | 'payload'>[];
  ads: Pick<AdRow, 'id' | 'campaignId' | 'externalId' | 'name' | 'utmContent' | 'urlTags'>[];
  spend: { campaignId: string | null; day: string }[];
  /** The ad sets, for a schedule that lives on them (Meta): the campaign ends with the ones that are on. */
  adSets?: { campaignId: string; status: string; endDate: string | null }[];
  now: Date;
}): AttributionCampaign[] {
  const today = saoPauloDayOf(input.now);
  const spendDays = new Map<string, Set<string>>();
  for (const row of input.spend) {
    if (!row.campaignId) continue;
    const days = spendDays.get(row.campaignId) ?? new Set<string>();
    days.add(row.day);
    spendDays.set(row.campaignId, days);
  }
  return input.campaigns.map(({ campaign, platform }) => {
    const campaignAds = input.ads.filter((ad) => ad.campaignId === campaign.id);
    const endDate = effectiveCampaignEnd(
      campaign.endDate,
      (input.adSets ?? []).filter((adSet) => adSet.campaignId === campaign.id),
    );
    const utm = [
      ...input.drafts
        .filter((draft) => draft.campaignId === campaign.id)
        .map(
          (draft) =>
            (draft.payload as { utms?: { utm_campaign?: string } } | null)?.utms?.utm_campaign,
        ),
      ...campaignAds.map((ad) => utmCampaignOfUrlTags(ad.urlTags)),
    ].filter((value): value is string => Boolean(value));
    return {
      id: campaign.id,
      platform: platform as AdPlatform,
      externalId: norm(campaign.externalId),
      keys: [...new Set([campaign.externalId, campaign.name, ...utm].map(norm))],
      nameKey: norm(campaign.name),
      ads: campaignAds.map((ad) => ({
        id: ad.id,
        externalId: norm(ad.externalId),
        keys: [
          ...new Set(
            [ad.externalId, ad.name, ad.utmContent]
              .filter((value): value is string => Boolean(value))
              .map(norm),
          ),
        ],
      })),
      startDate: campaign.startDate,
      endDate,
      deliveringNow: campaignDelivering(
        {
          platform: platform as AdPlatform,
          status: campaign.status,
          deliveryStatus: campaign.deliveryStatus,
          endDate,
        },
        today,
      ),
      spendDays: spendDays.get(campaign.id) ?? new Set<string>(),
    };
  });
}

async function attributionCampaigns(
  db: Database,
  now: Date,
  since: Date,
): Promise<AttributionCampaign[]> {
  const rows = await db
    .select({ campaign: adCampaigns, platform: adAccounts.platform })
    .from(adCampaigns)
    .innerJoin(adAccounts, eq(adAccounts.id, adCampaigns.adAccountId))
    .where(isNull(adAccounts.archivedAt));
  if (rows.length === 0) return [];
  const ids = rows.map(({ campaign }) => campaign.id);
  const [drafts, ads, adSetRows, spend] = await Promise.all([
    db.query.adCampaignDrafts.findMany({ where: inArray(adCampaignDrafts.campaignId, ids) }),
    db.query.adAds.findMany({ where: inArray(adAds.campaignId, ids) }),
    db
      .select({ campaignId: adSets.campaignId, status: adSets.status, endDate: adSets.endDate })
      .from(adSets)
      .where(inArray(adSets.campaignId, ids)),
    db
      .select({ campaignId: adMetricsDaily.campaignId, day: adMetricsDaily.day })
      .from(adMetricsDaily)
      .where(
        and(
          eq(adMetricsDaily.level, 'campaign'),
          gt(adMetricsDaily.spendCents, 0),
          gte(adMetricsDaily.day, dayBefore(saoPauloDayOf(since))),
        ),
      ),
  ]);
  return buildAttributionCampaigns({ campaigns: rows, drafts, ads, spend, adSets: adSetRows, now });
}

type Attributed = {
  platform: AdPlatform | null;
  campaignId: string | null;
  adId: string | null;
  attribution: AttributionMethod | null;
  reason: UnattributedReason | null;
};

const unattributedAs = (
  reason: UnattributedReason,
  platform: AdPlatform | null = null,
): Attributed => ({
  platform,
  campaignId: null,
  adId: null,
  attribution: null,
  reason,
});

/**
 * Which campaign a deal came from, in this order:
 *  0. the person arrived before the first day counted (an old lead copied to
 *     RD later): out of the account, whatever else is known;
 *  1. the Wings lead behind the deal says its campaign (Meta instant forms
 *     carry no UTM, but the lead keeps the campaign and ad ids);
 *  2. the UTMs of the conversion: utm_campaign against the campaign's id, name,
 *     the UTMs of its drafts and ads, or a slug of its name; failing that, and
 *     also when there is no utm_campaign at all, utm_content against the ads
 *     of one campaign in force;
 *  3. a paid utm_medium with a utm_source that names a platform (the deal is
 *     bought media whatever RD's source says), else RD's source label: either
 *     way the platform's only campaign in force;
 *  4. otherwise unattributed, with the reason.
 * Only campaigns in force on the day the deal entered can claim it (`enteredDay`);
 * a campaign ends with its own end date or, failing that, with its ad sets.
 */
export function attribute(
  input: {
    utms: Utms | null;
    sourceLabel: string | null;
    campaignLabel: string | null;
    enteredDay?: string;
    lead?: LeadOrigin | null;
    since?: Date;
  },
  campaigns: AttributionCampaign[],
): Attributed {
  if (input.lead && input.since && input.lead.enteredAt.getTime() < input.since.getTime()) {
    return unattributedAs('arrived_before_cutoff');
  }
  if (input.lead?.adCampaignExternalId) {
    const wanted = norm(input.lead.adCampaignExternalId);
    const platform = input.lead.adPlatform;
    const campaign = campaigns.find(
      (candidate) =>
        candidate.externalId === wanted && (!platform || candidate.platform === platform),
    );
    if (!campaign) return unattributedAs('lead_ads_campaign_unknown');
    const adId = input.lead.adExternalId ? norm(input.lead.adExternalId) : null;
    const ad = adId ? campaign.ads.find((candidate) => candidate.externalId === adId) : undefined;
    return {
      platform: campaign.platform,
      campaignId: campaign.id,
      adId: ad?.id ?? null,
      attribution: 'lead_ads',
      reason: null,
    };
  }
  const inForce = campaigns.filter((candidate) => inForceOn(candidate, input.enteredDay));
  const utmCampaign = input.utms?.campaign ? norm(input.utms.campaign) : null;
  const content = input.utms?.content ? norm(input.utms.content) : null;
  // The one campaign in force whose ad carries this utm_content (an ad id or name, long enough not to be a word).
  const campaignOfContent =
    content && content.length >= 10
      ? only(inForce.filter((candidate) => candidate.ads.some((ad) => ad.keys.includes(content))))
      : undefined;
  const utmMatch = (campaign: AttributionCampaign): Attributed => {
    const ad = content
      ? campaign.ads.find((candidate) => candidate.keys.includes(content))
      : undefined;
    return {
      platform: campaign.platform,
      campaignId: campaign.id,
      adId: ad?.id ?? null,
      attribution: 'utm',
      reason: null,
    };
  };
  if (utmCampaign) {
    const campaign =
      inForce.find((candidate) => candidate.keys.includes(utmCampaign)) ??
      (utmCampaign.length >= 12
        ? only(inForce.filter((candidate) => candidate.nameKey?.includes(utmCampaign)))
        : undefined) ??
      campaignOfContent;
    return campaign ? utmMatch(campaign) : unattributedAs('utm_other_campaign');
  }
  // No utm_campaign (a link without it, or a macro that did not expand): the ad alone still names the campaign.
  if (campaignOfContent) return utmMatch(campaignOfContent);

  // A paid utm_medium with a utm_source that names a platform says the click was bought, whatever the RD origin says.
  const utmPlatform = isPaidUtmMedium(input.utms?.medium)
    ? adPlatformOfUtmSource(input.utms?.source)
    : null;
  const platform = utmPlatform ?? platformOfRdLabels(input.sourceLabel, input.campaignLabel);
  if (platform) {
    const candidates = inForce.filter((campaign) => campaign.platform === platform);
    if (candidates.length === 1) {
      return {
        platform,
        campaignId: candidates[0]!.id,
        adId: null,
        attribution: utmPlatform ? 'utm' : 'rd_origin',
        reason: null,
      };
    }
    return unattributedAs(
      candidates.length === 0 ? 'platform_without_active_campaign' : 'platform_ambiguous',
      platform,
    );
  }
  const paid =
    isPaidUtmMedium(input.utms?.medium) ||
    /busca paga|tr[aá]fego pago|m[ií]dia paga|\bads\b/i.test(
      `${input.sourceLabel ?? ''} ${input.campaignLabel ?? ''}`,
    );
  return unattributedAs(paid ? 'paid_no_platform' : 'not_paid');
}

/** How long after a deal enters the UTM of its conversion is asked again while RD has none to give. */
export const UTM_RETRY_MS = 24 * 3_600_000;

/**
 * Whether the UTM of a deal's conversion is to be asked now: never asked, or
 * asked and empty while the deal is still young (RD may have been late).
 */
export function utmLookupDue(
  checkedAt: Date | null,
  stored: Utms | null,
  stillSettling: boolean,
): boolean {
  if (!checkedAt) return true;
  const empty = !stored || !(stored.source || stored.medium || stored.campaign || stored.content);
  return empty && stillSettling;
}

export interface CampaignLeadsSyncResult {
  deals: number;
  tests: number;
  attributed: number;
  unattributed: number;
  /** Deals of people who arrived before the first day counted: in no figure. */
  beforeCutoff: number;
  utmLookups: number;
  utmFailures: number;
}

export async function syncCampaignLeads(
  db: Database,
  input: {
    rdCrmToken: string;
    rdMarketing: RdMarketingCredentials | null;
    box: SecretBox;
    fetchImpl?: typeof fetch;
    now?: Date;
  },
): Promise<CampaignLeadsSyncResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const get = rdCrmGetter(input.rdCrmToken, fetchImpl);
  const marketing = input.rdMarketing ? rdMarketingReader(input.rdMarketing, fetchImpl) : null;

  const pipelines = await get<RdPipeline[]>('/deal_pipelines', {});
  const stageOf = new Map<string, { pipeline: string; stage: string; order: number }>();
  for (const pipeline of pipelines) {
    pipeline.deal_stages.forEach((stage, index) =>
      stageOf.set(stage.id, { pipeline: pipeline.name, stage: stage.name, order: index + 1 }),
    );
  }

  const since = new Date(CAMPAIGN_LEADS_SINCE);
  const saoPaulo = (at: Date) =>
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'medium',
    })
      .format(at)
      .replace(' ', 'T');
  const deals: RdDeal[] = [];
  let next: string | null = null;
  do {
    const page: { deals?: RdDeal[]; has_more?: boolean; next_page?: string } = await get('/deals', {
      limit: '200',
      created_at_period: 'true',
      start_date: saoPaulo(since),
      end_date: saoPaulo(now),
      ...(next ? { next_page: next } : {}),
    });
    deals.push(...(page.deals ?? []));
    next = page.has_more && page.next_page ? page.next_page : null;
  } while (next);

  const formatacao = deals.filter(
    (deal) =>
      Date.parse(deal.created_at) >= since.getTime() &&
      isFormatacaoPipeline(stageOf.get(deal.deal_stage?.id ?? '')?.pipeline ?? ''),
  );
  const result: CampaignLeadsSyncResult = {
    deals: formatacao.length,
    tests: 0,
    attributed: 0,
    unattributed: 0,
    beforeCutoff: 0,
    utmLookups: 0,
    utmFailures: 0,
  };
  if (formatacao.length === 0) return result;

  const [campaigns, existingRows, wingsLeads, staff] = await Promise.all([
    attributionCampaigns(db, now, since),
    db.query.campaignLeads.findMany({
      where: inArray(
        campaignLeads.rdDealId,
        formatacao.map((deal) => deal.id),
      ),
    }),
    db
      .select({
        rdDealId: leads.rdDealId,
        enteredAt: leads.enteredAt,
        adPlatform: leads.adPlatform,
        adCampaignExternalId: leads.adCampaignExternalId,
        adExternalId: leads.adExternalId,
      })
      .from(leads)
      .where(
        inArray(
          leads.rdDealId,
          formatacao.map((deal) => deal.id),
        ),
      ),
    db
      .select({ id: employees.id, email: sql<string>`lower(${employees.email})` })
      .from(employees)
      .where(eq(employees.status, 'active')),
  ]);
  const existing = new Map(existingRows.map((row) => [row.rdDealId, row]));
  const wingsLeadOf = new Map(
    wingsLeads.flatMap((row) => (row.rdDealId ? [[row.rdDealId, row] as const] : [])),
  );
  const employeeByEmail = new Map(staff.map((row) => [row.email, row.id]));

  for (const deal of formatacao) {
    const before = existing.get(deal.id);
    const stage = stageOf.get(deal.deal_stage?.id ?? '') ?? {
      pipeline: '(desconhecido)',
      stage: '(desconhecida)',
      order: 0,
    };
    const lostReason = deal.deal_lost_reason?.name ?? null;
    const isTest = isTestDeal(deal.name ?? null, lostReason);
    if (isTest) result.tests += 1;
    const contact = deal.contacts?.[0];
    const email =
      contact?.emails
        ?.find((entry) => entry.email)
        ?.email?.trim()
        .toLowerCase() ?? null;
    const phone = contact?.phones?.find((entry) => entry.phone)?.phone?.trim() ?? null;
    const enteredAt = new Date(deal.created_at);

    // UTMs: asked once per lead once RD answered with one; a failed call is asked again next time.
    // An empty answer is asked again for UTM_RETRY_MS after the deal entered: RD Marketing may
    // not have recorded the conversion yet when the deal first shows up in the CRM.
    let utms: Utms | null = before?.utmCheckedAt
      ? {
          source: before.utmSource,
          medium: before.utmMedium,
          campaign: before.utmCampaign,
          content: before.utmContent,
        }
      : null;
    let utmCheckedAt = before?.utmCheckedAt ?? null;
    const stillSettling = now.getTime() - enteredAt.getTime() < UTM_RETRY_MS;
    if (!isTest && marketing && email && utmLookupDue(utmCheckedAt, utms, stillSettling)) {
      result.utmLookups += 1;
      try {
        const found = await marketing.utmsOf(email, enteredAt);
        if (found) utms = found;
        if (found || !stillSettling) utmCheckedAt = now;
      } catch {
        result.utmFailures += 1;
      }
    }

    const sourceLabel = deal.deal_source?.name ?? null;
    const campaignLabel = deal.campaign?.name ?? null;
    // Once attributed, a lead keeps its campaign even after the campaign ends.
    const decided =
      before?.campaignId && before.attribution
        ? {
            platform: before.platform as AdPlatform | null,
            campaignId: before.campaignId,
            adId: before.adId,
            attribution: before.attribution as AttributionMethod,
            reason: null,
          }
        : attribute(
            {
              utms,
              sourceLabel,
              campaignLabel,
              enteredDay: saoPauloDayOf(enteredAt),
              lead: wingsLeadOf.get(deal.id) ?? null,
              since,
            },
            campaigns,
          );
    if (!isTest) {
      if (decided.campaignId) result.attributed += 1;
      else if (decided.reason === 'arrived_before_cutoff') result.beforeCutoff += 1;
      else result.unattributed += 1;
    }

    // First contact: the earliest note or finished task in RD; failing that,
    // the stage leaving "Sem contato" as this sync saw it.
    let firstContactAt = before?.firstContactAt ?? null;
    let firstContactSource = before?.firstContactSource ?? null;
    if (!firstContactAt && !isTest) {
      const [activities, tasks] = await Promise.all([
        get<{ activities?: { created_at?: string }[] }>('/activities', { deal_id: deal.id }),
        get<{ tasks?: { done?: boolean; done_date?: string | null }[] }>('/tasks', {
          deal_id: deal.id,
        }),
      ]);
      const moments = [
        ...(activities.activities ?? []).map((entry) => entry.created_at),
        ...(tasks.tasks ?? []).filter((task) => task.done).map((task) => task.done_date),
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => new Date(value))
        .filter((at) => at.getTime() >= enteredAt.getTime())
        .sort((a, b) => a.getTime() - b.getTime());
      if (moments[0]) {
        firstContactAt = moments[0];
        firstContactSource = 'activity';
      } else if (stage.order > 1) {
        // Seen in "Sem contato" before: it moved since the last sync. First
        // seen already beyond it: RD's last change is the best clock there is.
        firstContactAt =
          before && before.stageOrder <= 1
            ? now
            : new Date(deal.last_activity_at ?? deal.updated_at ?? now.toISOString());
        firstContactSource = 'stage';
      }
    }

    const ownerEmail = deal.user?.email?.trim().toLowerCase() ?? null;
    const values = {
      enteredAt,
      pipeline: stage.pipeline,
      stage: stage.stage,
      stageOrder: stage.order,
      win: deal.win,
      closedAt: deal.closed_at ? new Date(deal.closed_at) : null,
      lostReason,
      isTest,
      amountCents: Math.round((deal.amount_total ?? 0) * 100),
      name: contact?.name?.trim() || null,
      company: deal.organization?.name?.trim() || null,
      segment: deal.organization?.organization_segments?.[0]?.name?.trim() || null,
      city: deal.organization?.address?.city?.trim() || null,
      emailEncrypted: email ? input.box.seal(email) : null,
      phoneEncrypted: phone ? input.box.seal(phone) : null,
      emailMasked: email ? maskEmail(email) : null,
      phoneMasked: phone ? maskPhone(phone) : null,
      ownerRdId: deal.user?.id ?? null,
      ownerName: deal.user?.name?.trim() || null,
      ownerEmployeeId: (ownerEmail && employeeByEmail.get(ownerEmail)) || null,
      rating: deal.rating ?? null,
      lastActivityAt: deal.last_activity_at ? new Date(deal.last_activity_at) : null,
      rdSourceLabel: sourceLabel,
      rdCampaignLabel: campaignLabel,
      utmSource: utms?.source ?? null,
      utmMedium: utms?.medium ?? null,
      utmCampaign: utms?.campaign ?? null,
      utmContent: utms?.content ?? null,
      utmCheckedAt,
      platform: decided.platform,
      campaignId: decided.campaignId,
      adId: decided.adId,
      attribution: decided.attribution,
      unattributedReason: decided.reason,
      firstContactAt,
      firstContactSource,
      fetchedAt: now,
    };
    await db
      .insert(campaignLeads)
      .values({ rdDealId: deal.id, ...values })
      .onConflictDoUpdate({ target: campaignLeads.rdDealId, set: values });
  }
  return result;
}
