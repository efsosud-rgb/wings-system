import { resolveFont } from './fonts.js';
import type { AudioClip, Position, RenderPlan, TransitionName, VisualClip } from './plan.js';
import { TRANSITION_SECONDS } from './plan.js';

/** What kind of ffmpeg input a clip's asset needs. A `video` asset used both
 * as a picture and (via its own audio) is decoded once and read as both. */
type AssetKind = 'video' | 'image' | 'audio';

interface AssetInput {
  assetId: string;
  kind: AssetKind;
  index: number;
  path: string;
}

/** ffmpeg filter-graph string literal: backslash and colon are the two
 * characters that need escaping inside a filter's own argument value. */
function escapeFilterArg(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function assColor(hex: string, opacity = 1): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  const alpha = Math.round((1 - opacity) * 255)
    .toString(16)
    .padStart(2, '0');
  // ASS/libass colour order is &HAABBGGRR&.
  return `&H${alpha}${b}${g}${r}&`.toUpperCase();
}

/** Top-left corner (px) of a `cw`×`ch` box at one of the nine positions plus
 * an offset given as a fraction of the canvas (docs/studio/jobs.md: "an x
 * offset of 0.5 moves the asset half the viewport width"). Down and right are
 * positive — not specified by the doc, chosen here. */
function boxOrigin(
  position: Position,
  cw: number,
  ch: number,
  canvasW: number,
  canvasH: number,
  offsetX: number,
  offsetY: number,
): { x: number; y: number } {
  const xOf: Record<Position, number> = {
    topLeft: 0,
    left: 0,
    bottomLeft: 0,
    top: (canvasW - cw) / 2,
    center: (canvasW - cw) / 2,
    bottom: (canvasW - cw) / 2,
    topRight: canvasW - cw,
    right: canvasW - cw,
    bottomRight: canvasW - cw,
  };
  const yOf: Record<Position, number> = {
    topLeft: 0,
    top: 0,
    topRight: 0,
    left: (canvasH - ch) / 2,
    center: (canvasH - ch) / 2,
    right: (canvasH - ch) / 2,
    bottomLeft: canvasH - ch,
    bottom: canvasH - ch,
    bottomRight: canvasH - ch,
  };
  return {
    x: Math.round(xOf[position] + offsetX * canvasW),
    y: Math.round(yOf[position] + offsetY * canvasH),
  };
}

function fitFilters(fit: 'crop' | 'cover' | 'contain', w: number, h: number): string {
  if (fit === 'cover') return `scale=${w}:${h}`;
  if (fit === 'contain') {
    return (
      `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`
    );
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
}

function fadeFilters(clip: { length: number; transitionIn: TransitionName; transitionOut: TransitionName }): string[] {
  const filters: string[] = [];
  if (clip.transitionIn !== 'none') {
    const d = TRANSITION_SECONDS[clip.transitionIn];
    filters.push(`fade=t=in:st=0:d=${d}:alpha=1`);
  }
  if (clip.transitionOut !== 'none') {
    const d = TRANSITION_SECONDS[clip.transitionOut];
    filters.push(`fade=t=out:st=${Math.max(0, clip.length - d)}:d=${d}:alpha=1`);
  }
  return filters;
}

/** One media (video/image) clip: trimmed, fit to the canvas, scaled,
 * positioned on a transparent frame, faded, then shifted to its place on the
 * global timeline. */
function mediaClipFilter(clip: VisualClip & { kind: 'video' | 'image' }, input: AssetInput, plan: RenderPlan, label: string): string {
  const cw = Math.max(1, Math.round(plan.width * clip.scale));
  const ch = Math.max(1, Math.round(plan.height * clip.scale));
  const { x, y } = boxOrigin(clip.position, cw, ch, plan.width, plan.height, clip.offsetX, clip.offsetY);
  const steps = [
    `trim=start=${clip.trim}:duration=${clip.length}`,
    'setpts=PTS-STARTPTS',
    'format=yuva420p',
    fitFilters(clip.fit, cw, ch),
    `pad=${plan.width}:${plan.height}:${x}:${y}:color=black@0.0`,
    `colorchannelmixer=aa=${clip.opacity}`,
    ...fadeFilters(clip),
    `setpts=PTS+${clip.start}/TB`,
  ];
  return `[${input.index}:v]${steps.join(',')}[${label}]`;
}

/** Horizontal/vertical anchor for `drawtext`, in ffmpeg's own runtime
 * expressions (`text_w`/`text_h`): unlike a media clip, text has no size
 * until ffmpeg lays it out, so this cannot be a plain pixel offset. `align`
 * is not read here — with no bounding box to wrap text inside (out of
 * scope), it would have nothing to align within `position`'s anchor. */
function textOrigin(position: Position, offsetX: number, offsetY: number, canvasW: number, canvasH: number) {
  const xExpr: Record<Position, string> = {
    topLeft: '0',
    left: '0',
    bottomLeft: '0',
    top: '(w-text_w)/2',
    center: '(w-text_w)/2',
    bottom: '(w-text_w)/2',
    topRight: 'w-text_w',
    right: 'w-text_w',
    bottomRight: 'w-text_w',
  };
  const yExpr: Record<Position, string> = {
    topLeft: '0',
    top: '0',
    topRight: '0',
    left: '(h-text_h)/2',
    center: '(h-text_h)/2',
    right: '(h-text_h)/2',
    bottomLeft: 'h-text_h',
    bottom: 'h-text_h',
    bottomRight: 'h-text_h',
  };
  const offX = Math.round(offsetX * canvasW);
  const offY = Math.round(offsetY * canvasH);
  return {
    x: offX ? `${xExpr[position]}+${offX}` : xExpr[position],
    y: offY ? `${yExpr[position]}+${offY}` : yExpr[position],
  };
}

function drawtextFilter(clip: VisualClip & { kind: 'text' }, plan: RenderPlan, fontPath: string): string {
  const { x, y } = textOrigin(clip.position, clip.offsetX, clip.offsetY, plan.width, plan.height);
  return (
    `drawtext=fontfile='${escapeFilterArg(fontPath)}':text='${escapeFilterArg(clip.text)}':` +
    `fontsize=${clip.fontSizePx}:fontcolor=${clip.color}@${clip.opacity}:x=${x}:y=${y}:` +
    `enable='between(t,${clip.start},${clip.start + clip.length})'`
  );
}

function subtitlesFilter(clip: VisualClip & { kind: 'caption' }, srtPath: string): string {
  const style = [
    `FontName=${clip.fontFamily}`,
    `FontSize=${clip.fontSizePx}`,
    `PrimaryColour=${assColor(clip.color)}`,
    clip.backgroundColor
      ? `BackColour=${assColor(clip.backgroundColor)},BorderStyle=3`
      : 'BorderStyle=1',
  ].join(',');
  return `subtitles=filename='${escapeFilterArg(srtPath)}':force_style='${style}'`;
}

function audioClipFilter(clip: AudioClip, input: AssetInput, label: string): string {
  const delayMs = Math.round(clip.start * 1000);
  const steps = [
    `atrim=start=${clip.trim}:duration=${clip.length}`,
    'asetpts=PTS-STARTPTS',
    `volume=${clip.volume}`,
    `adelay=${delayMs}|${delayMs}:all=1`,
  ];
  return `[${input.index}:a]${steps.join(',')}[${label}]`;
}

/** Every asset a plan needs, each assigned exactly one ffmpeg input index —
 * a `video` clip and its own audio share one decode. */
export function collectAssetInputs(plan: RenderPlan, assetPaths: Record<string, string>): AssetInput[] {
  const kinds = new Map<string, AssetKind>();
  for (const clip of plan.visual) {
    if (clip.kind === 'video' || clip.kind === 'image') kinds.set(clip.assetId, clip.kind);
  }
  for (const clip of plan.audio) {
    if (!kinds.has(clip.assetId)) kinds.set(clip.assetId, 'audio');
  }
  return [...kinds.entries()].map(([assetId, kind], index) => {
    const path = assetPaths[assetId];
    if (!path) throw new Error(`no local path was downloaded for asset ${assetId}`);
    return { assetId, kind, index, path };
  });
}

export interface FfmpegCommand {
  args: string[];
}

/**
 * Builds the full argv for one `ffmpeg` invocation: background, every visual
 * clip composited bottom-to-top (media via `overlay`, text via `drawtext`,
 * captions via `subtitles`), every audio clip mixed, encoded to the
 * requested container. Pure and deterministic — no filesystem or process
 * access — so it is unit-tested on its own.
 */
export function buildFfmpegCommand(
  plan: RenderPlan,
  assetPaths: Record<string, string>,
  captionPaths: Record<string, string>,
  outputPath: string,
  encoding: { videoBitrate: number; audioBitrate: number },
): FfmpegCommand {
  const inputs = collectAssetInputs(plan, assetPaths);
  const byAssetId = new Map(inputs.map((input) => [input.assetId, input]));

  const inputArgs: string[] = [];
  for (const input of inputs) {
    if (input.kind === 'image') inputArgs.push('-loop', '1', '-framerate', String(plan.fps), '-i', input.path);
    else inputArgs.push('-i', input.path);
  }

  const graph: string[] = [];
  graph.push(
    `color=c=${plan.background}:s=${plan.width}x${plan.height}:d=${plan.totalDurationSeconds}:r=${plan.fps},format=yuva420p[base0]`,
  );

  // Every clip advances `current` to a new, uniquely numbered label, whatever
  // kind it is — one counter, no risk of two steps landing on the same name.
  let current = 'base0';
  plan.visual.forEach((clip, step) => {
    const next = `acc${step + 1}`;
    switch (clip.kind) {
      case 'video':
      case 'image': {
        const input = byAssetId.get(clip.assetId);
        if (!input) throw new Error(`no input registered for asset ${clip.assetId}`);
        const clipLabel = `clip${step}`;
        graph.push(mediaClipFilter(clip, input, plan, clipLabel));
        graph.push(
          `[${current}][${clipLabel}]overlay=0:0:enable='between(t,${clip.start},${clip.start + clip.length})':eof_action=pass[${next}]`,
        );
        break;
      }
      case 'text':
        graph.push(`[${current}]${drawtextFilter(clip, plan, resolveFont(clip.fontFamily).path)}[${next}]`);
        break;
      case 'caption': {
        const srtPath = captionPaths[clip.assetId];
        if (!srtPath) throw new Error(`no caption file was prepared for asset ${clip.assetId}`);
        graph.push(`[${current}]${subtitlesFilter(clip, srtPath)}[${next}]`);
        break;
      }
    }
    current = next;
  });
  graph.push(`[${current}]format=yuv420p[vout]`);

  const audioLabels: string[] = [];
  plan.audio.forEach((clip, index) => {
    const input = byAssetId.get(clip.assetId);
    if (!input) throw new Error(`no input registered for asset ${clip.assetId}`);
    const label = `a${index}`;
    graph.push(audioClipFilter(clip, input, label));
    audioLabels.push(label);
  });
  const hasAudio = audioLabels.length > 0;
  if (hasAudio) {
    graph.push(
      `${audioLabels.map((label) => `[${label}]`).join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0[aout]`,
    );
  }

  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex',
    graph.join(';'),
    '-map',
    '[vout]',
    ...(hasAudio ? ['-map', '[aout]'] : []),
    '-r',
    String(plan.fps),
    '-c:v',
    'libx264',
    '-b:v',
    String(encoding.videoBitrate),
    '-pix_fmt',
    'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', String(encoding.audioBitrate)] : []),
    '-t',
    String(plan.totalDurationSeconds),
    '-movflags',
    '+faststart',
    outputPath,
  ];
  return { args };
}
