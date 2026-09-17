import type { Cents } from './money.js';

/**
 * The narrow surface the rest of the system may use to touch an ad platform.
 *
 * V1 scope is budgets on existing campaigns: there is deliberately no way to
 * create a campaign, edit creatives or change targeting. What the interface
 * cannot express, no bug and no agent can do.
 */

export type CampaignStatus = 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';

export interface PlatformCampaign {
  id: string;
  name: string;
  status: CampaignStatus;
  /** Daily budget in cents. Null when the campaign uses a lifetime budget. */
  dailyBudgetCents: Cents | null;
  lifetimeBudgetCents: Cents | null;
  /** Spend reported so far for the current period, in cents. */
  spendCents: Cents;
}

export interface PlatformAdSet {
  id: string;
  campaignId: string;
  name: string;
  status: CampaignStatus;
  /** Ad-set level budget in cents (ABO). Null when the campaign owns it (CBO). */
  dailyBudgetCents: Cents | null;
  lifetimeBudgetCents: Cents | null;
}

export interface PlatformAccount {
  id: string;
  currency: string;
  /** Account spending limit in cents; null when unset. */
  spendCapCents: Cents | null;
  /** Amount spent against the cap, in cents. */
  amountSpentCents: Cents;
  /** True when the platform itself has stopped delivery (cap reached). */
  capReached: boolean;
}

export interface PlatformAd {
  id: string;
  campaignId: string;
  adSetId: string;
  name: string;
  status: CampaignStatus;
  /** Meta's effective_status: DISAPPROVED, WITH_ISSUES, CAMPAIGN_PAUSED… */
  effectiveStatus: string | null;
  creative: {
    id: string;
    name: string | null;
    thumbnailUrl: string | null;
    title: string | null;
    body: string | null;
  } | null;
  /** The real rejection reason, when the ad was disapproved. */
  reviewFeedback: unknown;
  issuesInfo: unknown;
}

export type MetricsLevel = 'campaign' | 'ad_set' | 'ad';

/** One day of performance for one entity, normalised across platforms. */
export interface InsightRow {
  level: MetricsLevel;
  entityId: string;
  date: string;
  spendCents: Cents;
  impressions: number;
  clicks: number;
  reach: number;
  /** Percentage x1000, integer — no floats on metrics. */
  ctrMilli: number;
  frequencyMilli: number;
  /** Every action type the platform reported, by type. */
  actions: Record<string, number>;
  qualityRanking: string | null;
  engagementRateRanking: string | null;
  conversionRateRanking: string | null;
}

export interface SpendRow {
  campaignId: string;
  /** YYYY-MM-DD in the account's timezone. */
  date: string;
  spendCents: Cents;
}

/**
 * Outcome of a mutating call.
 *
 * `unknown` is a first-class result, not an exception to be swallowed: a
 * timeout may mean the change applied, so the caller must reconcile by reading
 * platform state rather than retrying blindly.
 */
export type MutationOutcome =
  | { status: 'applied'; campaign: PlatformCampaign }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unknown'; reason: string };

export interface AdsPlatformClient {
  readonly platform: 'meta' | 'google' | 'tiktok';
  /** True only for a client wired to a real ad account. */
  readonly isLive: boolean;

  getAccount(): Promise<PlatformAccount>;
  listCampaigns(): Promise<PlatformCampaign[]>;
  /** Every ad set in the account, with the campaign each belongs to. */
  listAdSets(): Promise<PlatformAdSet[]>;
  /** Every ad, with its creative and review state. */
  listAds(): Promise<PlatformAd[]>;
  /** Daily performance rows for the window, at the requested level. */
  getInsights(level: MetricsLevel, sinceDate: string, untilDate?: string): Promise<InsightRow[]>;
  getCampaign(campaignId: string): Promise<PlatformCampaign | null>;
  /** Reported spend per campaign per day, for reconciliation. */
  getSpend(sinceDate: string): Promise<SpendRow[]>;

  setDailyBudget(campaignId: string, dailyBudgetCents: Cents): Promise<MutationOutcome>;
  pauseCampaign(campaignId: string): Promise<MutationOutcome>;
  resumeCampaign(campaignId: string): Promise<MutationOutcome>;

  /** Platform-native outer wall: the account stops spending at this amount. */
  setAccountSpendCap(
    capCents: Cents,
  ): Promise<{ status: 'applied' | 'rejected'; message?: string }>;
}
