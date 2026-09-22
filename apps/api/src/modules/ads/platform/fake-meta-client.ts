import { assertCents, type Cents } from './money.js';
import { META_DAILY_OVERDELIVERY_FACTOR } from './fixtures.js';
import type {
  AdsPlatformClient,
  BreakdownInsightRow,
  BreakdownKind,
  CreateCampaignSpec,
  CreativeFormat,
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
 * How the simulator splits a day's delivery, so the audience views have
 * something to show. Fixed shares, not random: a test can assert on them.
 */
export const FAKE_BREAKDOWN_SHARES: Record<BreakdownKind, { key: string; subKey: string; share: number }[]> = {
  placement: [
    { key: 'instagram', subKey: 'feed', share: 0.4 },
    { key: 'instagram', subKey: 'reels', share: 0.35 },
    { key: 'facebook', subKey: 'feed', share: 0.25 },
  ],
  age_gender: [
    { key: '25-34', subKey: 'female', share: 0.4 },
    { key: '25-34', subKey: 'male', share: 0.3 },
    { key: '35-44', subKey: 'female', share: 0.3 },
  ],
  region: [
    { key: 'São Paulo', subKey: '', share: 0.6 },
    { key: 'Paraná', subKey: '', share: 0.4 },
  ],
  hour: [
    { key: '09', subKey: '', share: 0.3 },
    { key: '14', subKey: '', share: 0.3 },
    { key: '20', subKey: '', share: 0.4 },
  ],
};

/**
 * In-memory Meta Ads simulator.
 *
 * Wings has no sandbox ad account, so this is the only environment in which
 * budget logic may be exercised. It deliberately reproduces the behaviours
 * that make real money escape, rather than a polite happy path:
 *
 *  - delivery **overshoots** the daily budget by up to 25% (Meta's documented
 *    allowance), so code that assumes budget == spend fails here first;
 *  - reported spend **lags** actual spend, so the system is forced to cope with
 *    not knowing the true number yet;
 *  - the account spend cap **pauses every campaign** when reached, as Meta does;
 *  - calls can fail *after* applying the change, producing `unknown` outcomes;
 *  - rate limits and invalid tokens can be injected on demand.
 */

export interface FakeCampaignSeed {
  id: string;
  name: string;
  status?: 'ACTIVE' | 'PAUSED';
  /** Campaign-level budget (CBO). Omit for an ABO campaign. */
  dailyBudgetCents?: Cents;
}

export interface FakeAdSetSeed {
  id: string;
  campaignId: string;
  name: string;
  status?: 'ACTIVE' | 'PAUSED';
  /** Ad-set level budget (ABO). */
  dailyBudgetCents?: Cents;
}

export type InjectedFailure =
  | { kind: 'rate_limit' }
  | { kind: 'invalid_token' }
  | { kind: 'transient' }
  | { kind: 'reject'; code: string; message: string }
  /** The nastiest real-world case: the change lands, then the response is lost. */
  | { kind: 'timeout_after_apply' };

export interface FakeAdSeed {
  id: string;
  campaignId: string;
  adSetId: string;
  name: string;
  status?: 'ACTIVE' | 'PAUSED';
  effectiveStatus?: string;
  /** Set to simulate a disapproved ad carrying a real rejection reason. */
  reviewFeedback?: unknown;
  issuesInfo?: unknown;
  /** What the creative is made of; image unless said otherwise. */
  format?: CreativeFormat;
}

export interface FakeMetaOptions {
  accountId?: string;
  spendCapCents?: Cents | null;
  /** A prepaid balance the account reports; null (the default) for a card account. */
  prepaidBalanceCents?: Cents | null;
  campaigns?: FakeCampaignSeed[];
  adSets?: FakeAdSetSeed[];
  ads?: FakeAdSeed[];
  /** Fraction of the daily budget actually delivered, default 1.0 (max 1.25). */
  overdeliveryFactor?: number;
  /** How long reported spend trails actual spend. */
  reportingLagMinutes?: number;
  now?: () => Date;
}

interface InternalCampaign extends PlatformCampaign {
  /** Spend that has really happened, including the part not yet reported. */
  actualSpendCents: Cents;
  reportedSpendCents: Cents;
  dailySpend: Map<string, Cents>;
}

export class FakeMetaClient implements AdsPlatformClient {
  get accountExternalId(): string {
    return this.accountId;
  }

  readonly platform = 'meta' as const;
  /** Always false. A fake client must never be mistaken for a live one. */
  readonly isLive = false;

  private readonly accountId: string;
  private spendCapCents: Cents | null;
  private readonly prepaidBalanceCents: Cents | null;
  private readonly campaigns = new Map<string, InternalCampaign>();
  private readonly overdeliveryFactor: number;
  private readonly reportingLagMinutes: number;
  private readonly now: () => Date;
  private readonly adSets = new Map<string, PlatformAdSet & { actualSpendCents: Cents }>();
  private readonly ads: FakeAdSeed[] = [];
  private readonly failures: InjectedFailure[] = [];
  private capReached = false;
  private createdCount = 0;

  /** Every call made, for assertions about what the system tried to do. */
  readonly calls: { method: string; args: unknown[] }[] = [];

  constructor(options: FakeMetaOptions = {}) {
    this.accountId = options.accountId ?? 'act_123456789';
    this.spendCapCents = options.spendCapCents ?? null;
    this.prepaidBalanceCents = options.prepaidBalanceCents ?? null;
    this.overdeliveryFactor = Math.min(
      options.overdeliveryFactor ?? 1,
      META_DAILY_OVERDELIVERY_FACTOR,
    );
    this.reportingLagMinutes = options.reportingLagMinutes ?? 0;
    this.now = options.now ?? (() => new Date());

    for (const seed of options.campaigns ?? []) {
      this.campaigns.set(seed.id, {
        id: seed.id,
        name: seed.name,
        status: seed.status ?? 'ACTIVE',
        dailyBudgetCents: seed.dailyBudgetCents ?? 0,
        lifetimeBudgetCents: null,
        spendCents: 0,
        actualSpendCents: 0,
        reportedSpendCents: 0,
        dailySpend: new Map(),
      });
    }

    this.ads.push(...(options.ads ?? []));

    for (const seed of options.adSets ?? []) {
      this.adSets.set(seed.id, {
        id: seed.id,
        campaignId: seed.campaignId,
        name: seed.name,
        status: seed.status ?? 'ACTIVE',
        dailyBudgetCents: seed.dailyBudgetCents ?? null,
        lifetimeBudgetCents: null,
        actualSpendCents: 0,
      });
    }
  }

  /** Queues a failure for the next mutating call. */
  injectFailure(failure: InjectedFailure): void {
    this.failures.push(failure);
  }

  /**
   * Simulates a day of delivery. Active campaigns spend their daily budget
   * times the overdelivery factor, until the account cap stops everything.
   */
  simulateDay(date: string): void {
    for (const campaign of this.campaigns.values()) {
      if (campaign.status !== 'ACTIVE' || this.capReached) continue;
      // A campaign without its own budget (ABO) delivers through its ad sets;
      // an ad set only spends while its campaign is active.
      const ownBudget = campaign.dailyBudgetCents ?? 0;
      const adSetBudget = [...this.adSets.values()]
        .filter((adSet) => adSet.campaignId === campaign.id && adSet.status === 'ACTIVE')
        .reduce((total, adSet) => total + (adSet.dailyBudgetCents ?? 0), 0);
      const budget = ownBudget > 0 ? ownBudget : adSetBudget;
      if (budget <= 0) continue;

      let delivered = Math.round(budget * this.overdeliveryFactor);
      const remaining = this.remainingUnderCap();
      if (remaining !== null && delivered > remaining) delivered = remaining;
      if (delivered <= 0) continue;

      campaign.actualSpendCents += delivered;
      campaign.dailySpend.set(date, (campaign.dailySpend.get(date) ?? 0) + delivered);

      if (this.reportingLagMinutes === 0) {
        campaign.reportedSpendCents = campaign.actualSpendCents;
      }

      if (this.remainingUnderCap() === 0) this.enforceCap();
    }
  }

  /** Lets reported figures catch up with what was actually spent. */
  settleReporting(): void {
    for (const campaign of this.campaigns.values()) {
      campaign.reportedSpendCents = campaign.actualSpendCents;
    }
  }

  /** True spend including what the platform has not reported yet. */
  actualTotalSpendCents(): Cents {
    let total = 0;
    for (const campaign of this.campaigns.values()) total += campaign.actualSpendCents;
    return total;
  }

  private reportedTotalSpendCents(): Cents {
    let total = 0;
    for (const campaign of this.campaigns.values()) total += campaign.reportedSpendCents;
    return total;
  }

  private remainingUnderCap(): Cents | null {
    if (this.spendCapCents === null) return null;
    return Math.max(0, this.spendCapCents - this.actualTotalSpendCents());
  }

  /** Meta pauses every campaign when the account spending limit is reached. */
  private enforceCap(): void {
    this.capReached = true;
    for (const campaign of this.campaigns.values()) {
      if (campaign.status === 'ACTIVE') campaign.status = 'PAUSED';
    }
  }

  private takeFailure(): InjectedFailure | undefined {
    return this.failures.shift();
  }

  private snapshot(campaign: InternalCampaign): PlatformCampaign {
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      dailyBudgetCents: campaign.dailyBudgetCents,
      lifetimeBudgetCents: campaign.lifetimeBudgetCents,
      spendCents: campaign.reportedSpendCents,
    };
  }

  async getAccount(): Promise<PlatformAccount> {
    this.calls.push({ method: 'getAccount', args: [] });
    return {
      id: this.accountId,
      currency: 'BRL',
      spendCapCents: this.spendCapCents,
      amountSpentCents: this.reportedTotalSpendCents(),
      capReached: this.capReached,
      prepaidBalanceCents: this.prepaidBalanceCents,
      fundingKind: this.prepaidBalanceCents === null ? 'credit_card' : 'prepaid',
    };
  }

  async listAds(): Promise<PlatformAd[]> {
    this.calls.push({ method: 'listAds', args: [] });
    return this.ads.map((ad) => ({
      id: ad.id,
      campaignId: ad.campaignId,
      adSetId: ad.adSetId,
      name: ad.name,
      status: (ad.status ?? 'ACTIVE') as PlatformAd['status'],
      effectiveStatus: ad.effectiveStatus ?? ad.status ?? 'ACTIVE',
      creative: {
        id: `cr_${ad.id}`,
        name: `${ad.name} — criativo`,
        thumbnailUrl: `https://example.invalid/${ad.id}.jpg`,
        title: 'Título',
        body: 'Corpo do anúncio',
        format: ad.format ?? 'image',
      },
      reviewFeedback: ad.reviewFeedback ?? null,
      issuesInfo: ad.issuesInfo ?? null,
    }));
  }

  /**
   * Daily rows derived from what the simulator has actually "spent". At ad
   * set and ad level the campaign's day is filed under each of its children in
   * equal parts, so the tree adds up the way the platform's does.
   */
  async getInsights(level: MetricsLevel, sinceDate: string): Promise<InsightRow[]> {
    this.calls.push({ method: 'getInsights', args: [level, sinceDate] });
    const rows: InsightRow[] = [];

    for (const campaign of this.campaigns.values()) {
      const children =
        level === 'campaign'
          ? [{ id: campaign.id, share: 1 }]
          : level === 'ad_set'
            ? [...this.adSets.values()]
                .filter((adSet) => adSet.campaignId === campaign.id)
                .map((adSet) => ({ id: adSet.id, share: 1 }))
            : this.ads
                .filter((ad) => ad.campaignId === campaign.id)
                .map((ad) => ({ id: ad.id, share: 1 }));
      const count = children.length;
      for (const [date, daySpend] of campaign.dailySpend) {
        if (date < sinceDate || campaign.reportedSpendCents === 0) continue;
        for (const child of children) {
          const spendCents = Math.round(daySpend / count);
          const impressions = Math.max(1, Math.round(spendCents / 5));
          const clicks = Math.round(impressions / 50);
          // Three in ten impressions become a 3-second play; a video funnel
          // then narrows by fixed steps, so a test can assert on the rates.
          const plays = Math.round(impressions * 0.3);
          rows.push({
            level,
            entityId: child.id,
            date,
            spendCents,
            impressions,
            clicks,
            reach: Math.round(impressions / 1.3),
            ctrMilli: Math.round((clicks / impressions) * 100 * 1000),
            frequencyMilli: 1300,
            actions: { link_click: clicks, video_view: plays },
            qualityRanking: null,
            engagementRateRanking: null,
            conversionRateRanking: null,
            video: {
              plays,
              thruplays: Math.round(plays * 0.4),
              p25: Math.round(plays * 0.6),
              p50: Math.round(plays * 0.4),
              p75: Math.round(plays * 0.25),
              p100: Math.round(plays * 0.1),
            },
          });
        }
      }
    }
    return rows;
  }

  /** The campaign's day split by fixed shares (`FAKE_BREAKDOWN_SHARES`). */
  async getBreakdowns(kind: BreakdownKind, sinceDate: string): Promise<BreakdownInsightRow[]> {
    this.calls.push({ method: 'getBreakdowns', args: [kind, sinceDate] });
    const rows: BreakdownInsightRow[] = [];
    for (const campaign of this.campaigns.values()) {
      for (const [date, daySpend] of campaign.dailySpend) {
        if (date < sinceDate || campaign.reportedSpendCents === 0) continue;
        for (const slice of FAKE_BREAKDOWN_SHARES[kind]) {
          const spendCents = Math.round(daySpend * slice.share);
          const impressions = Math.max(1, Math.round(spendCents / 5));
          const clicks = Math.round(impressions / 50);
          rows.push({
            kind,
            campaignId: campaign.id,
            date,
            key: slice.key,
            subKey: slice.subKey,
            spendCents,
            impressions,
            clicks,
            reach: kind === 'hour' ? 0 : Math.round(impressions / 1.3),
            actions: { link_click: clicks },
          });
        }
      }
    }
    return rows;
  }

  async listAdSets(): Promise<PlatformAdSet[]> {
    this.calls.push({ method: 'listAdSets', args: [] });
    return [...this.adSets.values()].map(({ actualSpendCents: _ignored, ...adSet }) => adSet);
  }

  async listCampaigns(): Promise<PlatformCampaign[]> {
    this.calls.push({ method: 'listCampaigns', args: [] });
    return [...this.campaigns.values()].map((campaign) => this.snapshot(campaign));
  }

  async getCampaign(campaignId: string): Promise<PlatformCampaign | null> {
    this.calls.push({ method: 'getCampaign', args: [campaignId] });
    const campaign = this.campaigns.get(campaignId);
    return campaign ? this.snapshot(campaign) : null;
  }

  async getSpend(sinceDate: string): Promise<SpendRow[]> {
    this.calls.push({ method: 'getSpend', args: [sinceDate] });
    const rows: SpendRow[] = [];
    for (const campaign of this.campaigns.values()) {
      for (const [date, spendCents] of campaign.dailySpend) {
        // Reporting lag hides spend the platform has not published yet.
        if (date >= sinceDate && campaign.reportedSpendCents > 0) {
          rows.push({ campaignId: campaign.id, date, spendCents });
        }
      }
    }
    return rows;
  }

  async setDailyBudget(campaignId: string, dailyBudgetCents: Cents): Promise<MutationOutcome> {
    this.calls.push({ method: 'setDailyBudget', args: [campaignId, dailyBudgetCents] });
    assertCents(dailyBudgetCents, 'dailyBudgetCents');

    const failure = this.takeFailure();
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return { status: 'rejected', code: 'not_found', message: 'Campaign not found' };

    if (failure) {
      switch (failure.kind) {
        case 'rate_limit':
          return {
            status: 'rejected',
            code: '80004',
            message: 'Too many calls to this ad-account',
          };
        case 'invalid_token':
          return { status: 'rejected', code: '190', message: 'Access token invalidated' };
        case 'transient':
          return { status: 'unknown', reason: 'transient platform error' };
        case 'reject':
          return { status: 'rejected', code: failure.code, message: failure.message };
        case 'timeout_after_apply':
          // Applied on the platform, but the caller never learns the result.
          campaign.dailyBudgetCents = dailyBudgetCents;
          return { status: 'unknown', reason: 'request timed out after the change was applied' };
      }
    }

    if (dailyBudgetCents < 100) {
      return { status: 'rejected', code: '1487079', message: 'Daily budget below the minimum' };
    }

    campaign.dailyBudgetCents = dailyBudgetCents;
    return { status: 'applied', campaign: this.snapshot(campaign) };
  }

  /**
   * A status change fails the same ways a budget change does. The first real
   * write is a pause, so its unknown outcomes must be rehearsable too.
   */
  private setStatus(
    method: 'pauseCampaign' | 'resumeCampaign',
    campaignId: string,
    status: 'PAUSED' | 'ACTIVE',
  ): MutationOutcome {
    this.calls.push({ method, args: [campaignId] });
    const failure = this.takeFailure();
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return { status: 'rejected', code: 'not_found', message: 'Campaign not found' };

    if (failure) {
      switch (failure.kind) {
        case 'rate_limit':
          return {
            status: 'rejected',
            code: '80004',
            message: 'Too many calls to this ad-account',
          };
        case 'invalid_token':
          return { status: 'rejected', code: '190', message: 'Access token invalidated' };
        case 'transient':
          return { status: 'unknown', reason: 'transient platform error' };
        case 'reject':
          return { status: 'rejected', code: failure.code, message: failure.message };
        case 'timeout_after_apply':
          campaign.status = status;
          return { status: 'unknown', reason: 'request timed out after the change was applied' };
      }
    }

    // The platform refuses to resume while the account cap is reached.
    if (status === 'ACTIVE' && this.capReached) {
      return { status: 'rejected', code: 'account_cap', message: 'Account spending limit reached' };
    }
    campaign.status = status;
    return { status: 'applied', campaign: this.snapshot(campaign) };
  }

  async pauseCampaign(campaignId: string): Promise<MutationOutcome> {
    return this.setStatus('pauseCampaign', campaignId, 'PAUSED');
  }

  async resumeCampaign(campaignId: string): Promise<MutationOutcome> {
    return this.setStatus('resumeCampaign', campaignId, 'ACTIVE');
  }

  /**
   * Creating fails the same ways any other write does. `timeout_after_apply`
   * matters most here: the campaign exists and the caller holds no id for it.
   */
  async createCampaign(spec: CreateCampaignSpec): Promise<MutationOutcome> {
    this.calls.push({ method: 'createCampaign', args: [spec] });
    assertCents(spec.dailyBudgetCents, 'dailyBudgetCents');

    const create = (): InternalCampaign => {
      this.createdCount += 1;
      const campaign: InternalCampaign = {
        id: `2385${String(this.createdCount).padStart(13, '0')}`,
        name: spec.name,
        status: spec.status,
        dailyBudgetCents: spec.dailyBudgetCents,
        lifetimeBudgetCents: null,
        spendCents: 0,
        actualSpendCents: 0,
        reportedSpendCents: 0,
        dailySpend: new Map(),
      };
      this.campaigns.set(campaign.id, campaign);
      return campaign;
    };

    const failure = this.takeFailure();
    if (failure) {
      switch (failure.kind) {
        case 'rate_limit':
          return {
            status: 'rejected',
            code: '80004',
            message: 'Too many calls to this ad-account',
          };
        case 'invalid_token':
          return { status: 'rejected', code: '190', message: 'Access token invalidated' };
        case 'transient':
          return { status: 'unknown', reason: 'transient platform error' };
        case 'reject':
          return { status: 'rejected', code: failure.code, message: failure.message };
        case 'timeout_after_apply':
          create();
          return { status: 'unknown', reason: 'request timed out after the campaign was created' };
      }
    }

    if (spec.dailyBudgetCents < 100) {
      return { status: 'rejected', code: '1487079', message: 'Daily budget below the minimum' };
    }
    // Meta refuses to create an ACTIVE campaign while the account cap is reached.
    if (spec.status === 'ACTIVE' && this.capReached) {
      return { status: 'rejected', code: 'account_cap', message: 'Account spending limit reached' };
    }
    return { status: 'applied', campaign: this.snapshot(create()) };
  }

  async setAccountSpendCap(
    capCents: Cents,
  ): Promise<{ status: 'applied' | 'rejected'; message?: string }> {
    this.calls.push({ method: 'setAccountSpendCap', args: [capCents] });
    assertCents(capCents, 'capCents');
    // Meta rejects a cap below what has already been spent in the period.
    if (capCents < this.actualTotalSpendCents()) {
      return { status: 'rejected', message: 'Spend cap below amount already spent' };
    }
    this.spendCapCents = capCents;
    if (this.actualTotalSpendCents() < capCents) this.capReached = false;
    return { status: 'applied' };
  }
}
