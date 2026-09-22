import type { JobType } from '@wings/shared';
import { runFfprobeJob } from './ffprobe.js';
import { runRenderJob } from './render.js';
import { runTranscribeJob } from './transcribe.js';
import type { JobHandler } from './types.js';

export const JOB_HANDLERS: Record<JobType, JobHandler> = {
  ffprobe: runFfprobeJob,
  transcribe: runTranscribeJob,
  render: runRenderJob,
};

export type { JobContext, JobHandler } from './types.js';
export { siblingTranscriptKey, type TranscribeOutput } from './transcribe.js';
export type { FfprobeOutput } from './ffprobe.js';
