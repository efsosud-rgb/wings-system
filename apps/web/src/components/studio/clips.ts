import {
  STUDIO_POSITIONS,
  STUDIO_TRANSITIONS,
  type StudioPosition,
  type StudioTransition,
} from '@wings/shared';
import type { Edit } from '@wings/studio';
import type {
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

export function clipFor(kind: StudioFileKind, src: string, start: number): Clip {
  switch (kind) {
    case 'video':
      return { asset: { type: 'video', src, volume: 1 }, start, length: 'auto' } as Clip;
    case 'audio':
      return { asset: { type: 'audio', src, volume: 1 }, start, length: 'auto' } as Clip;
    case 'image':
      return { asset: { type: 'image', src }, start, length: 5, fit: 'contain' } as Clip;
    case 'subtitle':
      return { asset: { type: 'rich-caption', src }, start, length: 'end' } as Clip;
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

export function captionClip(src: string): Clip {
  return { asset: { type: 'rich-caption', src }, start: 0, length: 'end' } as Clip;
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
  };
}

/** A `ClipPatch` as the core's `updateClipById` takes it. `current` is the document clip. */
export function updatesFor(patch: ClipPatch, current: DocClip): Partial<Clip> {
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
