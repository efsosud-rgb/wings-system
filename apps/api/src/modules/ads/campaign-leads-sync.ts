import {
  adPlatformOfUtmSource,
  brazilianPhoneVariants,
  CAMPAIGN_LEADS_SINCE,
  campaignDelivering,
  effectiveCampaignEnd,
  hasTestWord,
  isFormatacaoPipeline,
  isPaidUtmMedium,
  isTestDeal,
  maskEmail,
  maskPhone,
  normalizeBrazilianPhone,
  normalizeEmail,
  type AdPlatform,
  type AttributionMethod,
  utmSourceName,
  type UnattributedReason,
} from '@wings/shared';
import { and, eq, gt, gte, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
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
  leadEvents,
  leads,
} from '../../db/schema/index.js';
import { paramsOfAddress } from '../../lib/query-params.js';
import type { SecretBox } from '../../lib/secret-box.js';
import { platformOfRdLabels, rdCrmGetter, type RdPipeline } from './funnel-sync.js';

/**
 * Leads das Campanhas: every 15 minutes (with `ingest-cli --reconcile-only`),
 * the Formatação deals RD CRM created since 28/09 are copied with their
 * contact (name in text, e-mail and phone sealed), their owner, their stage
 * and the campaign and ad they came from. The Wings leads of the funnel are
 * read too (`syncWingsLeads`): a lead RD holds no deal for gets a row of its
 * own, and a deal that belongs to a lead we can tell only by the contact (the
 * RD copy of this environment is off, another environment made the deal) is
 * joined to that lead, so a person is listed once and the lead's campaign,
 * ad, owner and stage win.
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
    const ownAdSets = (input.adSets ?? []).filter((adSet) => adSet.campaignId === campaign.id);
    // The days a campaign may have delivered: judged for a deal that entered in the past, so an ad
    // set paused since still counts (spend that day decides the rest). Whether it delivers now
    // looks only at the ad sets that are on.
    const endDate = effectiveCampaignEnd(
      campaign.endDate,
      ownAdSets.map((adSet) => ({ ...adSet, status: 'ACTIVE' })),
    );
    const endNow = effectiveCampaignEnd(campaign.endDate, ownAdSets);
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
          endDate: endNow,
          // The attribution of a lead already judges the days a campaign spent (`spendDays`, in
          // `inForceOn`); the "spent in the last 24 h" rule of the screens would change which
          // campaign a lead is credited to, so it stays out of here (d-t036, DUVIDAS.md).
          spentLast24h: false,
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

  // A paid utm_medium with a utm_source that names a platform says the click was bought, whatever
  // RD's origin says. Each platform guess claims the deal only when it has exactly one campaign in
  // force; a guess that fails does not stop the other (UTM says Google with none running, RD says
  // Facebook with one).
  const claimByPlatform = (platform: AdPlatform, method: AttributionMethod): Attributed => {
    const candidates = inForce.filter((campaign) => campaign.platform === platform);
    if (candidates.length === 1) {
      return {
        platform,
        campaignId: candidates[0]!.id,
        adId: null,
        attribution: method,
        reason: null,
      };
    }
    return unattributedAs(
      candidates.length === 0 ? 'platform_without_active_campaign' : 'platform_ambiguous',
      platform,
    );
  };
  const utmPlatform = isPaidUtmMedium(input.utms?.medium)
    ? adPlatformOfUtmSource(input.utms?.source)
    : null;
  const labelPlatform = platformOfRdLabels(input.sourceLabel, input.campaignLabel);
  const guesses: { platform: AdPlatform; method: AttributionMethod }[] = [];
  if (utmPlatform) guesses.push({ platform: utmPlatform, method: 'utm' });
  if (labelPlatform && labelPlatform !== utmPlatform) {
    guesses.push({ platform: labelPlatform, method: 'rd_origin' });
  }
  let failure: Attributed | null = null;
  for (const guess of guesses) {
    const claimed = claimByPlatform(guess.platform, guess.method);
    if (claimed.campaignId) return claimed;
    failure ??= claimed;
  }
  if (failure) return failure;
  const paid =
    isPaidUtmMedium(input.utms?.medium) ||
    /busca paga|tr[aá]fego pago|m[ií]dia paga|\bads\b/i.test(
      `${input.sourceLabel ?? ''} ${input.campaignLabel ?? ''}`,
    );
  return unattributedAs(paid ? 'paid_no_platform' : 'not_paid');
}

/**
 * An attribution that was a guess, not a finding: RD's origin picking the platform's only campaign,
 * or a paid UTM that named the platform and no campaign or ad. The real UTM may still refine it.
 */
export function isGuessedAttribution(row: {
  attribution: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
}): boolean {
  return (
    row.attribution === 'rd_origin' ||
    (row.attribution === 'utm' && !row.utmCampaign && !row.utmContent)
  );
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
  /** Wings leads that got their campaign and ad from their conversion's UTMs (`fillLeadAttribution`). */
  leadsFilled: number;
  /** Wings leads listed on their own: RD holds no deal for them. */
  wingsLeads: number;
  /** RD deals joined to a Wings lead by the contact (the lead does not name the deal). */
  paired: number;
}

/** A Wings lead of the funnel that campaigns may have brought, whose `rd_deal_id` is empty. */
const wingsLeadColumns = {
  id: leads.id,
  name: leads.name,
  email: leads.email,
  phone: leads.phone,
  source: leads.source,
  city: leads.city,
  companyName: leads.companyName,
  stage: leads.stage,
  stageOrder: leads.stageOrder,
  won: leads.won,
  closedAt: leads.closedAt,
  lostReason: leads.lostReason,
  valueCents: leads.valueCents,
  ownerEmployeeId: leads.ownerEmployeeId,
  stageChangedAt: leads.stageChangedAt,
  firstContactAt: leads.firstContactAt,
  enteredAt: leads.enteredAt,
  adPlatform: leads.adPlatform,
  adCampaignExternalId: leads.adCampaignExternalId,
  adExternalId: leads.adExternalId,
  utmSource: leads.utmSource,
  utmMedium: leads.utmMedium,
  utmCampaign: leads.utmCampaign,
  utmContent: leads.utmContent,
};
export type WingsLead = Pick<typeof leads.$inferSelect, keyof typeof wingsLeadColumns>;

/**
 * The leads a campaign may have brought: Formatação funnel, entered since the
 * first day counted, no deal named on the lead, and some trace of paid media
 * (an instant form, the ad ids, a UTM or a click id).
 */
async function wingsCandidates(db: Database, since: Date): Promise<WingsLead[]> {
  return db
    .select(wingsLeadColumns)
    .from(leads)
    .where(
      and(
        eq(leads.pipeline, 'formatacao'),
        isNull(leads.rdDealId),
        gte(leads.enteredAt, since),
        or(
          eq(leads.source, 'meta_lead_ads'),
          eq(leads.source, 'google_lead_form'),
          isNotNull(leads.adPlatform),
          isNotNull(leads.adCampaignExternalId),
          isNotNull(leads.utmSource),
          isNotNull(leads.utmMedium),
          isNotNull(leads.utmCampaign),
          isNotNull(leads.utmContent),
          isNotNull(leads.gclid),
          isNotNull(leads.fbclid),
          isNotNull(leads.gbraid),
          isNotNull(leads.wbraid),
        ),
      ),
    );
}

/** What identifies a person across systems: the e-mail, and the phone in both forms of a Brazilian mobile. */
export function contactKeys(
  email: string | null | undefined,
  phone: string | null | undefined,
): string[] {
  const keys: string[] = [];
  const mail = normalizeEmail(email);
  if (mail) keys.push(`e:${mail}`);
  const digits = normalizeBrazilianPhone(phone);
  if (digits) for (const form of brazilianPhoneVariants(digits)) keys.push(`p:${form}`);
  return keys;
}

/** How far apart a deal and the Wings lead of the same person may have entered. */
export const LEAD_DEAL_WINDOW_MS = 24 * 3_600_000;

/**
 * Which Wings lead each RD deal belongs to when the lead does not name it: the
 * same e-mail or phone, entered within a day of each other, the closest first,
 * a lead for one deal only. Deterministic for the same rows, so every sync
 * answers the same.
 */
export function pairDealsWithLeads(
  deals: { id: string; at: Date; keys: string[] }[],
  candidates: { id: string; at: Date; keys: string[] }[],
  windowMs = LEAD_DEAL_WINDOW_MS,
): Map<string, string> {
  const byKey = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    for (const key of candidate.keys) byKey.set(key, [...(byKey.get(key) ?? []), candidate]);
  }
  const taken = new Set<string>();
  const pairs = new Map<string, string>();
  for (const deal of [...deals].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    let best: (typeof candidates)[number] | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const key of deal.keys) {
      for (const candidate of byKey.get(key) ?? []) {
        if (taken.has(candidate.id)) continue;
        const gap = Math.abs(candidate.at.getTime() - deal.at.getTime());
        if (gap <= windowMs && gap < bestGap) {
          best = candidate;
          bestGap = gap;
        }
      }
    }
    if (best) {
      taken.add(best.id);
      pairs.set(deal.id, best.id);
    }
  }
  return pairs;
}

/** Where a Wings lead stands in the funnel: the columns of the row that the lead decides. */
function wingsWork(lead: WingsLead, ownerName: string | null) {
  return {
    stage: lead.stage ?? 'Sem etapa',
    stageOrder: lead.stageOrder ?? 0,
    win: lead.won,
    closedAt: lead.closedAt,
    lostReason: lead.lostReason,
    amountCents: lead.valueCents ?? 0,
    ownerEmployeeId: lead.ownerEmployeeId,
    ownerName,
    lastActivityAt: lead.stageChangedAt,
    firstContactAt: lead.firstContactAt,
    firstContactSource: lead.firstContactAt ? ('activity' as const) : null,
  };
}

const utmsOfLead = (lead: WingsLead): Utms => ({
  source: lead.utmSource ? utmSourceName(lead.utmSource) : null,
  medium: lead.utmMedium,
  campaign: lead.utmCampaign,
  content: lead.utmContent,
});

interface SyncContext {
  campaigns: AttributionCampaign[];
  employeeByEmail: Map<string, string>;
  /** Active employees' names by id: the owner a Wings lead shows. */
  employeeName: Map<string, string>;
  candidates: WingsLead[];
  since: Date;
  now: Date;
  box: SecretBox;
  result: CampaignLeadsSyncResult;
}

export async function syncCampaignLeads(
  db: Database,
  input: {
    /** Null: RD is not reachable from here (no token); only the Wings leads are read. */
    rdCrmToken: string | null;
    rdMarketing: RdMarketingCredentials | null;
    box: SecretBox;
    fetchImpl?: typeof fetch;
    now?: Date;
  },
): Promise<CampaignLeadsSyncResult> {
  const now = input.now ?? new Date();
  const since = new Date(CAMPAIGN_LEADS_SINCE);
  const result: CampaignLeadsSyncResult = {
    deals: 0,
    tests: 0,
    attributed: 0,
    unattributed: 0,
    beforeCutoff: 0,
    utmLookups: 0,
    utmFailures: 0,
    leadsFilled: 0,
    wingsLeads: 0,
    paired: 0,
  };
  const [campaigns, staff, candidates] = await Promise.all([
    attributionCampaigns(db, now, since),
    db
      .select({
        id: employees.id,
        email: sql<string>`lower(${employees.email})`,
        name: employees.fullName,
      })
      .from(employees)
      .where(eq(employees.status, 'active')),
    wingsCandidates(db, since),
  ]);
  const context: SyncContext = {
    campaigns,
    employeeByEmail: new Map(staff.map((row) => [row.email, row.id])),
    employeeName: new Map(staff.map((row) => [row.id, row.name])),
    candidates,
    since,
    now,
    box: input.box,
    result,
  };
  const paired = input.rdCrmToken
    ? await syncRdDeals(db, { ...input, rdCrmToken: input.rdCrmToken }, context)
    : new Set<string>();
  await syncWingsLeads(db, context, paired);
  return result;
}

/** The RD side: every Formatação deal since the first day counted. Returns the Wings leads it joined to a deal. */
async function syncRdDeals(
  db: Database,
  input: {
    rdCrmToken: string;
    rdMarketing: RdMarketingCredentials | null;
    box: SecretBox;
    fetchImpl?: typeof fetch;
  },
  context: SyncContext,
): Promise<Set<string>> {
  const { campaigns, employeeByEmail, employeeName, candidates, since, now, result } = context;
  const fetchImpl = input.fetchImpl ?? fetch;
  const get = rdCrmGetter(input.rdCrmToken, fetchImpl);
  const marketing = input.rdMarketing ? rdMarketingReader(input.rdMarketing, fetchImpl) : null;
  const claimedLeads = new Set<string>();

  const pipelines = await get<RdPipeline[]>('/deal_pipelines', {});
  const stageOf = new Map<string, { pipeline: string; stage: string; order: number }>();
  for (const pipeline of pipelines) {
    pipeline.deal_stages.forEach((stage, index) =>
      stageOf.set(stage.id, { pipeline: pipeline.name, stage: stage.name, order: index + 1 }),
    );
  }

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
  result.deals = formatacao.length;
  if (formatacao.length === 0) return claimedLeads;

  // The Wings lead behind a deal the lead does not name: same contact, entered about the same time.
  const dealContact = (deal: RdDeal) => {
    const contact = deal.contacts?.[0];
    const email = contact?.emails?.find((entry) => entry.email)?.email;
    const phone = contact?.phones?.find((entry) => entry.phone)?.phone;
    return contactKeys(email, phone);
  };
  const pairs = pairDealsWithLeads(
    formatacao.map((deal) => ({
      id: deal.id,
      at: new Date(deal.created_at),
      keys: dealContact(deal),
    })),
    candidates.map((lead) => ({
      id: lead.id,
      at: lead.enteredAt,
      keys: contactKeys(lead.email, lead.phone),
    })),
  );
  const candidateOf = new Map(candidates.map((lead) => [lead.id, lead]));
  const pairedLeadOf = new Map(
    [...pairs].flatMap(([dealId, leadId]) => {
      const lead = candidateOf.get(leadId);
      return lead ? [[dealId, lead] as const] : [];
    }),
  );
  result.paired = pairedLeadOf.size;
  for (const lead of pairedLeadOf.values()) claimedLeads.add(lead.id);
  await adoptPairedRows(db, pairedLeadOf);

  const [existingRows, wingsLeads] = await Promise.all([
    db.query.campaignLeads.findMany({
      where: inArray(
        campaignLeads.rdDealId,
        formatacao.map((deal) => deal.id),
      ),
    }),
    db
      .select({ rdDealId: leads.rdDealId, ...wingsLeadColumns })
      .from(leads)
      .where(
        inArray(
          leads.rdDealId,
          formatacao.map((deal) => deal.id),
        ),
      ),
  ]);
  const existing = new Map(existingRows.map((row) => [row.rdDealId, row]));
  const wingsLeadOf = new Map(
    wingsLeads.flatMap((row) => (row.rdDealId ? [[row.rdDealId, row] as const] : [])),
  );

  for (const deal of formatacao) {
    const before = existing.get(deal.id);
    const pairedLead = pairedLeadOf.get(deal.id) ?? null;
    const wingsLead = wingsLeadOf.get(deal.id) ?? pairedLead;
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
    // Only a deal that nobody has claimed for sure is worth asking again: one filed under a campaign
    // by something firmer than a guess, or whose Wings lead names it (Meta instant form), has no
    // need of a UTM. A guess (RD's origin, or a paid UTM that only names the platform) stays open to
    // the real UTM while the deal is young.
    const young = now.getTime() - enteredAt.getTime() < UTM_RETRY_MS;
    const filed = Boolean(before?.campaignId && before.attribution);
    const guessed = filed && isGuessedAttribution(before!);
    const firmlyFiled = filed && !(guessed && young);
    const claimed = firmlyFiled || Boolean(wingsLead?.adCampaignExternalId);
    const stillSettling = !claimed && young;
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
    // Once attributed, a lead keeps its campaign even after the campaign ends. A young guess is
    // judged again, and kept if nothing firmer turns up.
    const kept =
      filed && before
        ? {
            platform: before.platform as AdPlatform | null,
            campaignId: before.campaignId,
            adId: before.adId,
            attribution: before.attribution as AttributionMethod,
            reason: null,
          }
        : null;
    const judged = firmlyFiled
      ? null
      : attribute(
          {
            utms,
            sourceLabel,
            campaignLabel,
            enteredDay: saoPauloDayOf(enteredAt),
            lead: wingsLead,
            since,
          },
          campaigns,
        );
    const decided: Attributed = firmlyFiled ? kept! : judged!.campaignId || !kept ? judged! : kept;
    if (!isTest) {
      if (decided.campaignId) result.attributed += 1;
      else if (decided.reason === 'arrived_before_cutoff') result.beforeCutoff += 1;
      else result.unattributed += 1;
    }
    if (
      wingsLead &&
      !isTest &&
      (await fillLeadAttribution(db, wingsLead, decided, utms, campaigns))
    )
      result.leadsFilled += 1;

    // First contact: the earliest note or finished task in RD; failing that,
    // the stage leaving "Sem contato" as this sync saw it.
    let firstContactAt = before?.firstContactAt ?? null;
    let firstContactSource = before?.firstContactSource ?? null;
    // A deal joined to a Wings lead takes the lead's own first contact (below): nobody works it in RD.
    if (!firstContactAt && !isTest && !pairedLead) {
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
    // The Wings lead is worked here, not in RD: its owner, stage and first contact win, the RD
    // owner stays when the lead has none yet.
    const row = pairedLead
      ? (() => {
          const work = wingsWork(
            pairedLead,
            pairedLead.ownerEmployeeId
              ? (employeeName.get(pairedLead.ownerEmployeeId) ?? null)
              : null,
          );
          return {
            ...values,
            ...work,
            ownerEmployeeId: work.ownerEmployeeId ?? values.ownerEmployeeId,
            ownerName: work.ownerEmployeeId ? work.ownerName : values.ownerName,
            leadId: pairedLead.id,
          };
        })()
      : { ...values, leadId: null };
    await db
      .insert(campaignLeads)
      .values({ rdDealId: deal.id, ...row })
      .onConflictDoUpdate({ target: campaignLeads.rdDealId, set: row });
  }
  return claimedLeads;
}

/**
 * The Wings lead behind a deal gets the campaign and ad its conversion's UTMs
 * named (orchestrator, 13/10): a site lead copied from the RD deal comes with
 * no UTM, so its page and the dashboard could not say which campaign brought
 * it. Only a finding (a UTM that names the campaign or the ad), never a guess,
 * and only on a lead that names no campaign or UTM campaign of its own: what
 * the lead already says is never overwritten. Answers whether it wrote.
 */
export async function fillLeadAttribution(
  db: Database,
  lead: WingsLead,
  decided: Attributed,
  utms: Utms | null,
  campaigns: readonly AttributionCampaign[],
): Promise<boolean> {
  if (!decided.campaignId || !utms) return false;
  if (lead.adCampaignExternalId || lead.utmCampaign) return false;
  const campaign = campaigns.find((entry) => entry.id === decided.campaignId);
  // A finding: the UTM attribution itself, or a UTM campaign that is one of this campaign's
  // own keys (an older row may still be labelled with RD's origin while its UTM names it).
  const named = Boolean(utms.campaign && campaign?.keys.includes(norm(utms.campaign)));
  const byUtm =
    decided.attribution === 'utm' &&
    !isGuessedAttribution({
      attribution: decided.attribution,
      utmCampaign: utms.campaign,
      utmContent: utms.content,
    });
  if (!byUtm && !named) return false;
  const ad = decided.adId ? campaign?.ads.find((entry) => entry.id === decided.adId) : undefined;
  const values = {
    utmSource: lead.utmSource ?? (utms.source ? utmSourceName(utms.source) : null),
    utmMedium: lead.utmMedium ?? utms.medium,
    utmCampaign: utms.campaign,
    utmContent: lead.utmContent ?? utms.content,
    adPlatform: lead.adPlatform ?? decided.platform,
    adCampaignExternalId: campaign?.externalId ?? null,
    adExternalId: lead.adExternalId ?? ad?.externalId ?? null,
    updatedAt: new Date(),
  };
  const written = await db
    .update(leads)
    .set(values)
    .where(
      and(eq(leads.id, lead.id), isNull(leads.adCampaignExternalId), isNull(leads.utmCampaign)),
    )
    .returning({ id: leads.id });
  if (written.length === 0) return false;
  await db.insert(leadEvents).values({
    leadId: lead.id,
    kind: 'lead.attribution_filled',
    detail: {
      via: 'rd_marketing_utm',
      campaignId: values.adCampaignExternalId,
      adId: values.adExternalId,
      utmCampaign: values.utmCampaign,
    },
  });
  // The in-memory row follows, so the rest of this sync reads what was written.
  Object.assign(lead, values);
  return true;
}

/**
 * A Wings lead that already has a row of its own (RD held no deal for it when it
 * was read) and whose deal has turned up: the deal takes over that row, so the
 * person stays one and the row keeps its first-seen time. Where the deal already
 * has a row, the lead's own row goes.
 */
async function adoptPairedRows(
  db: Database,
  pairedLeadOf: Map<string, { id: string }>,
): Promise<void> {
  if (pairedLeadOf.size === 0) return;
  const ownRows = await db.query.campaignLeads.findMany({
    where: and(
      isNull(campaignLeads.rdDealId),
      inArray(
        campaignLeads.leadId,
        [...pairedLeadOf.values()].map((lead) => lead.id),
      ),
    ),
    columns: { id: true, leadId: true },
  });
  if (ownRows.length === 0) return;
  const dealRows = await db.query.campaignLeads.findMany({
    where: inArray(campaignLeads.rdDealId, [...pairedLeadOf.keys()]),
    columns: { rdDealId: true },
  });
  const withDealRow = new Set(dealRows.map((row) => row.rdDealId));
  for (const [dealId, lead] of pairedLeadOf) {
    const own = ownRows.find((row) => row.leadId === lead.id);
    if (!own) continue;
    if (withDealRow.has(dealId)) {
      await db.delete(campaignLeads).where(eq(campaignLeads.id, own.id));
    } else {
      await db.update(campaignLeads).set({ rdDealId: dealId }).where(eq(campaignLeads.id, own.id));
    }
  }
}

/**
 * The Wings side: a lead that campaigns may have brought and that no RD deal
 * claims gets a row of its own, attributed like a deal (the campaign and ad
 * the lead carries, else its UTMs), judged on the day the lead entered.
 * Rows of leads that RD has since claimed, or that stopped qualifying, go.
 */
async function syncWingsLeads(
  db: Database,
  context: SyncContext,
  claimed: Set<string>,
): Promise<void> {
  const { campaigns, employeeName, since, now, box, result } = context;
  const own = context.candidates.filter((lead) => !claimed.has(lead.id));
  const ownIds = own.map((lead) => lead.id);
  await db
    .delete(campaignLeads)
    .where(
      and(
        isNull(campaignLeads.rdDealId),
        ownIds.length ? notInArray(campaignLeads.leadId, ownIds) : sql`true`,
      ),
    );
  if (own.length === 0) return;
  const rows = await db.query.campaignLeads.findMany({
    where: inArray(campaignLeads.leadId, ownIds),
  });
  const before = new Map(rows.map((row) => [row.leadId, row]));

  for (const lead of own) {
    const previous = before.get(lead.id);
    const isTest = isTestDeal(lead.name, lead.lostReason) || hasTestWord(lead.email);
    const filed = Boolean(previous?.campaignId && previous.attribution);
    const keep = filed && !isGuessedAttribution(previous!);
    const decided: Attributed = keep
      ? {
          platform: previous!.platform as AdPlatform | null,
          campaignId: previous!.campaignId,
          adId: previous!.adId,
          attribution: previous!.attribution as AttributionMethod,
          reason: null,
        }
      : attribute(
          {
            utms: utmsOfLead(lead),
            sourceLabel: null,
            campaignLabel: null,
            enteredDay: saoPauloDayOf(lead.enteredAt),
            lead,
            since,
          },
          campaigns,
        );
    result.wingsLeads += 1;
    if (!isTest) {
      if (decided.campaignId) result.attributed += 1;
      else if (decided.reason === 'arrived_before_cutoff') result.beforeCutoff += 1;
      else result.unattributed += 1;
    } else {
      result.tests += 1;
    }
    const email = normalizeEmail(lead.email);
    const phone = normalizeBrazilianPhone(lead.phone);
    const work = wingsWork(
      lead,
      lead.ownerEmployeeId ? (employeeName.get(lead.ownerEmployeeId) ?? null) : null,
    );
    const values = {
      ...work,
      enteredAt: lead.enteredAt,
      pipeline: 'Formatação',
      isTest,
      name: lead.name?.trim() || null,
      company: lead.companyName?.trim() || null,
      segment: null,
      city: lead.city?.trim() || null,
      emailEncrypted: email ? box.seal(email) : null,
      phoneEncrypted: phone ? box.seal(phone) : null,
      emailMasked: email ? maskEmail(email) : null,
      phoneMasked: phone ? maskPhone(phone) : null,
      ownerRdId: null,
      rating: null,
      rdSourceLabel: null,
      rdCampaignLabel: null,
      utmSource: lead.utmSource,
      utmMedium: lead.utmMedium,
      utmCampaign: lead.utmCampaign,
      utmContent: lead.utmContent,
      utmCheckedAt: null,
      platform: decided.platform,
      campaignId: decided.campaignId,
      adId: decided.adId,
      attribution: decided.attribution,
      unattributedReason: decided.reason,
      fetchedAt: now,
    };
    await db
      .insert(campaignLeads)
      .values({ leadId: lead.id, rdDealId: null, ...values })
      .onConflictDoUpdate({ target: campaignLeads.leadId, set: values });
  }
}
