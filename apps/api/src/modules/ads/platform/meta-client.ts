import {
  centsFromDecimalCurrencyString,
  centsFromMinorUnitString,
  creativeFormatOf,
  utmContentOfCreative,
  fundingKindOf,
  prepaidBalanceFromDisplay,
  spendCapFromString,
  sumActionValues,
} from './meta-parse.js';
import type { Cents } from './money.js';
import type {
  AdsPlatformClient,
  BreakdownInsightRow,
  BreakdownKind,
  CampaignStatus,
  ConversionSource,
  CreateCampaignSpec,
  InsightRow,
  MetricsLevel,
  MutationOutcome,
  PlatformAccount,
  PlatformAd,
  PlatformAdSet,
  PlatformCampaign,
  ResolvedTargeting,
  SpendRow,
} from './types.js';

/**
 * Live Meta Marketing API client — **read-only**.
 *
 * Every mutating method throws. Writing to a live ad account is not enabled
 * until the execution stage, and until then the guarantee is structural rather
 * than a matter of discipline: there is no code path here that can change
 * anything on Meta, so no bug, no misconfiguration and no agent can spend
 * money through this client.
 */

export class MetaWritesDisabledError extends Error {
  constructor(operation: string) {
    super(
      `${operation} is disabled: the live Meta client is read-only until the execution stage is approved.`,
    );
    this.name = 'MetaWritesDisabledError';
  }
}

export class MetaApiError extends Error {
  readonly code: number | string;
  readonly subcode?: number;
  readonly fbtraceId?: string;

  constructor(code: number | string, message: string, subcode?: number, fbtraceId?: string) {
    super(message);
    this.name = 'MetaApiError';
    this.code = code;
    this.subcode = subcode;
    this.fbtraceId = fbtraceId;
  }

  /** True when the credential itself is the problem, so the agent must stop. */
  get isCredentialFailure(): boolean {
    return this.code === 190 || this.code === 102;
  }

  get isRateLimit(): boolean {
    return this.code === 17 || this.code === 613 || this.code === 80004;
  }

  /**
   * True when the token simply lacks a permission for what was asked (#10,
   * and the 200–299 family). A field the token may not read is "não
   * disponível", not a broken account: the ingest job records that and goes on.
   */
  get isPermissionDenied(): boolean {
    const code = Number(this.code);
    return code === 10 || (code >= 200 && code <= 299);
  }
}

export interface MetaClientOptions {
  accessToken: string;
  /** Account id including the act_ prefix. */
  adAccountId: string;
  apiVersion?: string;
  timeoutMs?: number;
  /** Injected in tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** The pixel whose firing `getConversionSources` reports. Absent: no source to report. */
  pixelId?: string;
}

interface MetaErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

/**
 * How many days of insights to ask for at a time, per level.
 *
 * Measured against the live account (660 ads), not guessed:
 *
 *   ad level, 1 day  -> 11,4s for 5 rows
 *   ad level, 3 days -> 16,7s for 21 rows
 *   ad level, 7 days -> HTTP 500 after 30,2s
 *
 * The cost is Meta's aggregation across every ad in the account, not the rows
 * returned: five rows still take eleven seconds, and a smaller page size barely
 * moves it. So the window has to be one day at ad level, and the request needs
 * longer than the default timeout to survive.
 */
export const INSIGHT_WINDOW_DAYS: Record<MetricsLevel, number> = {
  campaign: 30,
  ad_set: 15,
  ad: 1,
};

/** Insights are slow by nature; the default timeout is for ordinary reads. */
export const INSIGHTS_TIMEOUT_MS = 45_000;
/**
 * The ads listing expands every creative (story spec included) and timed out
 * at the default 15 s on the first real run with 660 ads; it gets the same
 * patience as insights, and fewer, larger pages.
 */
export const ADS_LIST_TIMEOUT_MS = 45_000;
export const ADS_PAGE_SIZE = '50';

/**
 * ThruPlays, the watched quartiles, every start of the video and the average
 * time watched per start; 3-second plays come from `actions`. NOT verified
 * live: `video_avg_time_watched_actions` at ad level on this account.
 */
export const VIDEO_FIELDS = [
  'video_play_actions',
  'video_avg_time_watched_actions',
  'video_thruplay_watched_actions',
  'video_p25_watched_actions',
  'video_p50_watched_actions',
  'video_p75_watched_actions',
  'video_p100_watched_actions',
] as const;

const text = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value);

/**
 * Meta's breakdown parameters per split, and how the answer's columns become
 * a key. The hourly value is a range ("14:00:00 - 14:59:59"); only the hour
 * is kept.
 */
const BREAKDOWN_SPEC: Record<
  BreakdownKind,
  {
    breakdowns: string[];
    reach: boolean;
    key: (row: Record<string, unknown>) => string;
    subKey: (row: Record<string, unknown>) => string;
  }
> = {
  placement: {
    breakdowns: ['publisher_platform', 'platform_position'],
    reach: true,
    key: (row) => text(row.publisher_platform),
    subKey: (row) => text(row.platform_position),
  },
  age_gender: {
    breakdowns: ['age', 'gender'],
    reach: true,
    key: (row) => text(row.age),
    subKey: (row) => text(row.gender),
  },
  region: {
    breakdowns: ['region'],
    reach: true,
    key: (row) => text(row.region),
    subKey: () => '',
  },
  hour: {
    breakdowns: ['hourly_stats_aggregated_by_advertiser_time_zone'],
    reach: false,
    key: (row) => text(row.hourly_stats_aggregated_by_advertiser_time_zone).slice(0, 2),
    subKey: () => '',
  },
  // mobile_app, mobile_web, desktop. Confirmed live 2026-09-23 on this
  // account: `mobile_app` came back for every row seen so far (`desktop` and
  // `mobile_web` not yet observed — no spend on those placements in the
  // window checked).
  device: {
    breakdowns: ['device_platform'],
    reach: true,
    key: (row) => text(row.device_platform),
    subKey: () => '',
  },
};

/** A pixel that fired within this many days is measuring. */
const PIXEL_ACTIVE_DAYS = 7;

/**
 * Splits an inclusive date range into consecutive windows of at most `days`.
 *
 * Both ends are inclusive, matching Meta's `time_range`, so a 3-day window
 * starting on the 1st ends on the 3rd and the next starts on the 4th.
 */
export function sliceDateRange(
  sinceDate: string,
  untilDate: string,
  days: number,
): [string, string][] {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = Date.parse(`${sinceDate}T00:00:00Z`);
  const end = Date.parse(`${untilDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(`invalid date range: ${sinceDate}..${untilDate}`);
  }
  if (end < start) return [];
  const size = Math.max(1, Math.floor(days));

  const windows: [string, string][] = [];
  for (let from = start; from <= end; from += size * dayMs) {
    const to = Math.min(from + (size - 1) * dayMs, end);
    windows.push([
      new Date(from).toISOString().slice(0, 10),
      new Date(to).toISOString().slice(0, 10),
    ]);
  }
  return windows;
}

/** State names as Meta's location search knows them (it folds accents itself). */
export const BRAZIL_STATE_NAMES: Record<string, string> = {
  AC: 'Acre',
  AL: 'Alagoas',
  AP: 'Amapá',
  AM: 'Amazonas',
  BA: 'Bahia',
  CE: 'Ceará',
  DF: 'Distrito Federal',
  ES: 'Espírito Santo',
  GO: 'Goiás',
  MA: 'Maranhão',
  MT: 'Mato Grosso',
  MS: 'Mato Grosso do Sul',
  MG: 'Minas Gerais',
  PA: 'Pará',
  PB: 'Paraíba',
  PR: 'Paraná',
  PE: 'Pernambuco',
  PI: 'Piauí',
  RJ: 'Rio de Janeiro',
  RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul',
  RO: 'Rondônia',
  RR: 'Roraima',
  SC: 'Santa Catarina',
  SP: 'São Paulo',
  SE: 'Sergipe',
  TO: 'Tocantins',
};

/** Lower case, no accents, no "(state)" suffix: how two spellings of a place compare. */
export function foldPlaceName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*\((state|estado)\)\s*$/, '')
    .trim();
}

/** A place, or the language, that Meta's search could not pin to one result. */
export class TargetingResolutionError extends Error {
  constructor(
    readonly asked: string,
    readonly matches: number,
  ) {
    super(
      matches === 0
        ? `A Meta não conhece "${asked}"`
        : `"${asked}" corresponde a ${matches} resultados na Meta; escreva o nome como aparece no Gerenciador de Anúncios`,
    );
    this.name = 'TargetingResolutionError';
  }
}

export class MetaReadOnlyClient implements AdsPlatformClient {
  readonly platform = 'meta' as const;
  /** Points at a real ad account: treat every call as consequential. */
  readonly isLive = true;

  private readonly token: string;
  private readonly accountId: string;
  /** Which account this client is bound to; checked before any mirroring. */
  get accountExternalId(): string {
    return this.accountId;
  }
  /** Exposed for the write client, which posts to the same account path. */
  protected get adAccountPath(): string {
    return this.accountId;
  }
  private readonly version: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly pixelId: string | null;

  constructor(options: MetaClientOptions) {
    if (!options.accessToken) throw new Error('Meta access token is required');
    if (!/^act_\d+$/.test(options.adAccountId)) {
      throw new Error(`Invalid Meta ad account id: ${options.adAccountId} (expected act_<digits>)`);
    }
    this.token = options.accessToken;
    this.accountId = options.adAccountId;
    this.version = options.apiVersion ?? 'v23.0';
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pixelId = options.pixelId && /^\d{5,25}$/.test(options.pixelId) ? options.pixelId : null;
  }

  /**
   * Follows Meta's cursor paging and concatenates `data`.
   *
   * The live account has 84 campaigns, 202 ad sets and 660 ads; asking for all
   * of it in one page makes Meta answer "Please reduce the amount of data
   * you're asking for" rather than truncating, so paging is not an
   * optimisation here, it is the only way the call succeeds.
   */
  protected async getAllPages<T>(
    path: string,
    params: Record<string, string> = {},
    maxPages = 50,
    timeoutMs?: number,
  ): Promise<T[]> {
    const collected: T[] = [];
    let after: string | undefined;
    const seenCursors = new Set<string>();

    for (let page = 0; page < maxPages; page += 1) {
      const body = await this.get<{
        data: T[];
        paging?: { next?: string; cursors?: { after?: string } };
      }>(path, { ...params, ...(after ? { after } : {}) }, timeoutMs);

      collected.push(...(body.data ?? []));

      // `cursors.after` is present even on the LAST page — only `paging.next`
      // tells you another page exists. Reading the cursor alone loops forever.
      if (!body.paging?.next) break;

      after = body.paging.cursors?.after;
      if (!after || seenCursors.has(after)) break;
      seenCursors.add(after);
    }
    return collected;
  }

  protected async get<T>(
    path: string,
    params: Record<string, string> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const url = new URL(`https://graph.facebook.com/${this.version}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // The token travels in a header, never in the query string, so it cannot
    // end up in a proxy log or an error message containing the URL.
    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body: unknown = await response.json();
    if (!response.ok) {
      const error = (body as MetaErrorBody).error ?? {};
      throw new MetaApiError(
        error.code ?? response.status,
        error.message ?? `Meta API error ${response.status}`,
        error.error_subcode,
        error.fbtrace_id,
      );
    }
    return body as T;
  }

  // --- reads behind ad sets and ads -----------------------------------------

  /**
   * The Facebook Pages this token's user can act for, and the Instagram
   * accounts attached to the ad account.
   *
   * Meta ties an Instagram account to a Page, but reading that link needs a
   * Page token this system does not hold. So every Instagram account the ad
   * account may advertise as is offered under every Page, and the person
   * choosing knows which goes with which. NOT verified live: which of the two
   * edges the system user's token can read — `me/accounts` is tried first and
   * the ad account's `promote_pages` second.
   */
  async listIdentities(): Promise<{
    pages: { id: string; name: string; instagramAccounts: { id: string; username: string }[] }[];
  }> {
    let pages: { id: string; name: string }[] = [];
    try {
      pages = await this.getAllPages<{ id: string; name: string }>('me/accounts', {
        fields: 'id,name',
        limit: '50',
      });
    } catch (error) {
      if (!(error instanceof MetaApiError) || error.isCredentialFailure) throw error;
    }
    if (pages.length === 0) {
      pages = await this.getAllPages<{ id: string; name: string }>(
        `${this.accountId}/promote_pages`,
        { fields: 'id,name', limit: '50' },
      );
    }

    let instagramAccounts: { id: string; username: string }[] = [];
    try {
      instagramAccounts = await this.getAllPages<{ id: string; username: string }>(
        `${this.accountId}/instagram_accounts`,
        { fields: 'id,username', limit: '50' },
      );
    } catch (error) {
      // A Page with no Instagram is a normal state; a dead token is not.
      if (!(error instanceof MetaApiError) || error.isCredentialFailure) throw error;
    }

    return { pages: pages.map((page) => ({ ...page, instagramAccounts })) };
  }

  private async searchTargeting<T>(params: Record<string, string>): Promise<T[]> {
    const body = await this.get<{ data?: T[] }>('search', params);
    return body.data ?? [];
  }

  /**
   * Turns the builder's states and typed city names into Meta's location keys,
   * and finds the key for Portuguese (Brazil).
   *
   * One match or a refusal, never a guess: a city must match exactly one
   * result by name inside the state the operator picked.
   */
  async resolveTargeting(reach: {
    states: string[];
    cities: { name: string; state: string }[];
  }): Promise<ResolvedTargeting> {
    const regions: ResolvedTargeting['regions'] = [];
    const regionNameByUf = new Map<string, string>();

    const regionOf = async (uf: string): Promise<{ key: string; name: string }> => {
      const stateName = BRAZIL_STATE_NAMES[uf];
      if (!stateName) throw new TargetingResolutionError(uf, 0);
      const rows = await this.searchTargeting<{ key: string; name: string; country_code?: string }>(
        {
          type: 'adgeolocation',
          location_types: '["region"]',
          country_code: 'BR',
          q: stateName,
          limit: '25',
        },
      );
      const matches = rows.filter(
        (row) =>
          (row.country_code ?? 'BR') === 'BR' &&
          foldPlaceName(row.name) === foldPlaceName(stateName),
      );
      const match = matches[0];
      if (matches.length !== 1 || !match) throw new TargetingResolutionError(uf, matches.length);
      regionNameByUf.set(uf, match.name);
      return { key: match.key, name: match.name };
    };

    for (const uf of reach.states) regions.push(await regionOf(uf));

    const cities: ResolvedTargeting['cities'] = [];
    for (const city of reach.cities) {
      const asked = `${city.name}/${city.state}`;
      const regionName = regionNameByUf.get(city.state) ?? (await regionOf(city.state)).name;
      const rows = await this.searchTargeting<{
        key: string;
        name: string;
        region?: string;
        country_code?: string;
      }>({
        type: 'adgeolocation',
        location_types: '["city"]',
        country_code: 'BR',
        q: city.name,
        limit: '50',
      });
      const matches = rows.filter(
        (row) =>
          foldPlaceName(row.name) === foldPlaceName(city.name) &&
          foldPlaceName(row.region ?? '') === foldPlaceName(regionName),
      );
      const match = matches[0];
      if (matches.length !== 1 || !match) throw new TargetingResolutionError(asked, matches.length);
      cities.push({ key: match.key, name: match.name, region: regionName });
    }

    const locales = await this.searchTargeting<{ key: number; name: string }>({
      type: 'adlocale',
      q: 'Portugu',
      limit: '25',
    });
    const portuguese = locales.filter((row) => /portugu[eê]s?e? \(bra[sz]il\)/i.test(row.name));
    const locale = portuguese[0];
    if (portuguese.length !== 1 || !locale) {
      throw new TargetingResolutionError('idioma português (Brasil)', portuguese.length);
    }

    return { regions, cities, localeKey: Number(locale.key) };
  }

  /**
   * Meta's own rendering of an ad that already exists, for one placement.
   * Returns the iframe address Meta hands back; the caller checks the host.
   */
  async getAdPreview(adId: string, adFormat: string): Promise<string | null> {
    if (!/^\d+$/.test(adId)) return null;
    const body = await this.get<{ data?: { body?: string }[] }>(`${adId}/previews`, {
      ad_format: adFormat,
    });
    const html = body.data?.[0]?.body ?? '';
    const src = /<iframe[^>]*\ssrc="([^"]+)"/i.exec(html)?.[1];
    return src ? src.replace(/&amp;/g, '&') : null;
  }

  /**
   * Two reads on purpose. The basic fields (cap, amount spent, currency) are
   * what reconciliation and the budget guard live on; the balance and payment
   * fields are a nicety for the dashboard. On staging the read token answered
   * "(#10) Permission Denied" to `funding_source_details`, and asking for
   * everything in one call took the whole account down with it. Now the
   * money fields come first, and a denial on the balance fields is recorded
   * as "não disponível" (`fundingKind: 'unavailable'`) with a warning, never
   * as a failed account.
   */
  async getAccount(): Promise<PlatformAccount> {
    const body = await this.get<{
      id: string;
      currency: string;
      spend_cap?: string;
      amount_spent?: string;
      account_status?: number;
    }>(this.accountId, {
      fields: 'id,currency,spend_cap,amount_spent,account_status',
    });

    const spendCapCents = body.spend_cap === undefined ? null : spendCapFromString(body.spend_cap);
    const amountSpentCents =
      body.amount_spent === undefined
        ? 0
        : centsFromMinorUnitString(body.amount_spent, 'amount_spent');
    const account: PlatformAccount = {
      id: body.id,
      currency: body.currency,
      spendCapCents,
      amountSpentCents,
      capReached: spendCapCents !== null && amountSpentCents >= spendCapCents,
      prepaidBalanceCents: null,
      fundingKind: null,
      warnings: [],
    };

    try {
      const funding = await this.get<{
        funding_source_details?: { type?: number; display_string?: string };
      }>(this.accountId, {
        // The prepaid balance inside it is text, parsed as such. NOT verified live.
        fields: 'funding_source_details',
      });
      const details = funding.funding_source_details;
      account.prepaidBalanceCents = prepaidBalanceFromDisplay(details?.display_string);
      account.fundingKind = details ? fundingKindOf(details.type) : null;
    } catch (error) {
      if (!(error instanceof MetaApiError) || !error.isPermissionDenied) throw error;
      account.fundingKind = 'unavailable';
      account.warnings?.push(
        `funding_source_details não disponível para o token de leitura (#${error.code}): saldo e forma de pagamento ficam vazios`,
      );
    }
    return account;
  }

  /**
   * The pixel the leads ad sets optimise for, and when it last fired. One
   * pixel per account is what Wings has; the id comes from the environment.
   * NOT verified live: that `last_fired_time` is readable with this token.
   */
  async getConversionSources(): Promise<ConversionSource[]> {
    if (!this.pixelId) return [];
    const body = await this.get<{
      id?: string;
      name?: string;
      last_fired_time?: string;
      is_unavailable?: boolean;
    }>(this.pixelId, { fields: 'id,name,last_fired_time,is_unavailable' });
    const lastFired = body.last_fired_time ? new Date(body.last_fired_time) : null;
    const recent =
      lastFired !== null &&
      !Number.isNaN(lastFired.getTime()) &&
      Date.now() - lastFired.getTime() <= PIXEL_ACTIVE_DAYS * 24 * 3_600_000;
    return [
      {
        id: String(body.id ?? this.pixelId),
        name: body.name ?? `Pixel ${this.pixelId}`,
        status: body.is_unavailable
          ? 'inactive'
          : lastFired === null
            ? 'unknown'
            : recent
              ? 'active'
              : 'inactive',
        lastEventAt:
          lastFired && !Number.isNaN(lastFired.getTime()) ? lastFired.toISOString() : null,
      },
    ];
  }

  async listCampaigns(): Promise<PlatformCampaign[]> {
    const data = await this.getAllPages<{
      id: string;
      name: string;
      status: string;
      effective_status?: string;
      daily_budget?: string;
      lifetime_budget?: string;
      objective?: string;
      start_time?: string;
      stop_time?: string;
      created_time?: string;
    }>(`${this.accountId}/campaigns`, {
      fields:
        'id,name,status,effective_status,daily_budget,lifetime_budget,objective,start_time,stop_time,created_time',
      limit: '50',
    });

    return data.map((campaign) => {
      const daily =
        campaign.daily_budget === undefined
          ? null
          : centsFromMinorUnitString(campaign.daily_budget, 'daily_budget');
      const lifetime =
        campaign.lifetime_budget === undefined
          ? null
          : centsFromMinorUnitString(campaign.lifetime_budget, 'lifetime_budget');
      return {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status as CampaignStatus,
        dailyBudgetCents: daily === 0 ? null : daily,
        lifetimeBudgetCents: lifetime === 0 ? null : lifetime,
        spendCents: 0,
        objective: campaign.objective ?? null,
        startDate: saoPauloDay(campaign.start_time ?? campaign.created_time),
        endDate: saoPauloDay(campaign.stop_time),
        deliveryStatus: campaign.effective_status ?? null,
      };
    });
  }

  async listAdSets(): Promise<PlatformAdSet[]> {
    const data = await this.getAllPages<{
      id: string;
      name: string;
      status: string;
      campaign_id: string;
      daily_budget?: string;
      lifetime_budget?: string;
    }>(`${this.accountId}/adsets`, {
      fields: 'id,name,status,campaign_id,daily_budget,lifetime_budget',
      limit: '50',
    });

    return data.map((adSet) => {
      const daily =
        adSet.daily_budget === undefined
          ? null
          : centsFromMinorUnitString(adSet.daily_budget, 'adset.daily_budget');
      const lifetime =
        adSet.lifetime_budget === undefined
          ? null
          : centsFromMinorUnitString(adSet.lifetime_budget, 'adset.lifetime_budget');
      return {
        id: adSet.id,
        campaignId: adSet.campaign_id,
        name: adSet.name,
        status: adSet.status as CampaignStatus,
        // Meta reports "0" for a budget that lives at the other level.
        dailyBudgetCents: daily === 0 ? null : daily,
        lifetimeBudgetCents: lifetime === 0 ? null : lifetime,
      };
    });
  }

  async getCampaign(campaignId: string): Promise<PlatformCampaign | null> {
    try {
      const body = await this.get<{
        id: string;
        name: string;
        status: string;
        daily_budget?: string;
        lifetime_budget?: string;
      }>(campaignId, { fields: 'id,name,status,daily_budget,lifetime_budget' });
      const daily =
        body.daily_budget === undefined
          ? null
          : centsFromMinorUnitString(body.daily_budget, 'daily_budget');
      return {
        id: body.id,
        name: body.name,
        status: body.status as CampaignStatus,
        dailyBudgetCents: daily === 0 ? null : daily,
        lifetimeBudgetCents: null,
        spendCents: 0,
      };
    } catch (error) {
      if (error instanceof MetaApiError && error.code === 100) return null;
      throw error;
    }
  }

  async listAds(): Promise<PlatformAd[]> {
    const data = await this.getAllPages<{
      id: string;
      name: string;
      status: string;
      effective_status?: string;
      campaign_id: string;
      adset_id: string;
      issues_info?: unknown;
      ad_review_feedback?: unknown;
      creative?: {
        id: string;
        name?: string;
        thumbnail_url?: string;
        title?: string;
        body?: string;
        object_type?: string;
        object_story_spec?: Parameters<typeof creativeFormatOf>[0]['object_story_spec'];
      };
    }>(
      `${this.accountId}/ads`,
      {
        // ad_review_feedback carries the real rejection reason; issues_info is
        // empty on disapproved ads (Stage 6.0 spike). object_type and the story
        // spec say what the creative is made of. NOT verified live: whether the
        // story spec is readable on every creative with this token.
        fields:
          'id,name,status,effective_status,campaign_id,adset_id,issues_info,ad_review_feedback,creative{id,name,thumbnail_url,title,body,object_type,object_story_spec}',
        // 660 ads with creatives is more than Meta will serve in one page.
        limit: ADS_PAGE_SIZE,
      },
      50,
      ADS_LIST_TIMEOUT_MS,
    );

    return data.map((ad) => ({
      id: ad.id,
      campaignId: ad.campaign_id,
      adSetId: ad.adset_id,
      name: ad.name,
      status: ad.status as CampaignStatus,
      effectiveStatus: ad.effective_status ?? null,
      creative: ad.creative
        ? {
            id: ad.creative.id,
            name: ad.creative.name ?? null,
            thumbnailUrl: ad.creative.thumbnail_url ?? null,
            title: ad.creative.title ?? null,
            body: ad.creative.body ?? null,
            format: creativeFormatOf(ad.creative),
            utmContent: utmContentOfCreative(
              ad.creative as Parameters<typeof utmContentOfCreative>[0],
            ),
          }
        : null,
      reviewFeedback: ad.ad_review_feedback ?? null,
      issuesInfo: ad.issues_info ?? null,
    }));
  }

  /**
   * Daily performance, fetched in windows small enough for Meta to compute.
   *
   * Paging alone is not enough here. Asking for 30 days of ad-level insights
   * across 660 ads makes Meta spend longer building the FIRST page than the
   * request timeout allows — it is the aggregation that is slow, not the
   * transfer, so a smaller page does not help. Slicing the date range does:
   * each request covers fewer days, and the rows are concatenated.
   *
   * Window sizes are per level because cost scales with entity count.
   */
  async getInsights(
    level: MetricsLevel,
    sinceDate: string,
    untilDate = new Date().toISOString().slice(0, 10),
  ): Promise<InsightRow[]> {
    const rows: InsightRow[] = [];
    for (const [since, until] of sliceDateRange(sinceDate, untilDate, INSIGHT_WINDOW_DAYS[level])) {
      rows.push(...(await this.fetchInsightWindow(level, since, until)));
    }
    return rows;
  }

  private async fetchInsightWindow(
    level: MetricsLevel,
    sinceDate: string,
    untilDate: string,
  ): Promise<InsightRow[]> {
    const metaLevel = level === 'ad_set' ? 'adset' : level;
    const idField =
      level === 'campaign' ? 'campaign_id' : level === 'ad_set' ? 'adset_id' : 'ad_id';

    const data = await this.getAllPages<Record<string, unknown>>(
      `${this.accountId}/insights`,
      {
        level: metaLevel,
        // The video fields ride on the same request, so they cost no extra
        // call. 3-second plays are the `video_view` action inside `actions`.
        // NOT verified live: that every quartile field is served at ad level.
        fields: `${idField},spend,impressions,clicks,ctr,reach,frequency,actions,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,${VIDEO_FIELDS.join(',')}`,
        time_range: JSON.stringify({ since: sinceDate, until: untilDate }),
        time_increment: '1',
        // Daily rows across hundreds of entities add up fast; small pages are
        // what keep Meta from refusing the request.
        limit: '100',
      },
      50,
      INSIGHTS_TIMEOUT_MS,
    );

    return data.map((row) => {
      const actions: Record<string, number> = {};
      for (const action of (row.actions ?? []) as { action_type: string; value: string }[]) {
        actions[action.action_type] = Number(action.value);
      }
      // A ranking of UNKNOWN means "not enough volume"; store it as absent
      // rather than pretending it is a verdict.
      const ranking = (value: unknown): string | null =>
        typeof value === 'string' && value !== 'UNKNOWN' ? value : null;

      return {
        level,
        entityId: String(row[idField] ?? ''),
        date: String(row.date_start ?? sinceDate),
        spendCents: centsFromDecimalCurrencyString(String(row.spend ?? '0'), 'insights.spend'),
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        reach: Number(row.reach ?? 0),
        ctrMilli: Math.round(Number(row.ctr ?? 0) * 1000),
        frequencyMilli: Math.round(Number(row.frequency ?? 0) * 1000),
        actions,
        qualityRanking: ranking(row.quality_ranking),
        engagementRateRanking: ranking(row.engagement_rate_ranking),
        conversionRateRanking: ranking(row.conversion_rate_ranking),
        video: {
          plays: actions.video_view ?? 0,
          thruplays: sumActionValues(row.video_thruplay_watched_actions),
          p25: sumActionValues(row.video_p25_watched_actions),
          p50: sumActionValues(row.video_p50_watched_actions),
          p75: sumActionValues(row.video_p75_watched_actions),
          p100: sumActionValues(row.video_p100_watched_actions),
          ...watchTimeOf(row.video_play_actions, row.video_avg_time_watched_actions),
        },
      };
    });
  }

  /**
   * Campaign-level daily rows split one way, in the campaign window size.
   *
   * Each breakdown is its own request: Meta computes a split across every
   * campaign, and the four splits together are four aggregations, never one.
   * Reach is left out of the hourly split, which Meta refuses to combine with
   * it. NOT verified live: the exact key names Meta answers for placement and
   * region on this account (see docs/dashboard-marketing.md).
   */
  async getBreakdowns(
    kind: BreakdownKind,
    sinceDate: string,
    untilDate = new Date().toISOString().slice(0, 10),
  ): Promise<BreakdownInsightRow[]> {
    const spec = BREAKDOWN_SPEC[kind];
    const rows: BreakdownInsightRow[] = [];
    for (const [since, until] of sliceDateRange(
      sinceDate,
      untilDate,
      INSIGHT_WINDOW_DAYS.campaign,
    )) {
      const data = await this.getAllPages<Record<string, unknown>>(
        `${this.accountId}/insights`,
        {
          level: 'campaign',
          fields: `campaign_id,spend,impressions,clicks,actions${spec.reach ? ',reach' : ''}`,
          breakdowns: spec.breakdowns.join(','),
          time_range: JSON.stringify({ since, until }),
          time_increment: '1',
          limit: '100',
        },
        50,
        INSIGHTS_TIMEOUT_MS,
      );
      for (const row of data) {
        const actions: Record<string, number> = {};
        for (const action of (row.actions ?? []) as { action_type: string; value: string }[]) {
          actions[action.action_type] = Number(action.value);
        }
        rows.push({
          kind,
          campaignId: String(row.campaign_id ?? ''),
          date: String(row.date_start ?? since),
          key: spec.key(row),
          subKey: spec.subKey(row),
          spendCents: centsFromDecimalCurrencyString(String(row.spend ?? '0'), 'insights.spend'),
          impressions: Number(row.impressions ?? 0),
          clicks: Number(row.clicks ?? 0),
          reach: Number(row.reach ?? 0),
          actions,
        });
      }
    }
    return rows;
  }

  async getSpend(sinceDate: string): Promise<SpendRow[]> {
    const until = new Date().toISOString().slice(0, 10);
    const data = await this.getAllPages<{
      campaign_id: string;
      date_start: string;
      spend: string;
    }>(
      `${this.accountId}/insights`,
      {
        level: 'campaign',
        fields: 'campaign_id,spend',
        time_increment: '1',
        time_range: JSON.stringify({ since: sinceDate, until }),
        limit: '100',
      },
      50,
      INSIGHTS_TIMEOUT_MS,
    );

    return data.map((row) => ({
      campaignId: row.campaign_id,
      date: row.date_start,
      // Insights uses decimal reais, NOT the cents used by budgets.
      spendCents: centsFromDecimalCurrencyString(row.spend, 'insights.spend'),
    }));
  }

  setDailyBudget(_campaignId: string, _dailyBudgetCents: Cents): Promise<MutationOutcome> {
    throw new MetaWritesDisabledError('setDailyBudget');
  }

  pauseCampaign(_campaignId: string): Promise<MutationOutcome> {
    throw new MetaWritesDisabledError('pauseCampaign');
  }

  resumeCampaign(_campaignId: string): Promise<MutationOutcome> {
    throw new MetaWritesDisabledError('resumeCampaign');
  }

  createCampaign(_spec: CreateCampaignSpec): Promise<MutationOutcome> {
    throw new MetaWritesDisabledError('createCampaign');
  }

  setAccountSpendCap(
    _capCents: Cents,
  ): Promise<{ status: 'applied' | 'rejected'; message?: string }> {
    throw new MetaWritesDisabledError('setAccountSpendCap');
  }
}

/** Meta's ISO time ("2026-09-28T09:59:32-0300") as the São Paulo day it falls on; null when absent or unreadable. */
function saoPauloDay(time: string | undefined): string | null {
  if (!time) return null;
  // Meta writes the offset without a colon, which Date.parse accepts only with it.
  const instant = new Date(time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(instant.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(instant);
}

/**
 * Meta reports the average seconds watched per start of the video, per day.
 * A window's average is the total over its days divided by the starts, so the
 * day is stored as starts and total milliseconds watched (average × starts),
 * never as an average that would be averaged again.
 */
function watchTimeOf(
  starts: unknown,
  averageSeconds: unknown,
): { starts: number; watchMs: number } {
  const count = sumActionValues(starts);
  const first = Array.isArray(averageSeconds)
    ? (averageSeconds[0] as { value?: unknown } | undefined)
    : undefined;
  const seconds = Number(first?.value ?? 0);
  return {
    starts: count,
    watchMs: Number.isFinite(seconds) ? Math.round(seconds * 1000 * count) : 0,
  };
}
