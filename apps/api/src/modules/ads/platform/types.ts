import type { Cents } from './money.js';

/**
 * The narrow surface the rest of the system may use to touch an ad platform.
 *
 * Scope is budgets and status on existing campaigns, plus creating a campaign.
 * Creating what goes under it — media, one ad set, its ads — is a separate,
 * narrower interface (`AdTreeWriter`, below) with no status, no update and no
 * delete in it: everything is born paused and nothing that exists can be
 * changed. What the interface cannot express, no bug and no agent can do.
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
  /** The platform's objective for the campaign, when it has one. */
  objective?: string | null;
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
  /**
   * Money loaded onto the account, when it is prepaid and the platform says
   * how much is left. Null on a postpaid account and where the API is silent.
   */
  prepaidBalanceCents?: Cents | null;
  /**
   * `prepaid`, `credit_card`, `unknown`; a code, never the platform's display
   * string. `unavailable` when the token may not read the payment fields.
   */
  fundingKind?: string | null;
  /**
   * What the platform would not answer, in words for the job's log: a field
   * the token lacks permission for, for instance. Never a failure by itself.
   */
  warnings?: string[];
}

/** What a creative is made of, as far as the platform tells. */
export type CreativeFormat = 'image' | 'video' | 'carousel' | 'unknown';

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
    format?: CreativeFormat;
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
  /** Video figures, when the platform reports them for the entity. */
  video?: VideoMetrics;
}

export interface VideoMetrics {
  /** Plays of 3 seconds or more. */
  plays: number;
  thruplays: number;
  p25: number;
  p50: number;
  p75: number;
  p100: number;
}

/** How a day's figures are split: by placement, age and gender, region, hour, device. */
export type BreakdownKind = 'placement' | 'age_gender' | 'region' | 'hour' | 'device';

/**
 * What the platform says about one of its conversion sources: Meta's pixel,
 * a Google conversion action. `active` means the platform reports it as
 * enabled and, where it says so, firing recently. NOT verified live on either
 * platform (docs/dashboard-marketing.md).
 */
export interface ConversionSource {
  id: string;
  name: string;
  status: 'active' | 'inactive' | 'unknown';
  /** ISO instant of the last event, where the platform reports one. */
  lastEventAt: string | null;
}

/**
 * One day of one campaign, split one way. `key`/`subKey` are the platform's
 * own names for the slice: `facebook`/`feed`, `25-34`/`female`, a state name,
 * or the hour `"00"`..`"23"`.
 */
export interface BreakdownInsightRow {
  kind: BreakdownKind;
  campaignId: string;
  date: string;
  key: string;
  subKey: string;
  spendCents: Cents;
  impressions: number;
  clicks: number;
  /** Zero where the platform refuses reach for the split. */
  reach: number;
  actions: Record<string, number>;
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
  | {
      status: 'applied';
      campaign: PlatformCampaign;
      /** Evidence worth keeping with the execution, e.g. the locations resolved. */
      detail?: Record<string, unknown>;
      /**
       * Every object the write made besides the campaign, in order, for the
       * execution's step list: what a person sees exists on the platform.
       */
      created?: CreatedObject[];
    }
  | {
      status: 'rejected';
      code: string;
      message: string;
      /** The platform's own diagnostics (subcode, user message, trace id); never PII. */
      detail?: Record<string, unknown>;
    }
  | { status: 'unknown'; reason: string };

export interface CreatedObject {
  kind: 'ad_group' | 'keyword' | 'negative_keyword' | 'ad';
  label: string;
  externalId: string;
}

/**
 * A write the executor is about to make, in the platform's own terms. Built
 * once, validated first where the platform can validate without writing
 * (`PreflightCapable`), then performed — so what was validated is exactly
 * what goes out.
 */
export type PlannedWrite =
  | { kind: 'create_campaign'; spec: CreateCampaignSpec }
  | { kind: 'set_daily_budget'; campaignId: string; dailyBudgetCents: Cents }
  | { kind: 'pause_campaign'; campaignId: string }
  | { kind: 'resume_campaign'; campaignId: string; enableWith?: ResumeCompanions };

/**
 * What a resume switches on besides the campaign: the ad groups and ads this
 * system itself created paused under it, by their platform ids. Nothing a
 * person made by hand is ever listed here.
 */
export interface ResumeCompanions {
  adGroupIds: string[];
  adIds: string[];
}

export type PreflightOutcome =
  /** The platform accepted the whole request without writing it. */
  | { status: 'ok'; operations: string[] }
  | { status: 'rejected'; code: string; message: string }
  /** Nothing was validated: the platform did not answer. */
  | { status: 'unavailable'; reason: string };

/** A client that can ask the platform to validate a write without making it. */
export interface PreflightCapable {
  validateWrite(write: PlannedWrite): Promise<PreflightOutcome>;
}

export function canPreflight(client: unknown): client is PreflightCapable {
  return typeof (client as Partial<PreflightCapable>).validateWrite === 'function';
}

/** Meta's ODAX objectives the builder can ask for. */
export type PlatformObjective = 'OUTCOME_LEADS' | 'OUTCOME_TRAFFIC' | 'OUTCOME_SALES';

/**
 * An empty campaign: the object only, with nothing under it.
 *
 * `status` has no default on purpose. Whether a campaign is born able to
 * deliver is a decision somebody made and an approver saw, never an omission.
 */
export interface CreateCampaignSpec {
  name: string;
  objective: PlatformObjective;
  status: 'PAUSED' | 'ACTIVE';
  /** Campaign-level (CBO) daily budget, in cents. */
  dailyBudgetCents: Cents;
  /** Required by the Google client, ignored by Meta's. */
  google?: GoogleCampaignSpec;
}

/**
 * What a Google campaign shell needs beyond the common fields.
 *
 * Search takes its locations (radii included) and language on the campaign.
 * Demand Gen takes them on the ad group, which this system does not create yet
 * — so for Demand Gen they stay in the approved draft and nothing about them
 * is sent.
 */
export interface GoogleCampaignSpec {
  channel: 'SEARCH' | 'DEMAND_GEN';
  bidding: 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CLICKS';
  /** YYYY-MM-DD, in the account's timezone. */
  startDate: string;
  endDate: string;
  /**
   * The draft's reach, as the builder wrote it: the same structure every
   * platform receives, and each adapter translates its own way. Here states
   * and cities resolve into geo target constants, and each radius becomes a
   * proximity criterion (`googleLocationCriteria`).
   */
  reach: PlatformReach;
  /** Search only: the one ad group, its keywords and its responsive search ad. */
  search?: GoogleSearchSpec;
}

export interface GoogleSearchSpec {
  adGroupName: string;
  /** People in the place, or also people searching about it. */
  locationMode: 'PRESENCE' | 'PRESENCE_OR_INTEREST';
  bidding: 'MAXIMIZE_CLICKS' | 'MAXIMIZE_CONVERSIONS';
  /** Ceiling per click, with MAXIMIZE_CLICKS. */
  maxCpcCents?: Cents;
  keywords: { text: string; match: 'EXACT' | 'PHRASE' }[];
  /** Campaign-level negatives, always phrase match. */
  negativeKeywords: string[];
  headlines: string[];
  descriptions: string[];
  /** Destination with UTMs already applied. */
  finalUrl: string;
}

/** The platform-neutral reach of a draft: whole states, cities, radii. */
export interface PlatformReach {
  states: string[];
  cities: { name: string; state: string }[];
  customLocations: { latitude: number; longitude: number; radiusKm: number }[];
}

export interface AdsPlatformClient {
  readonly platform: 'meta' | 'google' | 'tiktok';
  /** True only for a client wired to a real ad account. */
  readonly isLive: boolean;
  /**
   * The platform's own id for the account this client talks to.
   *
   * Every mirroring function checks this against the account row it is writing
   * into. A client is bound to one account, and reusing one across accounts
   * silently files one account's campaigns under another — which is exactly
   * what happened the first time a second account existed.
   */
  readonly accountExternalId: string;
  /** Where `getAccount`'s ceiling comes from; defaults to `<platform>.spend_cap`. */
  readonly spendLimitSource?: string;

  getAccount(): Promise<PlatformAccount>;
  listCampaigns(): Promise<PlatformCampaign[]>;
  /** Every ad set in the account, with the campaign each belongs to. */
  listAdSets(): Promise<PlatformAdSet[]>;
  /** Every ad, with its creative and review state. */
  listAds(): Promise<PlatformAd[]>;
  /**
   * What the platform would not answer since the last call, in words for the
   * job's log (a metric this API version does not know, for instance). The
   * read still succeeded without it. Absent on clients that never warn.
   */
  drainWarnings?(): string[];
  /** Daily performance rows for the window, at the requested level. */
  getInsights(level: MetricsLevel, sinceDate: string, untilDate?: string): Promise<InsightRow[]>;
  /** Campaign-level daily rows split by one breakdown; empty where the platform has none. */
  getBreakdowns(
    kind: BreakdownKind,
    sinceDate: string,
    untilDate?: string,
  ): Promise<BreakdownInsightRow[]>;
  getCampaign(campaignId: string): Promise<PlatformCampaign | null>;
  /** Reported spend per campaign per day, for reconciliation. */
  getSpend(sinceDate: string): Promise<SpendRow[]>;
  /** The account's conversion sources and whether they measure; empty where the platform has none. */
  getConversionSources(): Promise<ConversionSource[]>;

  setDailyBudget(campaignId: string, dailyBudgetCents: Cents): Promise<MutationOutcome>;
  pauseCampaign(campaignId: string): Promise<MutationOutcome>;
  /** `enableWith` names what this system created paused under the campaign: both platforms switch it on too. */
  resumeCampaign(campaignId: string, enableWith?: ResumeCompanions): Promise<MutationOutcome>;
  /** Creates an empty campaign. `applied` carries the new campaign, id included. */
  createCampaign(spec: CreateCampaignSpec): Promise<MutationOutcome>;

  /** Platform-native outer wall: the account stops spending at this amount. */
  setAccountSpendCap(
    capCents: Cents,
  ): Promise<{ status: 'applied' | 'rejected'; message?: string }>;
}

// ---------------------------------------------------------------------------
// The rest of a campaign: media, one ad set, its ads
// ---------------------------------------------------------------------------

/**
 * Outcome of one write while building a campaign's tree. Same three answers as
 * `MutationOutcome`, carrying whatever the next step needs.
 */
export type StepOutcome<T> =
  | { status: 'created'; value: T }
  | { status: 'rejected'; code: string; message: string; detail?: Record<string, unknown> }
  | { status: 'unknown'; reason: string };

export interface ResolvedTargeting {
  regions: { key: string; name: string }[];
  cities: { key: string; name: string; region: string }[];
  /** Meta's locale key for Portuguese (Brazil). */
  localeKey: number;
}

export type AdSetOptimization =
  { goal: 'OFFSITE_CONVERSIONS'; pixelId: string; event: 'LEAD' } | { goal: 'LANDING_PAGE_VIEWS' };

export interface AdSetSpec {
  campaignId: string;
  name: string;
  /** YYYY-MM-DD, in the account's timezone. */
  startDate: string;
  endDate: string;
  optimization: AdSetOptimization;
  targeting: ResolvedTargeting;
  customLocations: { latitude: number; longitude: number; radiusKm: number }[];
  ageMin: number;
  ageMax: number;
  /** Null is Advantage+ placements: the ad set names none and Meta chooses. */
  placements: {
    facebook: ('feed' | 'stories' | 'reels')[];
    instagram: ('feed' | 'stories' | 'reels')[];
    /** Meta's own placement, not a separate platform: only `feed` exists. */
    threads: 'feed'[];
  } | null;
}

/**
 * A video's still is an ad image of its own (`imageHash`): Meta's signed CDN
 * address of the thumbnail (`thumbnailUrl`) is kept for people to look at and
 * is never sent as the creative's picture (2026-09-25: "Invalid parameter").
 */
export type CreativeMedia =
  | { kind: 'image'; imageHash: string }
  | { kind: 'video'; videoId: string; thumbnailUrl: string; imageHash: string };

export interface UploadedVideo {
  videoId: string;
  thumbnailUrl: string;
  imageHash: string;
}

export interface CreativeSpec {
  name: string;
  pageId: string;
  instagramUserId: string | null;
  message: string;
  headline: string;
  callToAction: string;
  /** Destination with UTMs already applied. */
  link: string;
  body:
    | { type: 'single'; media: CreativeMedia }
    | {
        type: 'carousel';
        cards: { media: CreativeMedia; headline: string; description: string; link: string }[];
      };
}

/**
 * What a client must be able to do for a campaign to get its ad set and ads.
 *
 * There is no status anywhere in these specs, on purpose: an ad set and an ad
 * are created PAUSED by the client itself, and nothing here can say otherwise.
 * There is also no update and no delete — nothing that exists can be touched.
 */
export interface AdTreeWriter {
  /** Reads only. Done before the first write, so a bad place sends nothing. */
  resolveTargeting(reach: {
    states: string[];
    cities: { name: string; state: string }[];
  }): Promise<ResolvedTargeting>;
  uploadImage(input: { bytes: Buffer; name: string }): Promise<StepOutcome<{ imageHash: string }>>;
  /** Uploads in chunks, waits until Meta has processed the video, and makes its still an ad image. */
  uploadVideo(input: {
    filePath: string;
    byteSize: number;
    name: string;
  }): Promise<StepOutcome<UploadedVideo>>;
  /**
   * A video this system already put in the account, ready to use again: reads
   * its state and makes (or finds) its still. Nothing is uploaded twice.
   */
  reuseVideo(videoId: string, name: string): Promise<StepOutcome<UploadedVideo>>;
  createAdSet(spec: AdSetSpec): Promise<StepOutcome<{ id: string }>>;
  /**
   * Meta's own check of an ad with its creative inline (`validate_only`):
   * everything the creative and the ad would be refused for, with nothing
   * created. Done before every creative.
   */
  validateAd(spec: { name: string; adSetId: string; creative: CreativeSpec }): Promise<StepOutcome<true>>;
  createCreative(spec: CreativeSpec): Promise<StepOutcome<{ id: string }>>;
  createAd(spec: {
    name: string;
    adSetId: string;
    creativeId: string;
  }): Promise<StepOutcome<{ id: string }>>;
}

export function isAdTreeWriter(client: unknown): client is AdTreeWriter {
  const candidate = client as Partial<Record<keyof AdTreeWriter, unknown>>;
  return (
    typeof candidate.resolveTargeting === 'function' &&
    typeof candidate.uploadImage === 'function' &&
    typeof candidate.uploadVideo === 'function' &&
    typeof candidate.reuseVideo === 'function' &&
    typeof candidate.createAdSet === 'function' &&
    typeof candidate.validateAd === 'function' &&
    typeof candidate.createCreative === 'function' &&
    typeof candidate.createAd === 'function'
  );
}
