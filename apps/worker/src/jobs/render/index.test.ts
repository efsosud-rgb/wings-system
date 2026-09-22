import { wingsDriveRef } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import type { Job } from '../../queue.js';
import { baseContext } from '../../test/context.js';
import { createMemoryStorage } from '../../test/memory-storage.js';
import type { JobContext } from '../types.js';
import { runRenderJob } from './index.js';

const VIDEO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VIDEO_KEY = 'drive/2026-09/a.mp4';
const OUTPUT_KEY = 'drive/2026-09/out.mp4';

const VIDEO_BYTES = Buffer.from('fake video bytes');

function jobWith(overrides: { totalLength?: number } = {}): Job {
  const length = overrides.totalLength ?? 10;
  return {
    id: 'job-1',
    type: 'render',
    attempts: 1,
    input: {
      version: 1,
      project: {
        timeline: {
          tracks: [
            { clips: [{ start: 0, length, asset: { type: 'video', src: wingsDriveRef(VIDEO_ID) } }] },
          ],
        },
      },
      assets: {
        [VIDEO_ID]: { storageKey: VIDEO_KEY, mimeType: 'video/mp4', byteSize: VIDEO_BYTES.length },
      },
      output: {
        storageKey: OUTPUT_KEY,
        container: 'mp4',
        width: 1080,
        height: 1920,
        fps: 30,
        videoBitrate: 8_000_000,
        audioBitrate: 192_000,
      },
    },
  };
}

const OUTPUT_PROBE = JSON.stringify({
  format: { duration: '10.0' },
  streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '30/1' }],
});

function contextWith(overrides: Partial<JobContext> = {}): JobContext {
  const storage = createMemoryStorage({ [VIDEO_KEY]: VIDEO_BYTES });
  return baseContext({
    storage,
    runFfprobe: async () => OUTPUT_PROBE,
    // Writes a real (tiny) file so the handler's own `readFile` on the output succeeds.
    runFfmpeg: async (args) => {
      const outputPath = args.at(-1)!;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outputPath, Buffer.from('rendered bytes'));
    },
    ...overrides,
  });
}

describe('runRenderJob — happy path', () => {
  it('downloads the asset, renders, and uploads the result under the output key', async () => {
    const ctx = contextWith();
    const output = (await runRenderJob(jobWith(), ctx)) as Record<string, unknown>;

    expect(output).toMatchObject({
      storageKey: OUTPUT_KEY,
      mimeType: 'video/mp4',
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 10,
      unsupported: [],
    });
    expect(output.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(typeof output.renderSeconds).toBe('number');

    const uploaded = await ctx.storage.get(OUTPUT_KEY);
    expect(uploaded?.toString()).toBe('rendered bytes');
  });
});

describe('runRenderJob — refusals', () => {
  it('fails as asset_missing when the file is gone from storage', async () => {
    const ctx = contextWith({ storage: createMemoryStorage() }); // nothing stored
    await expect(runRenderJob(jobWith(), ctx)).rejects.toThrow(/^asset_missing:/);
  });

  it('fails as asset_missing when the stored size does not match what the job declared', async () => {
    const ctx = contextWith({ storage: createMemoryStorage({ [VIDEO_KEY]: Buffer.from('short') }) });
    await expect(runRenderJob(jobWith(), ctx)).rejects.toThrow(/^asset_missing:/);
  });

  it('fails as asset_undecodable when ffprobe cannot open a downloaded asset', async () => {
    const ctx = contextWith({
      runFfprobe: async () => {
        throw new Error('ffprobe: invalid data found when processing input');
      },
    });
    await expect(runRenderJob(jobWith(), ctx)).rejects.toThrow(/^asset_undecodable:/);
  });

  it('fails as too_long before downloading anything', async () => {
    let downloaded = false;
    const ctx = contextWith({
      storage: {
        ...createMemoryStorage({ [VIDEO_KEY]: VIDEO_BYTES }),
        async get(_key: string) {
          downloaded = true;
          return VIDEO_BYTES;
        },
      },
      renderLimits: { maxSeconds: 5, timeoutSeconds: 7200, maxInputBytes: 8 * 1024 ** 3, tmpDir: '' },
    });
    await expect(runRenderJob(jobWith({ totalLength: 10 }), ctx)).rejects.toThrow(/^too_long:/);
    expect(downloaded).toBe(false);
  });

  it('fails as render_failed when ffmpeg exits with an error', async () => {
    const ctx = contextWith({
      runFfmpeg: async () => {
        throw new Error('ffmpeg exited with status 1');
      },
    });
    await expect(runRenderJob(jobWith(), ctx)).rejects.toThrow(/^render_failed: ffmpeg exited with status 1$/);
  });

  it('fails as timeout when the attempt runs past RENDER_TIMEOUT_SECONDS', async () => {
    const ctx = contextWith({
      runFfmpeg: () => new Promise(() => {}), // never resolves
      renderLimits: { maxSeconds: 3600, timeoutSeconds: 0.05, maxInputBytes: 8 * 1024 ** 3, tmpDir: '' },
    });
    await expect(runRenderJob(jobWith(), ctx)).rejects.toThrow(/^timeout:/);
  });
});
