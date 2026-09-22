import { describe, expect, it } from 'vitest';
import type { Job } from '../queue.js';
import { baseContext } from '../test/context.js';
import { createMemoryStorage } from '../test/memory-storage.js';
import type { JobContext } from './types.js';
import { runFfprobeJob } from './ffprobe.js';

const FFPROBE_JSON = JSON.stringify({
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.345000', size: '999', bit_rate: '128000' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
  ],
});

function contextWith(overrides: Partial<JobContext> = {}): JobContext {
  return baseContext({ runFfprobe: async () => FFPROBE_JSON, ...overrides });
}

describe('the ffprobe job', () => {
  it('downloads the file from storage, runs ffprobe on it, and returns the parsed metadata', async () => {
    const storage = createMemoryStorage({ 'drive/2026-09/a.mp4': Buffer.from('fake video bytes') });
    let probedPath: string | undefined;
    const job: Job = { id: '1', type: 'ffprobe', input: { storageKey: 'drive/2026-09/a.mp4' }, attempts: 1 };

    const output = await runFfprobeJob(
      job,
      contextWith({
        storage,
        runFfprobe: async (filePath) => {
          probedPath = filePath;
          return FFPROBE_JSON;
        },
      }),
    );

    expect(probedPath).toMatch(/wings-ffprobe-/);
    expect(output).toEqual({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 12.345,
      sizeBytes: 999,
      bitRate: 128000,
      streams: [
        { index: 0, codecType: 'video', codecName: 'h264', width: 1920, height: 1080, sampleRateHz: null, channels: null },
        { index: 1, codecType: 'audio', codecName: 'aac', width: null, height: null, sampleRateHz: 48000, channels: 2 },
      ],
    });
  });

  it('refuses a job whose file is not in storage', async () => {
    const job: Job = { id: '1', type: 'ffprobe', input: { storageKey: 'drive/missing.mp4' }, attempts: 1 };
    await expect(runFfprobeJob(job, contextWith())).rejects.toThrow(/not in storage/);
  });

  it('rejects an input that does not name a storage key', async () => {
    const job: Job = { id: '1', type: 'ffprobe', input: {}, attempts: 1 };
    await expect(runFfprobeJob(job, contextWith())).rejects.toThrow();
  });
});
