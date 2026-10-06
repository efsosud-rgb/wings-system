import type { Pool } from '../db/client.js';
import type {
  CnpjLookup,
  EnrichmentBudget,
  LeadResearchProvider,
  WebSearch,
  ZapiProfileClient,
} from '../lib/enrichment.js';
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
    /** An external research service, once one is approved; null today (the step is skipped). */
    research?: LeadResearchProvider | null;
  };
  /** Set only by tests, to pin "today" for the daily ceiling. */
  now?: () => Date;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<unknown>;
