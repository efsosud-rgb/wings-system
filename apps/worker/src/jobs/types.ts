import type { ObjectStorage } from '../lib/storage.js';
import type { Job } from '../queue.js';

/** What a job handler needs, injectable so tests never touch a real bucket,
 * a real ffmpeg or a real Python interpreter. */
export interface JobContext {
  storage: ObjectStorage;
  /** CPU threads this one job may hand to ffmpeg/ffprobe/whisper. */
  threads: number;
  runFfprobe: (filePath: string) => Promise<string>;
  runWhisper: (filePath: string, options: { threads: number; language?: string }) => Promise<string>;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<unknown>;
