import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Job } from '../queue.js';
import type { JobContext, JobHandler } from './types.js';

const inputSchema = z.object({ storageKey: z.string().min(1) });

interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
}
interface FfprobeRaw {
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

export interface FfprobeOutput {
  formatName: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  bitRate: number | null;
  streams: {
    index: number;
    codecType: string | null;
    codecName: string | null;
    width: number | null;
    height: number | null;
    sampleRateHz: number | null;
    channels: number | null;
  }[];
}

/** Metadata of one Drive file, by running `ffprobe` on it. Never touches the
 * volume: the file is downloaded from the same R2 bucket the Drive uses,
 * into a temp file that is always removed, even on failure. */
export const runFfprobeJob: JobHandler = async (job: Job, ctx: JobContext) => {
  const { storageKey } = inputSchema.parse(job.input);
  const bytes = await ctx.storage.get(storageKey);
  if (!bytes) throw new Error('the file is not in storage (was it moved or deleted?)');

  const dir = await mkdtemp(join(tmpdir(), 'wings-ffprobe-'));
  const filePath = join(dir, 'input');
  try {
    await writeFile(filePath, bytes);
    const stdout = await ctx.runFfprobe(filePath);
    const raw = JSON.parse(stdout) as FfprobeRaw;
    const output: FfprobeOutput = {
      formatName: raw.format?.format_name ?? null,
      durationSeconds: raw.format?.duration ? Number(raw.format.duration) : null,
      sizeBytes: raw.format?.size ? Number(raw.format.size) : null,
      bitRate: raw.format?.bit_rate ? Number(raw.format.bit_rate) : null,
      streams: (raw.streams ?? []).map((stream) => ({
        index: stream.index,
        codecType: stream.codec_type ?? null,
        codecName: stream.codec_name ?? null,
        width: stream.width ?? null,
        height: stream.height ?? null,
        sampleRateHz: stream.sample_rate ? Number(stream.sample_rate) : null,
        channels: stream.channels ?? null,
      })),
    };
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
