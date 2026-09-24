import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTION_MIN_RUN_SECONDS, type CaptionZone } from '@wings/shared';
import { z } from 'zod';
import type { Job } from '../queue.js';
import type { JobContext, JobHandler } from './types.js';

/**
 * `caption_layout`: one zone per caption cue (bottom, top or middle), away
 * from faces and on-screen text. The API queues it after a smart
 * transcription is filed (apps/api/src/modules/studio/service.ts); the output
 * is the zones and nothing else, so no trace of a face is ever stored.
 */

const inputSchema = z.object({
  /** The video. */
  storageKey: z.string().min(1),
  /** The transcribe job's JSON, next to the video. Only the cue times are read. */
  transcriptStorageKey: z.string().min(1),
});

const transcriptSchema = z.object({
  segments: z.array(z.object({ start: z.number().min(0), end: z.number().min(0) })),
});

/** What the Python script prints: per cue, [top, middle, bottom] costs. */
const measuredSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frames: z.number().int().min(0),
  costs: z.array(z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)])),
});
export type Costs = [top: number, middle: number, bottom: number];

export interface CaptionLayoutOutput {
  zones: CaptionZone[];
  frames: number;
  width: number;
  height: number;
}

/** Below this, a band counts as free: a stray detection the size of a coin does not move a caption. */
const FREE = 0.02;
/** Preference when bands are equally free: bottom, then top, then middle. */
const BIAS: Record<CaptionZone, number> = { bottom: 0, top: 0.01, middle: 0.03 };
const costOf = (costs: Costs, zone: CaptionZone) =>
  zone === 'top' ? costs[0] : zone === 'middle' ? costs[1] : costs[2];

function bestZone(costs: Costs): CaptionZone {
  const zones: CaptionZone[] = ['bottom', 'top', 'middle'];
  const score = (zone: CaptionZone) => Math.max(0, costOf(costs, zone) - FREE) + BIAS[zone];
  return zones.reduce((best, zone) => (score(zone) < score(best) ? zone : best), 'bottom');
}

/**
 * The zone of each cue: the freest band, then smoothed so the caption never
 * sits somewhere for less than CAPTION_MIN_RUN_SECONDS. A run that is too
 * short joins the neighbour whose zone costs it least.
 */
export function chooseZones(
  cues: readonly { start: number; end: number }[],
  costs: readonly Costs[],
  minRunSeconds = CAPTION_MIN_RUN_SECONDS,
): CaptionZone[] {
  const zones = cues.map((_, index) => bestZone(costs[index] ?? [0, 0, 0]));
  const runsOf = () => {
    const runs: { from: number; to: number; zone: CaptionZone }[] = [];
    zones.forEach((zone, index) => {
      const last = runs[runs.length - 1];
      if (last && last.zone === zone) last.to = index;
      else runs.push({ from: index, to: index, zone });
    });
    return runs;
  };
  const spanOf = (run: { from: number; to: number }) =>
    (cues[run.to]?.end ?? 0) - (cues[run.from]?.start ?? 0);
  const runCost = (run: { from: number; to: number }, zone: CaptionZone) => {
    let total = 0;
    for (let index = run.from; index <= run.to; index += 1)
      total += costOf(costs[index] ?? [0, 0, 0], zone);
    return total;
  };

  // Each pass merges the shortest too-short run; at most one pass per cue.
  for (let pass = 0; pass < cues.length; pass += 1) {
    const runs = runsOf();
    if (runs.length < 2) break;
    const short = runs
      .map((run, index) => ({ run, index, span: spanOf(run) }))
      .filter((item) => item.span < minRunSeconds)
      .sort((a, b) => a.span - b.span)[0];
    if (!short) break;
    const neighbours = [runs[short.index - 1], runs[short.index + 1]].filter(
      (run): run is NonNullable<typeof run> => run !== undefined,
    );
    const target = neighbours.reduce((best, run) =>
      runCost(short.run, run.zone) < runCost(short.run, best.zone) ? run : best,
    );
    for (let index = short.run.from; index <= short.run.to; index += 1) zones[index] = target.zone;
  }
  return zones;
}

export const runCaptionLayoutJob: JobHandler = async (job: Job, ctx: JobContext) => {
  const { storageKey, transcriptStorageKey } = inputSchema.parse(job.input);
  const transcriptBytes = await ctx.storage.get(transcriptStorageKey);
  if (!transcriptBytes) throw new Error('the transcript is not in storage (was it moved or deleted?)');
  const { segments } = transcriptSchema.parse(JSON.parse(transcriptBytes.toString('utf8')));
  const cues = segments.map((segment) => ({ start: segment.start, end: Math.max(segment.end, segment.start) }));
  if (cues.length === 0) return { zones: [], frames: 0, width: 0, height: 0 } satisfies CaptionLayoutOutput;

  const bytes = await ctx.storage.get(storageKey);
  if (!bytes) throw new Error('the file is not in storage (was it moved or deleted?)');
  const dir = await mkdtemp(join(tmpdir(), 'wings-caption-layout-'));
  const filePath = join(dir, 'input');
  const cuesPath = join(dir, 'cues.json');
  try {
    await writeFile(filePath, bytes);
    await writeFile(cuesPath, JSON.stringify(cues.map((cue) => [cue.start, cue.end])));
    const stdout = await ctx.runCaptionLayout(filePath, cuesPath, { threads: ctx.threads });
    const measured = measuredSchema.parse(JSON.parse(stdout));
    if (measured.costs.length !== cues.length) throw new Error('the layout script measured a different number of cues');
    const output: CaptionLayoutOutput = {
      zones: chooseZones(cues, measured.costs),
      frames: measured.frames,
      width: measured.width,
      height: measured.height,
    };
    return output;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
