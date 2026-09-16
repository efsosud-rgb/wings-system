import { assertCents, type Cents } from './money.js';
import { META_DAILY_OVERDELIVERY_FACTOR } from './fixtures.js';
import type {
  AdsPlatformClient,
  MutationOutcome,
  PlatformAccount,
  PlatformCampaign,
  SpendRow,
} from './types.js';

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
  dailyBudgetCents?: Cents;
}

export type InjectedFailure =
  | { kind: 'rate_limit' }
  | { kind: 'invalid_token' }
  | { kind: 'transient' }
  | { kind: 'reject'; code: string; message: string }
  /** The nastiest real-world case: the change lands, then the response is lost. */
  | { kind: 'timeout_after_apply' };

export interface FakeMetaOptions {
  accountId?: string;
  spendCapCents?: Cents | null;
  campaigns?: FakeCampaignSeed[];
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
  readonly platform = 'meta' as const;
  /** Always false. A fake client must never be mistaken for a live one. */
  readonly isLive = false;

  private readonly accountId: string;
  private spendCapCents: Cents | null;
  private readonly campaigns = new Map<string, InternalCampaign>();
  private readonly overdeliveryFactor: number;
  private readonly reportingLagMinutes: number;
  private readonly now: () => Date;
  private readonly failures: InjectedFailure[] = [];
  private capReached = false;

  /** Every call made, for assertions about what the system tried to do. */
  readonly calls: { method: string; args: unknown[] }[] = [];

  constructor(options: FakeMetaOptions = {}) {
    this.accountId = options.accountId ?? 'act_123456789';
    this.spendCapCents = options.spendCapCents ?? null;
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
      const budget = campaign.dailyBudgetCents ?? 0;
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
    };
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

  async pauseCampaign(campaignId: string): Promise<MutationOutcome> {
    this.calls.push({ method: 'pauseCampaign', args: [campaignId] });
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return { status: 'rejected', code: 'not_found', message: 'Campaign not found' };
    campaign.status = 'PAUSED';
    return { status: 'applied', campaign: this.snapshot(campaign) };
  }

  async resumeCampaign(campaignId: string): Promise<MutationOutcome> {
    this.calls.push({ method: 'resumeCampaign', args: [campaignId] });
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return { status: 'rejected', code: 'not_found', message: 'Campaign not found' };
    // The platform refuses to resume while the account cap is reached.
    if (this.capReached) {
      return { status: 'rejected', code: 'account_cap', message: 'Account spending limit reached' };
    }
    campaign.status = 'ACTIVE';
    return { status: 'applied', campaign: this.snapshot(campaign) };
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
