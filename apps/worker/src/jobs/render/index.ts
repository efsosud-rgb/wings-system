import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '../../queue.js';
import type { JobContext, JobHandler } from '../types.js';
import { RenderError, parseRenderInput, type RenderJobInput, type RenderJobOutput } from './contract.js';
import { buildFfmpegCommand } from './ffmpeg-command.js';
import { buildRenderPlan, type RenderPlan } from './plan.js';

interface OutputProbe {
  width: number | null;
  height: number | null;
  fps: number | null;
  durationSeconds: number | null;
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.split('/').map(Number);
  const num = parts[0];
  const den = parts[1];
  if (num === undefined || !Number.isFinite(num)) return null;
  if (den === undefined || den === 0) return num;
  return num / den;
}

/** The result's own dimensions, fps and duration, read back with ffprobe —
 * more trustworthy than echoing what the job asked for, since a filter chain
 * bug would otherwise go unnoticed. Falls back to the request when a field
 * is missing, rather than fail a render that otherwise worked. */
function parseOutputProbe(stdout: string): OutputProbe {
  const raw = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const video = raw.streams?.find((stream) => stream.codec_type === 'video');
  return {
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseFrameRate(video?.r_frame_rate),
    durationSeconds: raw.format?.duration ? Number(raw.format.duration) : null,
  };
}

async function withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RenderError('timeout', `passou de ${seconds}s`)), seconds * 1000);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Which local assets each downloaded file plays: `-i` input for ffmpeg
 * (media and audio), and/or a `subtitles` filter's own file (captions). A
 * clip's asset can need both a download and nothing else — captions are
 * never decoded by ffmpeg as a stream, just read as a text file. */
function assetIdsNeeded(plan: RenderPlan): string[] {
  const ids = new Set<string>();
  for (const clip of plan.visual) if (clip.kind !== 'text') ids.add(clip.assetId);
  for (const clip of plan.audio) ids.add(clip.assetId);
  return [...ids];
}

async function downloadAssets(
  ctx: JobContext,
  input: RenderJobInput,
  ids: string[],
  dir: string,
): Promise<Record<string, string>> {
  const paths: Record<string, string> = {};
  let index = 0;
  for (const id of ids) {
    const asset = input.assets[id];
    if (!asset) throw new RenderError('invalid_project', `arquivo "${id}" citado no projeto sem entrada em "assets"`);
    const head = await ctx.storage.head(asset.storageKey);
    if (!head || head.size !== asset.byteSize) {
      throw new RenderError('asset_missing', 'um arquivo do projeto não está mais no armazenamento');
    }
    const bytes = await ctx.storage.get(asset.storageKey);
    if (!bytes) throw new RenderError('asset_missing', 'um arquivo do projeto não está mais no armazenamento');
    const path = join(dir, `asset-${index}`);
    index += 1;
    await writeFile(path, bytes);
    paths[id] = path;
  }
  return paths;
}

async function checkDecodable(ctx: JobContext, plan: RenderPlan, assetPaths: Record<string, string>): Promise<void> {
  const captionAssetIds = new Set(plan.visual.filter((clip) => clip.kind === 'caption').map((clip) => clip.assetId));
  for (const [id, path] of Object.entries(assetPaths)) {
    if (captionAssetIds.has(id)) continue; // a caption file is text, not a stream ffmpeg opens
    try {
      await ctx.runFfprobe(path);
    } catch {
      throw new RenderError('asset_undecodable', 'um arquivo do projeto não pôde ser aberto pelo FFmpeg');
    }
  }
}

async function renderNow(ctx: JobContext, input: RenderJobInput, plan: RenderPlan, startedAt: number, dir: string): Promise<RenderJobOutput> {
  const ids = assetIdsNeeded(plan);
  const assetPaths = await downloadAssets(ctx, input, ids, dir);
  await checkDecodable(ctx, plan, assetPaths);

  const captionPaths: Record<string, string> = {};
  for (const clip of plan.visual) {
    if (clip.kind === 'caption') captionPaths[clip.assetId] = assetPaths[clip.assetId]!;
  }

  const outputPath = join(dir, `output.${input.output.container}`);
  const command = buildFfmpegCommand(plan, assetPaths, captionPaths, outputPath, {
    videoBitrate: input.output.videoBitrate,
    audioBitrate: input.output.audioBitrate,
  });
  try {
    await ctx.runFfmpeg(['-threads', String(ctx.threads), ...command.args]);
  } catch (error) {
    throw new RenderError('render_failed', error instanceof Error ? error.message : String(error));
  }

  const resultBytes = await readFile(outputPath);
  const checksum = `sha256:${createHash('sha256').update(resultBytes).digest('hex')}`;
  const probe = parseOutputProbe(await ctx.runFfprobe(outputPath));
  await ctx.storage.put(input.output.storageKey, resultBytes, 'video/mp4');

  return {
    storageKey: input.output.storageKey,
    byteSize: resultBytes.length,
    checksum,
    mimeType: 'video/mp4',
    width: probe.width ?? input.output.width,
    height: probe.height ?? input.output.height,
    fps: probe.fps ?? input.output.fps,
    durationSeconds: probe.durationSeconds ?? plan.totalDurationSeconds,
    unsupported: plan.unsupported,
    renderSeconds: (Date.now() - startedAt) / 1000,
  };
}

/**
 * Renders one Wings Studio project with FFmpeg (docs/studio/jobs.md): downloads
 * the assets the project cites, checks they decode, composes video/audio/text/
 * captions per the plan, and uploads the result to the Drive's storage under
 * the key the API chose. Never touches the volume, never retries (the queue
 * gives `render` one attempt — see `maxAttemptsFor` in `queue.ts`), and always
 * cleans up its temp directory, success or failure.
 *
 * Known gap: a timeout rejects the *job*, but does not kill an already-running
 * ffmpeg child process — Node has no portable way to do that through
 * `child_process.execFile` without threading an `AbortSignal` end to end,
 * which this first version does not do. A stuck render outlives its timeout
 * until it finishes or the container restarts.
 */
export const runRenderJob: JobHandler = async (job: Job, ctx: JobContext) => {
  const startedAt = Date.now();
  const input = parseRenderInput(job.input);
  const plan = buildRenderPlan(input);

  if (plan.totalDurationSeconds > ctx.renderLimits.maxSeconds) {
    throw new RenderError(
      'too_long',
      `duração de ${Math.round(plan.totalDurationSeconds)}s passa do limite de ${ctx.renderLimits.maxSeconds}s`,
    );
  }
  const totalInputBytes = Object.values(input.assets).reduce((sum, asset) => sum + asset.byteSize, 0);
  if (totalInputBytes > ctx.renderLimits.maxInputBytes) {
    // The doc's limits table lists RENDER_MAX_INPUT_BYTES without an error
    // code of its own; classified as render_failed since it is about this
    // attempt's ability to render, not the project's structure or duration.
    throw new RenderError('render_failed', `arquivos de entrada passam do limite de ${ctx.renderLimits.maxInputBytes} bytes`);
  }

  const dir = await mkdtemp(join(ctx.renderLimits.tmpDir || tmpdir(), 'wings-render-'));
  try {
    return await withTimeout(renderNow(ctx, input, plan, startedAt, dir), ctx.renderLimits.timeoutSeconds);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** What a render found already delivered is finished with: the output of a
 * normal run, minus the time it took (nobody saw it end), marked recovered. */
export type RecoveredRenderOutput = Omit<RenderJobOutput, 'renderSeconds'> & {
  renderSeconds: null;
  recovered: true;
};

/**
 * A render whose worker died after the upload but before the row said
 * `done`. The object is under the one key the API chose, and a PUT is all or
 * nothing, so if it is there the render was delivered: it is finished as done
 * (and the API files it as usual) rather than failed or rendered again.
 * Null when the object is not there, or the input cannot be read.
 */
export async function recoverDeliveredRender(
  job: Job,
  ctx: Pick<JobContext, 'storage'>,
): Promise<RecoveredRenderOutput | null> {
  let input: RenderJobInput;
  let plan: RenderPlan;
  try {
    input = parseRenderInput(job.input);
    plan = buildRenderPlan(input);
  } catch {
    return null;
  }
  const head = await ctx.storage.head(input.output.storageKey);
  if (!head || head.size === 0) return null;
  const bytes = await ctx.storage.get(input.output.storageKey);
  if (!bytes || bytes.length !== head.size) return null;
  return {
    storageKey: input.output.storageKey,
    byteSize: bytes.length,
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    mimeType: 'video/mp4',
    width: input.output.width,
    height: input.output.height,
    fps: input.output.fps,
    durationSeconds: plan.totalDurationSeconds,
    unsupported: plan.unsupported,
    renderSeconds: null,
    recovered: true,
  };
}
