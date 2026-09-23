import type { JobType } from '@wings/shared';
import { runEnrichLeadJob } from './enrich-lead.js';
import { runFfprobeJob } from './ffprobe.js';
import { runRenderJob } from './render/index.js';
import { runTranscribeJob } from './transcribe.js';
import type { JobHandler } from './types.js';

export const JOB_HANDLERS: Record<JobType, JobHandler> = {
  ffprobe: runFfprobeJob,
  transcribe: runTranscribeJob,
  render: runRenderJob,
  enrich_lead: runEnrichLeadJob,
};

export type { JobContext, JobHandler } from './types.js';
export { siblingTranscriptKey, type TranscribeOutput } from './transcribe.js';
export type { FfprobeOutput } from './ffprobe.js';
export type { EnrichLeadOutput } from './enrich-lead.js';
export { RenderError, type RenderJobInput, type RenderJobOutput } from './render/contract.js';
