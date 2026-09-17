import {
  centsFromDecimalCurrencyString,
  centsFromMinorUnitString,
  spendCapFromString,
} from './meta-parse.js';
import type { Cents } from './money.js';
import type {
  AdsPlatformClient,
  CampaignStatus,
  InsightRow,
  MetricsLevel,
  MutationOutcome,
  PlatformAccount,
  PlatformAd,
  PlatformAdSet,
  PlatformCampaign,
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
}

export interface MetaClientOptions {
  accessToken: string;
  /** Account id including the act_ prefix. */
  adAccountId: string;
  apiVersion?: string;
  timeoutMs?: number;
  /** Injected in tests; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

interface MetaErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

export class MetaReadOnlyClient implements AdsPlatformClient {
  readonly platform = 'meta' as const;
  /** Points at a real ad account: treat every call as consequential. */
  readonly isLive = true;

  private readonly token: string;
  private readonly accountId: string;
  /** Exposed for the write client, which posts to the same account path. */
  protected get adAccountPath(): string {
    return this.accountId;
  }
  private readonly version: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

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
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`https://graph.facebook.com/${this.version}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // The token travels in a header, never in the query string, so it cannot
    // end up in a proxy log or an error message containing the URL.
    const response = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
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

  async getAccount(): Promise<PlatformAccount> {
    const body = await this.get<{
      id: string;
      currency: string;
      spend_cap?: string;
      amount_spent?: string;
      account_status?: number;
    }>(this.accountId, { fields: 'id,currency,spend_cap,amount_spent,account_status' });

    const spendCapCents = body.spend_cap === undefined ? null : spendCapFromString(body.spend_cap);
    const amountSpentCents =
      body.amount_spent === undefined
        ? 0
        : centsFromMinorUnitString(body.amount_spent, 'amount_spent');

    return {
      id: body.id,
      currency: body.currency,
      spendCapCents,
      amountSpentCents,
      capReached: spendCapCents !== null && amountSpentCents >= spendCapCents,
    };
  }

  async listCampaigns(): Promise<PlatformCampaign[]> {
    const body = await this.get<{
      data: {
        id: string;
        name: string;
        status: string;
        daily_budget?: string;
        lifetime_budget?: string;
      }[];
    }>(`${this.accountId}/campaigns`, {
      fields: 'id,name,status,daily_budget,lifetime_budget',
      limit: '200',
    });

    return body.data.map((campaign) => {
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
      };
    });
  }

  async listAdSets(): Promise<PlatformAdSet[]> {
    const body = await this.get<{
      data: {
        id: string;
        name: string;
        status: string;
        campaign_id: string;
        daily_budget?: string;
        lifetime_budget?: string;
      }[];
    }>(`${this.accountId}/adsets`, {
      fields: 'id,name,status,campaign_id,daily_budget,lifetime_budget',
      limit: '500',
    });

    return body.data.map((adSet) => {
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
    const body = await this.get<{
      data: {
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
        };
      }[];
    }>(`${this.accountId}/ads`, {
      // ad_review_feedback carries the real rejection reason; issues_info is
      // empty on disapproved ads (Stage 6.0 spike).
      fields:
        'id,name,status,effective_status,campaign_id,adset_id,issues_info,ad_review_feedback,creative{id,name,thumbnail_url,title,body}',
      limit: '200',
    });

    return body.data.map((ad) => ({
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
          }
        : null,
      reviewFeedback: ad.ad_review_feedback ?? null,
      issuesInfo: ad.issues_info ?? null,
    }));
  }

  async getInsights(
    level: MetricsLevel,
    sinceDate: string,
    untilDate = new Date().toISOString().slice(0, 10),
  ): Promise<InsightRow[]> {
    const metaLevel = level === 'ad_set' ? 'adset' : level;
    const idField =
      level === 'campaign' ? 'campaign_id' : level === 'ad_set' ? 'adset_id' : 'ad_id';

    const body = await this.get<{
      data: Record<string, unknown>[];
    }>(`${this.accountId}/insights`, {
      level: metaLevel,
      fields: `${idField},spend,impressions,clicks,ctr,reach,frequency,actions,quality_ranking,engagement_rate_ranking,conversion_rate_ranking`,
      time_range: JSON.stringify({ since: sinceDate, until: untilDate }),
      time_increment: '1',
      limit: '500',
    });

    return body.data.map((row) => {
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
      };
    });
  }

  async getSpend(sinceDate: string): Promise<SpendRow[]> {
    const until = new Date().toISOString().slice(0, 10);
    const body = await this.get<{
      data: { campaign_id: string; date_start: string; spend: string }[];
    }>(`${this.accountId}/insights`, {
      level: 'campaign',
      fields: 'campaign_id,spend',
      time_increment: '1',
      time_range: JSON.stringify({ since: sinceDate, until }),
      limit: '500',
    });

    return body.data.map((row) => ({
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

  setAccountSpendCap(
    _capCents: Cents,
  ): Promise<{ status: 'applied' | 'rejected'; message?: string }> {
    throw new MetaWritesDisabledError('setAccountSpendCap');
  }
}
