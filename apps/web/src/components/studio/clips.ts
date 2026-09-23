import {
  STUDIO_ASPECTS,
  STUDIO_POSITIONS,
  STUDIO_TRANSITIONS,
  type StudioAspect,
  type StudioPosition,
  type StudioTransition,
} from '@wings/shared';
import type { Edit, EditConfig } from '@wings/studio';
import type {
  CaptionStyle,
  ClipPatch,
  SelectedClip,
  ShapeKind,
  StudioFileKind,
  StudioLayer,
  TextPreset,
} from './session.js';

/**
 * Pure helpers between the core's document and the session contract: how a
 * Drive file becomes a clip, how a clip reads back as `SelectedClip`, and how
 * a `ClipPatch` becomes the core's own field names. No state, no network, so
 * the rules are testable on their own.
 */

export type Clip = Parameters<Edit['addTrack']>[1]['clips'][number];
export type ResolvedClip = NonNullable<ReturnType<Edit['getResolvedClipById']>>;

/** Loose views of the core's documents: the schema is large and typed elsewhere. */
export interface DocClip {
  id?: string;
  asset?: Record<string, unknown> & { type?: string; src?: unknown };
  start?: unknown;
  length?: unknown;
  [key: string]: unknown;
}
export interface DocTrack {
  clips?: DocClip[];
}
export interface EditDoc {
  timeline?: { tracks?: DocTrack[]; background?: string };
  output?: { size?: { width: number; height: number } };
}

/**
 * The document a new project starts from: no track, and the format as width
 * and height only. `STUDIO_ASPECTS` carries a label for the screen, and the
 * core's schema is strict about `output.size`, so the label must never leak
 * into it (on staging it did, and the editor refused to open).
 */
export function emptyEdit(aspect: StudioAspect): EditConfig {
  const { width, height } = STUDIO_ASPECTS[aspect];
  return {
    timeline: { background: '#000000', tracks: [] },
    output: { format: 'mp4', fps: 30, size: { width, height } },
  } as unknown as EditConfig;
}

/** A saved document with only what the core's `output.size` accepts. */
export function withCleanSize<T extends { output?: unknown }>(doc: T): T {
  const output = doc.output as { size?: Record<string, unknown> } | undefined;
  const size = output?.size;
  if (size && typeof size === 'object') {
    output.size = { width: size['width'], height: size['height'] };
  }
  return doc;
}

/**
 * The core validates with Zod and throws the issues as a JSON string. Nobody
 * should read that on a screen: the person gets one sentence and what to do,
 * the console gets the detail.
 */
export function friendlyCoreError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^\s*\[\s*\{[\s\S]*"code"/.test(message)) {
    console.error('studio core validation', message);
    return 'O projeto não pôde ser montado: a linha do tempo ou o formato estão fora do que o editor aceita. Crie um projeto novo ou abra outro arquivo do Drive.';
  }
  return error instanceof Error && message ? message : fallback;
}

export const WINGS_ORANGE = '#e95228';
export const TEXT_FONT = 'Work Sans';

/** Fonts the properties panel offers by name; the core fetches them from Google Fonts. */
export const STUDIO_FONTS = [
  'Work Sans',
  'Roboto',
  'Inter',
  'Montserrat',
  'Poppins',
  'Open Sans',
  'Lato',
  'Oswald',
  'Playfair Display',
  'Merriweather',
] as const;

export function kindOfMime(name: string, mimeType: string): StudioFileKind | null {
  if (name.endsWith('.wings-studio.json')) return 'project';
  if (/^video\/(mp4|webm|quicktime)$/.test(mimeType)) return 'video';
  if (/^image\/(png|jpeg|webp|gif|avif|svg\+xml)$/.test(mimeType)) return 'image';
  if (/^audio\/(mpeg|mp4|aac|wav|x-wav|ogg|webm)$/.test(mimeType)) return 'audio';
  if (/\.(srt|vtt)$/i.test(name)) return 'subtitle';
  return null;
}

/** Video and audio make a timeline; images, text and shapes alone make a still. */
export function hasPlayableMedia(doc: EditDoc): boolean {
  for (const track of doc.timeline?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      const type = clip.asset?.type;
      if (type === 'video' || type === 'audio') return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Making clips
// ---------------------------------------------------------------------------

/**
 * A video or audio clip is born with the file's real length, read in the
 * browser before the clip exists (`probeMediaDuration`). Only when that read
 * failed does the core's `auto` stand in, and the person is told.
 */
export function clipFor(
  kind: StudioFileKind,
  src: string,
  start: number,
  options: { durationSeconds?: number | null; output?: { width: number; height: number } } = {},
): Clip {
  const measured =
    typeof options.durationSeconds === 'number' && Number.isFinite(options.durationSeconds) && options.durationSeconds > 0
      ? Math.round(options.durationSeconds * 100) / 100
      : null;
  switch (kind) {
    case 'video':
      return { asset: { type: 'video', src, volume: 1 }, start, length: measured ?? 'auto' } as Clip;
    case 'audio':
      return { asset: { type: 'audio', src, volume: 1 }, start, length: measured ?? 'auto' } as Clip;
    case 'image':
      return { asset: { type: 'image', src }, start, length: 5, fit: 'contain' } as Clip;
    case 'subtitle':
      // An SRT from the Drive gets the same look as one Whisper wrote.
      return captionClip(src, options.output ?? { width: 1920, height: 1080 });
    case 'project':
      throw new Error('a project is opened, not added');
  }
}

const TEXT_PRESETS: Record<TextPreset, { text: string; size: number; weight: number }> = {
  title: { text: 'Título', size: 72, weight: 600 },
  subtitle: { text: 'Subtítulo', size: 48, weight: 500 },
  body: { text: 'Escreva aqui', size: 32, weight: 400 },
};

export function textClip(preset: TextPreset, start: number, length: number): Clip {
  const style = TEXT_PRESETS[preset];
  return {
    asset: {
      type: 'rich-text',
      text: style.text,
      font: {
        family: TEXT_FONT,
        size: style.size,
        weight: style.weight,
        color: '#ffffff',
        opacity: 1,
      },
      align: { horizontal: 'center', vertical: 'middle' },
    },
    start,
    length,
    width: 800,
    height: 240,
  } as Clip;
}

/** A logo keeps its ratio and sits top-right, a quarter of the frame wide. */
export function logoClip(src: string, start: number, length: number): Clip {
  return {
    asset: { type: 'image', src },
    start,
    length,
    fit: 'contain',
    position: 'topRight',
    scale: 0.25,
    offset: { x: -0.04, y: -0.04 },
  } as Clip;
}

/** How far a caption band sits from the frame's edge, as a share of the height. */
const CAPTION_EDGE_OFFSET = 0.06;
const CAPTION_LINE_HEIGHT = 1.3;
const CAPTION_LINES = 2;

/**
 * The default look of a caption: letters about 5% of the frame's height,
 * centred in the lower third, a translucent band behind them, and a box
 * two lines tall so a long segment wraps once and no more. Everything here
 * is what `CaptionStyle` later edits.
 */
export function captionStyleFor(output: { width: number; height: number }): CaptionStyle {
  return {
    size: Math.max(16, Math.round(output.height * 0.05)),
    color: '#ffffff',
    placement: 'bottom',
    backgroundColor: '#000000',
    backgroundOpacity: 0.55,
  };
}

const CAPTION_PLACEMENT_POSITION: Record<CaptionStyle['placement'], StudioPosition> = {
  bottom: 'bottom',
  middle: 'center',
  top: 'top',
};

/** The clip-level fields (box and place) a caption style implies. */
function captionBox(style: CaptionStyle, output: { width: number; height: number }) {
  const padding = Math.round(style.size * 0.35);
  return {
    width: Math.round(output.width * 0.9),
    height: Math.round(style.size * CAPTION_LINE_HEIGHT * CAPTION_LINES + padding * 2),
    position: CAPTION_PLACEMENT_POSITION[style.placement],
    // In the core, a positive y offset moves the clip up.
    offset: {
      x: 0,
      y: style.placement === 'bottom' ? CAPTION_EDGE_OFFSET : style.placement === 'top' ? -CAPTION_EDGE_OFFSET : 0,
    },
    padding,
  };
}

export function captionClip(src: string, output: { width: number; height: number }): Clip {
  const style = captionStyleFor(output);
  const box = captionBox(style, output);
  return {
    asset: {
      type: 'rich-caption',
      src,
      font: { family: TEXT_FONT, size: style.size, weight: 600, color: style.color, opacity: 1 },
      style: { lineHeight: CAPTION_LINE_HEIGHT },
      background: {
        color: style.backgroundColor,
        opacity: style.backgroundOpacity,
        borderRadius: Math.round(style.size * 0.2),
        padding: box.padding,
        wrap: true,
      },
      align: { horizontal: 'center', vertical: 'middle' },
    },
    start: 0,
    length: 'end',
    width: box.width,
    height: box.height,
    position: box.position,
    offset: box.offset,
  } as Clip;
}

/** The caption style a document clip carries, for the properties panel. */
export function captionStyleOf(clip: DocClip): CaptionStyle {
  const asset = clip.asset ?? {};
  const font = (asset.font ?? {}) as Record<string, unknown>;
  const background = (asset.background ?? {}) as Record<string, unknown>;
  const position = clip.position;
  return {
    size: numberOr(font.size, 32),
    color: typeof font.color === 'string' ? font.color : '#ffffff',
    placement: position === 'top' ? 'top' : position === 'center' ? 'middle' : 'bottom',
    backgroundColor: typeof background.color === 'string' ? background.color : '#000000',
    backgroundOpacity: numberOr(background.opacity, 0),
  };
}

/** Inline SVG markup for a shape. No address in it: the project rule holds for shapes too. */
export function shapeSvg(kind: ShapeKind, color = WINGS_ORANGE): string {
  const fill = /^#[0-9a-fA-F]{6}$/.test(color) ? color : WINGS_ORANGE;
  const body =
    kind === 'rect'
      ? `<rect x="0" y="0" width="400" height="400" fill="${fill}"/>`
      : kind === 'circle'
        ? `<circle cx="200" cy="200" r="200" fill="${fill}"/>`
        : `<rect x="0" y="190" width="400" height="20" fill="${fill}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">${body}</svg>`;
}

/** The fill of the first shape in an SVG, or null. */
export function fillOf(markup: unknown): string | null {
  if (typeof markup !== 'string') return null;
  const match =
    /<(?:rect|circle|path|ellipse|polygon)[^>]*\sfill="(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)"/.exec(markup);
  return match?.[1] ?? null;
}

export function withFill(markup: string, color: string): string {
  const fill = /^#[0-9a-fA-F]{6}$/.test(color) ? color : WINGS_ORANGE;
  return markup.replace(
    /(<(?:rect|circle|path|ellipse|polygon)[^>]*\sfill=")([^"]*)(")/g,
    `$1${fill}$3`,
  );
}

/** Decodes what `Canvas.captureFrame` returns into bytes for the Drive. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const type = /^data:([^;]+)/.exec(header)?.[1] ?? 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

// ---------------------------------------------------------------------------
// Reading clips back
// ---------------------------------------------------------------------------

const isPosition = (value: unknown): value is StudioPosition =>
  (STUDIO_POSITIONS as readonly unknown[]).includes(value);
const isTransition = (value: unknown): value is StudioTransition =>
  (STUDIO_TRANSITIONS as readonly unknown[]).includes(value);
const numberOr = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const TEXT_TYPES = new Set(['rich-text', 'text', 'title']);
const CAPTION_TYPES = new Set(['rich-caption', 'caption']);

export function selectedFrom(
  clip: ResolvedClip,
  where: { clipId: string; trackIndex: number; clipIndex: number },
  assetName: string | null,
): SelectedClip {
  const raw = clip as unknown as DocClip;
  const asset = raw.asset ?? {};
  const type = typeof asset.type === 'string' ? asset.type : 'unknown';
  const offset = (raw.offset ?? {}) as { x?: unknown; y?: unknown };
  const transition = (raw.transition ?? {}) as { in?: unknown; out?: unknown };
  const font = (asset.font ?? {}) as Record<string, unknown>;
  const align = (asset.align ?? asset.alignment ?? {}) as Record<string, unknown>;
  const vertical = align.vertical === 'center' ? 'middle' : align.vertical;
  return {
    clipId: where.clipId,
    trackIndex: where.trackIndex,
    clipIndex: where.clipIndex,
    assetType: type,
    assetName,
    start: numberOr(raw.start, 0),
    length: numberOr(raw.length, 0),
    opacity: numberOr(raw.opacity, 1),
    position: isPosition(raw.position) ? raw.position : 'center',
    offset: { x: numberOr(offset.x, 0), y: numberOr(offset.y, 0) },
    scale: numberOr(raw.scale, 1),
    transition: {
      in: isTransition(transition.in) ? transition.in : 'none',
      out: isTransition(transition.out) ? transition.out : 'none',
    },
    volume: type === 'video' || type === 'audio' ? numberOr(asset.volume, 1) : null,
    text: TEXT_TYPES.has(type)
      ? {
          text: typeof asset.text === 'string' ? asset.text : '',
          fontFamily: typeof font.family === 'string' ? font.family : TEXT_FONT,
          size: numberOr(font.size, 32),
          weight: numberOr(Number(font.weight), 400),
          color: typeof font.color === 'string' ? font.color : '#ffffff',
          horizontal:
            align.horizontal === 'left' || align.horizontal === 'right'
              ? align.horizontal
              : 'center',
          vertical: vertical === 'top' || vertical === 'bottom' ? vertical : 'middle',
        }
      : null,
    fill: type === 'svg' ? fillOf(asset.src) : null,
    caption: CAPTION_TYPES.has(type) ? captionStyleOf(raw) : null,
  };
}

/** A `ClipPatch` as the core's `updateClipById` takes it. `current` is the document clip. */
export function updatesFor(
  patch: ClipPatch,
  current: DocClip,
  output?: { width: number; height: number },
): Partial<Clip> {
  const updates: Record<string, unknown> = {};
  if (patch.start !== undefined) updates.start = Math.max(0, patch.start);
  if (patch.length !== undefined) updates.length = Math.max(0.1, patch.length);
  if (patch.opacity !== undefined) updates.opacity = Math.min(1, Math.max(0, patch.opacity));
  if (patch.position !== undefined) updates.position = patch.position;
  if (patch.offset !== undefined) {
    updates.offset = {
      x: Math.min(1, Math.max(-1, patch.offset.x)),
      y: Math.min(1, Math.max(-1, patch.offset.y)),
    };
  }
  if (patch.scale !== undefined) updates.scale = Math.max(0.01, patch.scale);
  if (patch.transition !== undefined) {
    const existing = (current.transition ?? {}) as Record<string, unknown>;
    updates.transition = { ...existing, ...patch.transition };
  }

  const asset = { ...(current.asset ?? {}) } as Record<string, unknown> & { type?: string };
  let assetChanged = false;
  if (patch.volume !== undefined && (asset.type === 'video' || asset.type === 'audio')) {
    asset.volume = Math.min(1, Math.max(0, patch.volume));
    assetChanged = true;
  }
  if (patch.text !== undefined && asset.type && TEXT_TYPES.has(asset.type)) {
    const font = { ...((asset.font ?? {}) as Record<string, unknown>) };
    const align = { ...((asset.align ?? {}) as Record<string, unknown>) };
    if (patch.text.text !== undefined) asset.text = patch.text.text;
    if (patch.text.fontFamily !== undefined) font.family = patch.text.fontFamily;
    if (patch.text.size !== undefined)
      font.size = Math.min(500, Math.max(1, Math.round(patch.text.size)));
    if (patch.text.weight !== undefined) font.weight = patch.text.weight;
    if (patch.text.color !== undefined) font.color = patch.text.color;
    if (patch.text.horizontal !== undefined) align.horizontal = patch.text.horizontal;
    if (patch.text.vertical !== undefined) align.vertical = patch.text.vertical;
    asset.font = font;
    asset.align = align;
    assetChanged = true;
  }
  if (patch.fill !== undefined && asset.type === 'svg' && typeof asset.src === 'string') {
    asset.src = withFill(asset.src, patch.fill);
    assetChanged = true;
  }
  if (patch.caption !== undefined && asset.type && CAPTION_TYPES.has(asset.type)) {
    const style: CaptionStyle = { ...captionStyleOf(current), ...patch.caption };
    style.size = Math.min(400, Math.max(8, Math.round(style.size)));
    style.backgroundOpacity = Math.min(1, Math.max(0, style.backgroundOpacity));
    const box = captionBox(style, output ?? { width: 1920, height: 1080 });
    const font = { ...((asset.font ?? {}) as Record<string, unknown>), size: style.size, color: style.color };
    const background = {
      ...((asset.background ?? {}) as Record<string, unknown>),
      color: style.backgroundColor,
      opacity: style.backgroundOpacity,
      padding: box.padding,
      borderRadius: Math.round(style.size * 0.2),
      wrap: true,
    };
    asset.font = font;
    asset.background = background;
    asset.style = { ...((asset.style ?? {}) as Record<string, unknown>), lineHeight: CAPTION_LINE_HEIGHT };
    updates.width = box.width;
    updates.height = box.height;
    updates.position = box.position;
    updates.offset = box.offset;
    assetChanged = true;
  }
  if (assetChanged) updates.asset = asset;
  return updates as Partial<Clip>;
}

const TYPE_LABEL: Record<string, string> = {
  video: 'Vídeo',
  audio: 'Áudio',
  image: 'Imagem',
  'rich-text': 'Texto',
  text: 'Texto',
  title: 'Texto',
  svg: 'Forma',
  caption: 'Legenda',
  'rich-caption': 'Legenda',
};

export const clipTypeLabel = (type: string): string => TYPE_LABEL[type] ?? type;

/** The layers panel's rows: track 0 is on top of the canvas, so it comes first. */
export function layersOf(
  doc: EditDoc,
  clipIdOf: (trackIndex: number, clipIndex: number) => string | null,
  nameOfSrc: (src: unknown) => string | null,
  selectedId: string | null,
): StudioLayer[] {
  const layers: StudioLayer[] = [];
  (doc.timeline?.tracks ?? []).forEach((track, trackIndex) => {
    (track.clips ?? []).forEach((clip, clipIndex) => {
      const clipId = clip.id ?? clipIdOf(trackIndex, clipIndex);
      if (!clipId) return;
      const type = clip.asset?.type ?? 'unknown';
      const name =
        TEXT_TYPES.has(type) && typeof clip.asset?.text === 'string'
          ? clip.asset.text.slice(0, 40)
          : (nameOfSrc(clip.asset?.src) ?? clipTypeLabel(type));
      layers.push({
        clipId,
        trackIndex,
        clipIndex,
        assetType: type,
        label: name,
        selected: clipId === selectedId,
      });
    });
  });
  return layers;
}
