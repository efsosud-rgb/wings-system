import { describe, expect, it } from 'vitest';
import type { Job } from '../queue.js';
import { baseContext } from '../test/context.js';
import { createMemoryStorage } from '../test/memory-storage.js';
import { chooseZones, runCaptionLayoutJob, type Costs } from './caption-layout.js';

const FREE: Costs = [0, 0, 0];
/** A face at the bottom of the frame. */
const FACE_LOW: Costs = [0, 0.1, 0.9];
/** A sign across the top, a face at the bottom. */
const BUSY_TOP_AND_BOTTOM: Costs = [0.6, 0, 0.9];

const cuesOf = (...lengths: number[]) => {
  let at = 0;
  return lengths.map((length) => {
    const cue = { start: at, end: at + length };
    at += length;
    return cue;
  });
};

describe('chooseZones', () => {
  it('keeps the caption at the bottom when the frame is free', () => {
    expect(chooseZones(cuesOf(3, 3), [FREE, FREE])).toEqual(['bottom', 'bottom']);
  });

  it('moves up when a face is at the bottom, and to the middle when top and bottom are busy', () => {
    expect(chooseZones(cuesOf(3, 3), [FACE_LOW, BUSY_TOP_AND_BOTTOM])).toEqual(['top', 'middle']);
  });

  it('ignores a detection too small to matter', () => {
    expect(chooseZones(cuesOf(3), [[0, 0, 0.015]])).toEqual(['bottom']);
  });

  it('never leaves the caption in one place for less than 2 s: a short run joins its cheaper neighbour', () => {
    // Bottom 3 s, then 1 s where the bottom is busy, then bottom again.
    expect(chooseZones(cuesOf(3, 1, 3), [FREE, FACE_LOW, FREE])).toEqual([
      'bottom',
      'bottom',
      'bottom',
    ]);
    // Two short cues in a row that together last 2 s stay where they are.
    expect(chooseZones(cuesOf(3, 1, 1, 3), [FREE, FACE_LOW, FACE_LOW, FREE])).toEqual([
      'bottom',
      'top',
      'top',
      'bottom',
    ]);
  });

  it('with only short cues, settles on one place', () => {
    const zones = chooseZones(cuesOf(0.5, 0.5, 0.5), [FREE, FACE_LOW, FREE]);
    expect(new Set(zones).size).toBe(1);
  });

  it('gives no zone for no cue', () => {
    expect(chooseZones([], [])).toEqual([]);
  });
});

describe('the caption_layout job', () => {
  const transcript = JSON.stringify({
    language: 'pt',
    segments: [
      { start: 0, end: 3, text: 'Olá.' },
      { start: 3, end: 6, text: 'Tudo bem?' },
    ],
  });
  const job: Job = {
    id: 'j1',
    type: 'caption_layout',
    input: { storageKey: 'drive/v.mp4', transcriptStorageKey: 'drive/v.transcript.json' },
    attempts: 1,
  };

  it('hands the script the cue times only, and keeps only the zones', async () => {
    const storage = createMemoryStorage({
      'drive/v.mp4': Buffer.from('video'),
      'drive/v.transcript.json': Buffer.from(transcript),
    });
    let cuesSent: unknown = null;
    const output = await runCaptionLayoutJob(
      job,
      baseContext({
        storage,
        runCaptionLayout: async (filePath, cuesPath, options) => {
          expect(filePath).toMatch(/wings-caption-layout-/);
          expect(options.threads).toBe(1);
          const { readFile } = await import('node:fs/promises');
          cuesSent = JSON.parse(await readFile(cuesPath, 'utf8'));
          return JSON.stringify({ width: 1080, height: 1920, frames: 6, costs: [FREE, FACE_LOW] });
        },
      }),
    );
    expect(cuesSent).toEqual([
      [0, 3],
      [3, 6],
    ]);
    expect(output).toEqual({ zones: ['bottom', 'top'], frames: 6, width: 1080, height: 1920 });
    // No text of the transcript and no measurement goes into the output.
    expect(JSON.stringify(output)).not.toMatch(/Olá|0\.9/);
  });

  it('fails when the script measured a different number of cues', async () => {
    const storage = createMemoryStorage({
      'drive/v.mp4': Buffer.from('video'),
      'drive/v.transcript.json': Buffer.from(transcript),
    });
    await expect(
      runCaptionLayoutJob(
        job,
        baseContext({
          storage,
          runCaptionLayout: async () => JSON.stringify({ width: 1, height: 1, frames: 1, costs: [FREE] }),
        }),
      ),
    ).rejects.toThrow(/different number of cues/);
  });

  it('refuses when the transcript is gone', async () => {
    await expect(runCaptionLayoutJob(job, baseContext())).rejects.toThrow(/transcript is not in storage/);
  });
});
