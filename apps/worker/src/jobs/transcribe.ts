import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Job } from '../queue.js';
import type { JobContext, JobHandler } from './types.js';

const inputSchema = z.object({
  storageKey: z.string().min(1),
  /** ISO 639-1; auto-detected by faster-whisper when omitted. */
  language: z.string().min(2).max(8).optional(),
});

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}
interface WhisperRaw {
  language: string;
  languageProbability: number;
  durationSeconds: number;
  segments: WhisperSegment[];
}

export interface TranscribeOutput {
  outputStorageKey: string;
  language: string;
  languageProbability: number;
  durationSeconds: number;
  segments: WhisperSegment[];
}

/** `drive/2026-09/x.mp4` -> `drive/2026-09/x.transcript.json`: the transcript
 * sits next to the video it came from, in the same folder. */
export function siblingTranscriptKey(storageKey: string): string {
  const withoutExtension = storageKey.replace(/\.[^./]+$/, '');
  return `${withoutExtension}.transcript.json`;
}

/** Transcribes one Drive file with faster-whisper (model "small", CPU) and
 * saves the result as JSON next to it in the Drive. The audio never touches
 * the volume: it is downloaded from R2 to a temp file for the Python process
 * to read, and the temp file is always removed. */
export const runTranscribeJob: JobHandler = async (job: Job, ctx: JobContext) => {
  const { storageKey, language } = inputSchema.parse(job.input);
  const bytes = await ctx.storage.get(storageKey);
  if (!bytes) throw new Error('the file is not in storage (was it moved or deleted?)');

  const dir = await mkdtemp(join(tmpdir(), 'wings-transcribe-'));
  const filePath = join(dir, 'input');
  try {
    await writeFile(filePath, bytes);
    const stdout = await ctx.runWhisper(filePath, { threads: ctx.threads, language });
    const raw = JSON.parse(stdout) as WhisperRaw;
    const outputStorageKey = siblingTranscriptKey(storageKey);
    const json = JSON.stringify(
      { language: raw.language, languageProbability: raw.languageProbability, segments: raw.segments },
      null,
      2,
    );
    await ctx.storage.put(outputStorageKey, Buffer.from(json, 'utf8'), 'application/json');
    const output: TranscribeOutput = {
      outputStorageKey,
      language: raw.language,
      languageProbability: raw.languageProbability,
      durationSeconds: raw.durationSeconds,
      segments: raw.segments,
    };
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
