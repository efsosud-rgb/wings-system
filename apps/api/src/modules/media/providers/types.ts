import type {
  GenerationAspect,
  MediaBilling,
  MediaCapability,
  MediaEstimateRequest,
  MediaModel,
  MediaProviderBalance,
  MediaProviderId,
  MediaProviderQuota,
} from '@wings/shared';
import type { Database } from '../../../db/client.js';
import type { mediaAssets } from '../../../db/schema/index.js';

/**
 * What every media provider looks like to the studio.
 *
 * The studio owns the order of things (estimate → click → ceilings → ledger →
 * one call → follow → save) and the provider owns only the talking: how a
 * model is listed, priced, started and read back. A provider never decides to
 * generate, never retries a call that may have cost something, and never sees
 * a client's name. Its answers are a third party's DATA: read by field name,
 * logged as shapes, never obeyed.
 */

export interface ProviderContext {
  db: Database;
  now: () => Date;
}

/** One output of a finished generation: an address to download from, or the bytes themselves. */
export type ProviderOutput = { url: string } | { bytes: Buffer };

export interface ProviderQuote {
  /** Kairogen credits. Zero everywhere else. */
  credits: number;
  /** In reais estimated. Zero is a price too, and is shown as one. */
  brlCents: number;
  /** What was priced, stored with the row and sent again, unchanged, on the click. */
  priceArgs: Record<string, unknown>;
}

export type SourceAsset = Pick<
  typeof mediaAssets.$inferSelect,
  'id' | 'kind' | 'mimeType' | 'width' | 'height' | 'origin' | 'externalGenerationId' | 'sourceUrl'
>;

/** A request the studio already validated against the model, as a provider sees it. */
export interface ResolvedRequest {
  operation: 'generate' | 'upscale' | 'animate';
  kind: 'image' | 'video';
  model: MediaModel;
  prompt: string | null;
  negativePrompt: string | null;
  aspect: GenerationAspect | null;
  quantity: number;
  durationSeconds: number | undefined;
  /** Price-affecting parameters, by the model's own keys, already checked against it. */
  params: Record<string, unknown>;
  /** Upscale only. */
  scale: 2 | 4 | null;
  /** The library picture this starts from, when one does. */
  source: SourceAsset | null;
}

export interface StartInput {
  generationId: string;
  modelKey: string;
  request: MediaEstimateRequest;
  priceArgs: Record<string, unknown>;
  creditsEstimated: number;
  source: SourceAsset | null;
  /** A public address of the source picture, minutes long, for a provider that reads by URL. */
  publicUrl: (purpose: string) => Promise<string | null>;
  /** The source picture's bytes, for a provider that takes them inline. */
  sourceBytes: () => Promise<Buffer | null>;
}

export type StartResult =
  /** The provider took the job: the studio follows it with `poll`. */
  | { done: false; externalId: string }
  /** The provider answered with the outputs in the same call. */
  | {
      done: true;
      externalId: string | null;
      outputs: ProviderOutput[];
      creditsCharged: number | null;
      brlCentsCharged: number | null;
      /** Something the provider said worth showing, in its words, already filtered. */
      note: string | null;
    };

export interface PollResult {
  state: 'running' | 'succeeded' | 'failed';
  outputs: ProviderOutput[];
  creditsCharged: number | null;
  brlCentsCharged: number | null;
  note: string | null;
}

export type ProviderErrorCode =
  /** Not reachable, or answered with a server error before taking anything. */
  | 'unavailable'
  /** The key or connection is not accepted. */
  | 'unauthorized'
  /** The provider said no to this request. Nothing was charged. */
  | 'rejected'
  /** The call may have reached the provider and taken effect: never sent again. */
  | 'outcome_unknown'
  /** The provider's own rate limit or quota, as it said so. */
  | 'quota';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    /** For the person. Already filtered: never a key, never an address of ours. */
    message: string,
    /**
     * A refusal over the price that names the real one, with nothing generated and
     * nothing charged: the server offers that price for a new click, never a retry.
     */
    readonly requotedCredits: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface Availability {
  available: boolean;
  /** Why not, in words for the screen. Null when available. */
  reason: string | null;
}

export interface MediaProvider {
  readonly id: MediaProviderId;
  readonly name: string;
  readonly billing: MediaBilling;
  readonly capabilities: readonly MediaCapability[];
  /** False while the request and answer formats are taken from documentation nobody could check. */
  readonly verified: boolean;
  /** The environment names its key (or address). Never the key itself. */
  readonly configured: boolean;
  /** Usable right now, for this many outputs: configured, connected, quota left. */
  availability(ctx: ProviderContext, need?: { outputs: number }): Promise<Availability>;
  balance(ctx: ProviderContext): Promise<MediaProviderBalance | null>;
  quota(ctx: ProviderContext): Promise<MediaProviderQuota | null>;
  /** The models, each with its price per output when the provider can say without spending. */
  listModels(
    ctx: ProviderContext,
    options?: { priced?: 'image' | 'video' | 'all' },
  ): Promise<MediaModel[]>;
  /** What this would cost. A read: spends nothing, leaves nothing behind at the provider. */
  estimate(ctx: ProviderContext, request: ResolvedRequest): Promise<ProviderQuote>;
  /** The one call that spends. Sent once; a timeout is `outcome_unknown`, never a retry. */
  start(ctx: ProviderContext, input: StartInput): Promise<StartResult>;
  /** How a job started with `done: false` stands. A read. */
  poll(ctx: ProviderContext, externalId: string): Promise<PollResult>;
}

/** Writes a log line when an answer's shape is new, not once per call. Shapes only, never contents. */
export type ShapeNoter = (entry: { tool: string; shape: unknown; text: string | null }) => void;
