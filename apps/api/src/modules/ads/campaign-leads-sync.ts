import {
  CAMPAIGN_LEADS_SINCE,
  campaignDelivering,
  isFormatacaoPipeline,
  isTestDeal,
  maskEmail,
  maskPhone,
  type AdPlatform,
  type AttributionMethod,
  type UnattributedReason,
} from '@wings/shared';
import { eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAccounts,
  adAds,
  adCampaignDrafts,
  adCampaigns,
  campaignLeads,
  employees,
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
 * Attribution, in this order:
 *  1. the UTMs of the contact's conversion in RD Marketing (asked once per
 *     lead): utm_campaign names the campaign, utm_content the ad;
 *  2. RD's own source label ("Busca Paga | Facebook" / "| Google") when the
 *     platform has exactly one active campaign;
 *  3. otherwise not attributed, with the reason.
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
    return {
      source: pick('source'),
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

interface ActiveCampaign {
  id: string;
  platform: AdPlatform;
  keys: string[];
  ads: { id: string; keys: string[] }[];
}

/** The campaigns delivering now, with the words a UTM may use for each and for their ads. */
async function activeCampaigns(db: Database, now: Date): Promise<ActiveCampaign[]> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
  const rows = await db
    .select({ campaign: adCampaigns, platform: adAccounts.platform })
    .from(adCampaigns)
    .innerJoin(adAccounts, eq(adAccounts.id, adCampaigns.adAccountId))
    .where(isNull(adAccounts.archivedAt));
  const active = rows.filter(({ campaign, platform }) =>
    campaignDelivering(
      {
        platform: platform as AdPlatform,
        status: campaign.status,
        deliveryStatus: campaign.deliveryStatus,
        endDate: campaign.endDate,
      },
      today,
    ),
  );
  if (active.length === 0) return [];
  const ids = active.map(({ campaign }) => campaign.id);
  const [drafts, ads] = await Promise.all([
    db.query.adCampaignDrafts.findMany({ where: inArray(adCampaignDrafts.campaignId, ids) }),
    db.query.adAds.findMany({ where: inArray(adAds.campaignId, ids) }),
  ]);
  return active.map(({ campaign, platform }) => {
    const utm = drafts
      .filter((draft) => draft.campaignId === campaign.id)
      .map(
        (draft) =>
          (draft.payload as { utms?: { utm_campaign?: string } } | null)?.utms?.utm_campaign,
      )
      .filter((value): value is string => Boolean(value));
    return {
      id: campaign.id,
      platform: platform as AdPlatform,
      keys: [...new Set([campaign.externalId, campaign.name, ...utm].map(norm))],
      ads: ads
        .filter((ad) => ad.campaignId === campaign.id)
        .map((ad) => ({ id: ad.id, keys: [norm(ad.externalId), norm(ad.name)] })),
    };
  });
}

export function attribute(
  input: { utms: Utms | null; sourceLabel: string | null; campaignLabel: string | null },
  active: ActiveCampaign[],
): {
  platform: AdPlatform | null;
  campaignId: string | null;
  adId: string | null;
  attribution: AttributionMethod | null;
  reason: UnattributedReason | null;
} {
  const utmCampaign = input.utms?.campaign ? norm(input.utms.campaign) : null;
  if (utmCampaign) {
    const campaign = active.find((candidate) => candidate.keys.includes(utmCampaign));
    if (campaign) {
      const content = input.utms?.content ? norm(input.utms.content) : null;
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
    }
    return {
      platform: null,
      campaignId: null,
      adId: null,
      attribution: null,
      reason: 'utm_other_campaign',
    };
  }
  const platform = platformOfRdLabels(input.sourceLabel, input.campaignLabel);
  if (platform) {
    const candidates = active.filter((campaign) => campaign.platform === platform);
    if (candidates.length === 1) {
      return {
        platform,
        campaignId: candidates[0]!.id,
        adId: null,
        attribution: 'rd_origin',
        reason: null,
      };
    }
    return {
      platform,
      campaignId: null,
      adId: null,
      attribution: null,
      reason: candidates.length === 0 ? 'platform_without_active_campaign' : 'platform_ambiguous',
    };
  }
  const paid = /busca paga|tr[aá]fego pago|m[ií]dia paga|\bads\b/i.test(
    `${input.sourceLabel ?? ''} ${input.campaignLabel ?? ''}`,
  );
  return {
    platform: null,
    campaignId: null,
    adId: null,
    attribution: null,
    reason: paid ? 'paid_no_platform' : 'not_paid',
  };
}

export interface CampaignLeadsSyncResult {
  deals: number;
  tests: number;
  attributed: number;
  unattributed: number;
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
    utmLookups: 0,
    utmFailures: 0,
  };
  if (formatacao.length === 0) return result;

  const [active, existingRows, staff] = await Promise.all([
    activeCampaigns(db, now),
    db.query.campaignLeads.findMany({
      where: inArray(
        campaignLeads.rdDealId,
        formatacao.map((deal) => deal.id),
      ),
    }),
    db
      .select({ id: employees.id, email: sql<string>`lower(${employees.email})` })
      .from(employees)
      .where(eq(employees.status, 'active')),
  ]);
  const existing = new Map(existingRows.map((row) => [row.rdDealId, row]));
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

    // UTMs: asked once per lead; a failed call is asked again next time.
    let utms: Utms | null = before?.utmCheckedAt
      ? {
          source: before.utmSource,
          medium: before.utmMedium,
          campaign: before.utmCampaign,
          content: before.utmContent,
        }
      : null;
    let utmCheckedAt = before?.utmCheckedAt ?? null;
    if (!utmCheckedAt && !isTest && marketing && email) {
      result.utmLookups += 1;
      try {
        utms = await marketing.utmsOf(email, enteredAt);
        utmCheckedAt = now;
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
        : attribute({ utms, sourceLabel, campaignLabel }, active);
    if (!isTest) {
      if (decided.campaignId) result.attributed += 1;
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
