import type { Pool } from '../db/client.js';
import type {
  CnpjLookup,
  EnrichmentBudget,
  LeadResearchProvider,
  WebSearch,
  ZapiProfileClient,
} from '../lib/enrichment.js';
import type { InstagramDiscovery, InstagramJudge } from '../lib/instagram-check.js';
import type { ObjectStorage } from '../lib/storage.js';
import type { Job } from '../queue.js';

/** What a job handler needs, injectable so tests never touch a real bucket,
 * a real ffmpeg or a real Python interpreter. */
export interface JobContext {
  storage: ObjectStorage;
  /** CPU threads this one job may hand to ffmpeg/ffprobe/whisper. */
  threads: number;
  runFfprobe: (filePath: string) => Promise<string>;
  runWhisper: (
    filePath: string,
    options: { threads: number; language?: string; timeoutMs?: number },
  ) => Promise<string>;
  /** Resolves on exit 0; rejects with a message of exactly
   * `ffmpeg exited with status <code>` otherwise — never ffmpeg's stderr,
   * which can carry a temp file path. */
  runFfmpeg: (args: string[]) => Promise<void>;
  /** RENDER_* env limits (docs/studio/jobs.md); only the `render` job reads this. */
  renderLimits: {
    maxSeconds: number;
    timeoutSeconds: number;
    maxInputBytes: number;
    tmpDir: string;
  };
  /** The queue's own database: the `enrich_lead` job reads and writes the lead tables with plain SQL. */
  db: Pool;
  /** The outside services of `enrich_lead`; a null one means "not configured", and the step is skipped. */
  enrichment: {
    zapi: ZapiProfileClient | null;
    search: WebSearch | null;
    cnpj: CnpjLookup;
    budget: EnrichmentBudget;
    /** The company research (OpenRouter); null when switched off or without the key (the step is skipped). */
    research?: LeadResearchProvider | null;
    /** Only leads that arrived from this instant on are researched (LEAD_RESEARCH_SINCE); null: no cut-off. */
    researchSince?: Date | null;
  };
  /**
   * The Instagram check of a site-form lead (`check_instagram`): off unless INSTAGRAM_CHECK_ENABLED is
   * "true"; a null provider means "not configured" and its step is skipped. The paid steps count
   * against `dailyUsd`, apart from the other ceilings.
   */
  instagramCheck?: {
    enabled: boolean;
    discovery: InstagramDiscovery | null;
    judge: InstagramJudge | null;
    dailyUsd: number;
  };
  /**
   * Meta's Conversions API (`meta_capi_lead`, docs/ads/conversions-api.md): off unless
   * META_CAPI_ENABLED is "true"; without the pixel or the token the job says `not_configured`.
   */
  metaCapi?: {
    enabled: boolean;
    pixelId: string | null;
    token: string | null;
    testEventCode: string | null;
    fetchImpl?: typeof fetch;
  };
  /** Set only by tests, to pin "today" for the daily ceiling. */
  now?: () => Date;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<unknown>;
