import type { JobType } from '@wings/shared';
import { runCheckInstagramJob } from './check-instagram.js';
import { runEnrichLeadJob } from './enrich-lead.js';
import { runFfprobeJob } from './ffprobe.js';
import { runMetaCapiLeadJob } from './meta-capi-lead.js';
import { runRenderJob } from './render/index.js';
import { runTranscribeMeetingJob } from './transcribe-meeting.js';
import { runTranscribeJob } from './transcribe.js';
import type { JobHandler } from './types.js';

export const JOB_HANDLERS: Record<JobType, JobHandler> = {
  ffprobe: runFfprobeJob,
  transcribe: runTranscribeJob,
  render: runRenderJob,
  enrich_lead: runEnrichLeadJob,
  check_instagram: runCheckInstagramJob,
  transcribe_meeting: runTranscribeMeetingJob,
  meta_capi_lead: runMetaCapiLeadJob,
};

export type { JobContext, JobHandler } from './types.js';
export { siblingTranscriptKey, type TranscribeOutput } from './transcribe.js';
export type { FfprobeOutput } from './ffprobe.js';
export type { CheckInstagramOutput } from './check-instagram.js';
export type { EnrichLeadOutput } from './enrich-lead.js';
export type { MetaCapiLeadOutput } from './meta-capi-lead.js';
export { RenderError, type RenderJobInput, type RenderJobOutput } from './render/contract.js';
export { recoverDeliveredRender, type RecoveredRenderOutput } from './render/index.js';
