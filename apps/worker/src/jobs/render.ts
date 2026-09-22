import type { JobHandler } from './types.js';

/**
 * TODO(studio-jobs): `render` (auto-editor, then ffmpeg) waits on
 * docs/studio/jobs.md, which decides the render's input shape and how a
 * partial failure is reported. Do not enqueue `render` jobs before that doc
 * lands — nothing claims them (`WORKER_JOB_TYPES` excludes it by default) and
 * this handler, if ever reached, refuses rather than guess the contract.
 */
export const runRenderJob: JobHandler = async () => {
  throw new Error('render is not implemented yet: see docs/studio/jobs.md (pending)');
};
