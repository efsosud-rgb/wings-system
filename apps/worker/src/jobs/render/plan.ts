import { parseWingsDriveRef } from '@wings/shared';
import { RenderError, type RenderJobInput } from './contract.js';
import { DEFAULT_FONT_FAMILY, resolveFont } from './fonts.js';

/** The nine predefined viewport positions the doc lists. */
export type Position =
  | 'top'
  | 'topRight'
  | 'right'
  | 'bottomRight'
  | 'bottom'
  | 'bottomLeft'
  | 'left'
  | 'topLeft'
  | 'center';
const POSITIONS: readonly Position[] = [
  'top',
  'topRight',
  'right',
  'bottomRight',
  'bottom',
  'bottomLeft',
  'left',
  'topLeft',
  'center',
];

export type FitMode = 'crop' | 'cover' | 'contain';
/** `fade`=1s, `fadeSlow`=2s, `fadeFast`=0.5s: not specified by the doc, chosen
 * here and used consistently by the ffmpeg command builder. */
export type TransitionName = 'none' | 'fade' | 'fadeSlow' | 'fadeFast';
export const TRANSITION_SECONDS: Record<Exclude<TransitionName, 'none'>, number> = {
  fade: 1,
  fadeSlow: 2,
  fadeFast: 0.5,
};

interface ClipBase {
  where: string;
  start: number;
  length: number;
}

export interface MediaVisualClip extends ClipBase {
  kind: 'video' | 'image';
  assetId: string;
  trim: number;
  fit: FitMode;
  scale: number;
  position: Position;
  offsetX: number;
  offsetY: number;
  opacity: number;
  transitionIn: TransitionName;
  transitionOut: TransitionName;
}

export interface TextVisualClip extends ClipBase {
  kind: 'text';
  text: string;
  fontFamily: string;
  fontSizePx: number;
  color: string;
  align: 'left' | 'center' | 'right';
  position: Position;
  offsetX: number;
  offsetY: number;
  opacity: number;
}

export interface CaptionVisualClip extends ClipBase {
  kind: 'caption';
  assetId: string;
  fontFamily: string;
  fontSizePx: number;
  color: string;
  backgroundColor: string | null;
}

export type VisualClip = MediaVisualClip | TextVisualClip | CaptionVisualClip;

export interface AudioClip extends ClipBase {
  assetId: string;
  trim: number;
  volume: number;
}

export interface RenderPlan {
  width: number;
  height: number;
  fps: number;
  background: string;
  totalDurationSeconds: number;
  /** Bottom to top: index 0 draws first. */
  visual: VisualClip[];
  audio: AudioClip[];
  unsupported: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** A number, or `fallback` plus an `unsupported` note when it is a tween
 * array (animated) or otherwise not a plain number — this render engine only
 * ever produces a single, fixed value per clip. */
function fixedNumber(
  value: unknown,
  fallback: number,
  where: string,
  field: string,
  unsupported: string[],
): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0] as { to?: unknown; from?: unknown } | undefined;
    const resolved = first && typeof first.to === 'number' ? first.to : first?.from;
    unsupported.push(`${where}: animação de "${field}" virou um valor fixo`);
    return typeof resolved === 'number' ? resolved : fallback;
  }
  if (value !== undefined) unsupported.push(`${where}: "${field}" com um valor inesperado, ignorado`);
  return fallback;
}

function fitOf(value: unknown, where: string, unsupported: string[]): FitMode {
  if (value === 'crop' || value === 'cover' || value === 'contain') return value;
  if (value !== undefined) unsupported.push(`${where}: modo de encaixe "${String(value)}" não suportado, usando "crop"`);
  return 'crop';
}

function positionOf(value: unknown, where: string, unsupported: string[]): Position {
  if (typeof value === 'string' && (POSITIONS as string[]).includes(value)) return value as Position;
  if (value !== undefined) unsupported.push(`${where}: posição "${String(value)}" não suportada, usando "center"`);
  return 'center';
}

function transitionOf(value: unknown, where: string, edge: 'entrada' | 'saída', unsupported: string[]): TransitionName {
  if (value === undefined || value === 'none') return 'none';
  if (value === 'fade' || value === 'fadeSlow' || value === 'fadeFast') return value;
  unsupported.push(`${where}: transição de ${edge} "${String(value)}" virou corte seco`);
  return 'none';
}

function offsetOf(value: unknown, axis: 'x' | 'y', where: string, unsupported: string[]): number {
  if (!isRecord(value)) return 0;
  return fixedNumber(value[axis], 0, where, `offset.${axis}`, unsupported);
}

/** Every `asset.src` in the project must be `wings-drive://<id in assets>`,
 * or the job is structurally invalid — this is checked before anything is
 * downloaded (docs/studio/jobs.md, rule 1). */
function assetIdOf(src: unknown, where: string, assets: RenderJobInput['assets']): string {
  const id = parseWingsDriveRef(src);
  if (!id) throw new RenderError('invalid_project', `${where}: a fonte não é um arquivo do Drive (wings-drive://)`);
  if (!(id in assets)) throw new RenderError('invalid_project', `${where}: arquivo citado no projeto sem entrada em "assets"`);
  return id;
}

function textAlignOf(value: unknown): 'left' | 'center' | 'right' {
  return value === 'left' || value === 'right' ? value : 'center';
}

/** Builds a normalized render plan from `input.project`, resolving what the
 * worker covers (docs/studio/jobs.md, table) to concrete values and pushing
 * everything else into `unsupported`. Throws `RenderError('invalid_project')`
 * for anything that would make the job meaningless, never for something
 * merely decorative. */
export function buildRenderPlan(input: RenderJobInput): RenderPlan {
  const project = input.project;
  if (!isRecord(project) || !isRecord(project.timeline)) {
    throw new RenderError('invalid_project', 'o projeto não tem linha do tempo');
  }
  const tracks = project.timeline.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new RenderError('invalid_project', 'a linha do tempo não tem faixas');
  }
  const backgroundRaw = project.timeline.background;
  const background =
    typeof backgroundRaw === 'string' && HEX_COLOR.test(backgroundRaw) ? backgroundRaw : '#000000';

  const unsupported: string[] = [];
  const visual: VisualClip[] = [];
  const audio: AudioClip[] = [];
  let totalDurationSeconds = 0;

  // Bottom to top: the LAST track in the array is the bottom-most, drawn first.
  for (let t = tracks.length - 1; t >= 0; t--) {
    const track = tracks[t];
    const clips = isRecord(track) ? track.clips : undefined;
    if (!Array.isArray(clips)) continue;

    clips.forEach((clip, c) => {
      const where = `faixa ${t + 1}, clipe ${c + 1}`;
      if (!isRecord(clip) || !isRecord(clip.asset)) {
        unsupported.push(`${where}: clipe sem asset, ignorado`);
        return;
      }
      const asset = clip.asset;
      const start = fixedNumber(clip.start, 0, where, 'start', unsupported);
      const length = fixedNumber(clip.length, 0, where, 'length', unsupported);
      if (length <= 0) {
        unsupported.push(`${where}: duração inválida, ignorado`);
        return;
      }
      totalDurationSeconds = Math.max(totalDurationSeconds, start + length);
      const base: ClipBase = { where, start, length };

      switch (asset.type) {
        case 'video':
        case 'image': {
          const assetId = assetIdOf(asset.src, where, input.assets);
          visual.push({
            ...base,
            kind: asset.type,
            assetId,
            trim: asset.type === 'video' ? fixedNumber(asset.trim, 0, where, 'trim', unsupported) : 0,
            fit: fitOf(clip.fit, where, unsupported),
            scale: fixedNumber(clip.scale, 1, where, 'scale', unsupported),
            position: positionOf(clip.position, where, unsupported),
            offsetX: offsetOf(clip.offset, 'x', where, unsupported),
            offsetY: offsetOf(clip.offset, 'y', where, unsupported),
            opacity: fixedNumber(clip.opacity, 1, where, 'opacity', unsupported),
            transitionIn: transitionOf(isRecord(clip.transition) ? clip.transition.in : undefined, where, 'entrada', unsupported),
            transitionOut: transitionOf(isRecord(clip.transition) ? clip.transition.out : undefined, where, 'saída', unsupported),
          });
          if (asset.type === 'video') {
            const volume = fixedNumber(asset.volume, 1, where, 'volume', unsupported);
            if (volume > 0) {
              audio.push({
                ...base,
                assetId,
                trim: fixedNumber(asset.trim, 0, where, 'trim', unsupported),
                volume,
              });
            }
          }
          return;
        }
        case 'audio': {
          const assetId = assetIdOf(asset.src, where, input.assets);
          const volume = fixedNumber(asset.volume, 1, where, 'volume', unsupported);
          audio.push({
            ...base,
            assetId,
            trim: fixedNumber(asset.trim, 0, where, 'trim', unsupported),
            volume,
          });
          return;
        }
        case 'text':
        case 'rich-text': {
          const text = typeof asset.text === 'string' ? asset.text : '';
          if (!text) {
            unsupported.push(`${where}: texto vazio, ignorado`);
            return;
          }
          const font = isRecord(asset.font) ? asset.font : {};
          const resolvedFont = resolveFont(typeof font.family === 'string' ? font.family : undefined);
          if (resolvedFont.fellBack) {
            unsupported.push(`${where}: fonte não instalada, usando ${DEFAULT_FONT_FAMILY}`);
          }
          const color =
            typeof font.color === 'string' && HEX_COLOR.test(font.color) ? font.color : '#ffffff';
          visual.push({
            ...base,
            kind: 'text',
            text,
            fontFamily: resolvedFont.family,
            fontSizePx: typeof font.size === 'number' ? font.size : 32,
            color,
            align: textAlignOf(isRecord(asset.alignment) ? asset.alignment.horizontal : undefined),
            position: positionOf(clip.position, where, unsupported),
            offsetX: offsetOf(clip.offset, 'x', where, unsupported),
            offsetY: offsetOf(clip.offset, 'y', where, unsupported),
            opacity: fixedNumber(clip.opacity, 1, where, 'opacity', unsupported),
          });
          return;
        }
        case 'caption': {
          const assetId = assetIdOf(asset.src, where, input.assets);
          const font = isRecord(asset.font) ? asset.font : {};
          const bg = isRecord(asset.background) ? asset.background : {};
          const resolvedFont = resolveFont(typeof font.family === 'string' ? font.family : undefined);
          if (resolvedFont.fellBack) {
            unsupported.push(`${where}: fonte da legenda não instalada, usando ${DEFAULT_FONT_FAMILY}`);
          }
          visual.push({
            ...base,
            kind: 'caption',
            assetId,
            fontFamily: resolvedFont.family,
            fontSizePx: typeof font.size === 'number' ? font.size : 28,
            color: typeof font.color === 'string' && HEX_COLOR.test(font.color) ? font.color : '#ffffff',
            backgroundColor:
              typeof bg.color === 'string' && HEX_COLOR.test(bg.color) ? bg.color : null,
          });
          return;
        }
        default:
          unsupported.push(`${where}: tipo de elemento "${String(asset.type)}" não suportado, omitido`);
      }
    });
  }

  if (visual.length === 0 && audio.length === 0) {
    throw new RenderError('invalid_project', 'nada no projeto pôde ser renderizado');
  }

  const { width, height, fps } = input.output;
  return { width, height, fps, background, totalDurationSeconds, visual, audio, unsupported };
}
