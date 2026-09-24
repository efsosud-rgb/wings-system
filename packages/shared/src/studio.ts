import { z } from 'zod';
import { driveNameSchema } from './drive.js';

/**
 * Wings Studio: the manual video editor inside Marketing → Edição de Fotos e
 * Vídeos. The editor core is `packages/studio`; this is what the screen and
 * the API agree on around it.
 *
 * A project never holds an address. Every clip points at a Drive file by id
 * (`wings-drive://<id>`); the screen swaps those for short pre-signed links
 * while editing and swaps them back before saving or rendering. So a saved
 * project can be reopened next month, and nothing in it says where a file is
 * kept.
 */

export const WINGS_DRIVE_SCHEME = 'wings-drive://';
export const wingsDriveRef = (fileId: string) => `${WINGS_DRIVE_SCHEME}${fileId}`;
/** The file id inside a `wings-drive://` reference, or null for anything else. */
export function parseWingsDriveRef(src: unknown): string | null {
  if (typeof src !== 'string' || !src.startsWith(WINGS_DRIVE_SCHEME)) return null;
  const id = src.slice(WINGS_DRIVE_SCHEME.length);
  return z.uuid().safeParse(id).success ? id : null;
}

/** A project file in the Drive ends with this, whatever the person named it. */
export const STUDIO_PROJECT_SUFFIX = '.wings-studio.json';
export const STUDIO_PROJECT_MIME = 'application/json';

/** How long a link opened for editing lasts: a video element keeps asking for ranges through it. */
export const STUDIO_LINK_TTL_SECONDS = 60 * 60;
/** Above this much timeline, the browser export is not offered first: the server renders. */
export const STUDIO_BROWSER_EXPORT_MAX_SECONDS = 600;
/** What the server encodes at, in bits per second; the browser uses the core's default (5 Mbps). */
export const STUDIO_SERVER_VIDEO_BITRATE = 8_000_000;
export const STUDIO_AUDIO_BITRATE = 192_000;

export const STUDIO_ASPECTS = {
  '16:9': { width: 1920, height: 1080, label: 'Horizontal (16:9)' },
  '9:16': { width: 1080, height: 1920, label: 'Vertical (9:16)' },
  '1:1': { width: 1080, height: 1080, label: 'Quadrado (1:1)' },
  '4:5': { width: 1080, height: 1350, label: 'Retrato (4:5)' },
} as const;
export type StudioAspect = keyof typeof STUDIO_ASPECTS;
export const STUDIO_ASPECT_KEYS = Object.keys(STUDIO_ASPECTS) as StudioAspect[];

/** What the screen saves in the Drive and opens again. */
export const studioProjectFileSchema = z.object({
  kind: z.literal('wings-studio-project'),
  version: z.literal(1),
  name: z.string().trim().min(1).max(120),
  aspect: z.enum(STUDIO_ASPECT_KEYS),
  /**
   * "Para quem": the client the piece is for. Filing only: it picks the
   * default Drive folder, the client's logo in Elementos and the client of a
   * generation. Absent on projects saved before part 2.
   */
  clientId: z.uuid().nullable().default(null),
  /** The editor core's own document (its `Edit` JSON), with `wings-drive://` sources. */
  edit: z.record(z.string(), z.unknown()),
  /** The files the project cites, so the screen can list them before any link is asked for. */
  assets: z.record(z.uuid(), z.object({ name: z.string(), mimeType: z.string() })),
});
export type StudioProjectFile = z.output<typeof studioProjectFileSchema>;

export const studioRenderRequestSchema = z.object({
  /** The editor core's document, with `wings-drive://` sources only. */
  project: z.record(z.string(), z.unknown()),
  destination: z.object({
    folderId: z.uuid(),
    name: driveNameSchema,
    /** Set to put the render on top of an existing file as a new version. */
    replaceFileId: z.uuid().optional(),
  }),
  fps: z.number().int().min(24).max(60).default(30),
  videoBitrate: z
    .number()
    .int()
    .min(1_000_000)
    .max(50_000_000)
    .default(STUDIO_SERVER_VIDEO_BITRATE),
});
export type StudioRenderRequest = z.output<typeof studioRenderRequestSchema>;

export const STUDIO_RENDER_STATES = ['pending', 'running', 'done', 'failed'] as const;
export type StudioRenderState = (typeof STUDIO_RENDER_STATES)[number];

/** One server render, as the screen sees it. Nothing here names a key or a path. */
export interface StudioRender {
  id: string;
  state: StudioRenderState;
  /** `<code>: <phrase>` from docs/studio/jobs.md, when failed. */
  error: string | null;
  /** What the worker could not render faithfully, in its own words. */
  unsupported: string[];
  /** The Drive file the render became, once filed. */
  file: { id: string; version: number } | null;
  destination: { folderId: string; name: string; replaceFileId: string | null };
  createdAt: string;
  finishedAt: string | null;
}

export const STUDIO_RENDER_STATE_LABEL: Record<StudioRenderState, string> = {
  pending: 'Na fila',
  running: 'Renderizando',
  done: 'Pronto',
  failed: 'Falhou',
};

/** The error codes the worker may put in front of the colon (docs/studio/jobs.md). */
export const STUDIO_RENDER_ERRORS = [
  'invalid_project',
  'asset_missing',
  'asset_undecodable',
  'too_long',
  'render_failed',
  'timeout',
  'output_missing',
] as const;

// ---------------------------------------------------------------------------
// Captions by Whisper (part 2)
// ---------------------------------------------------------------------------
//
//   POST /studio/transcriptions          { fileId, language? } -> 202 { transcription }   (marketing.media.edit)
//   GET  /studio/transcriptions/:id      -> { transcription }
//
// The API puts a `transcribe` job on the worker's queue for a Drive video or
// audio file (read access is enough to cite it; write access to its folder
// is needed, because the SRT is filed next to it). The first GET that sees the
// job done turns the worker's segments into an SRT, files it in the Drive as
// `<name>.srt` (a new version when one already exists) and audits
// `studio.captions_saved`. The screen then adds a caption clip citing that
// file by id. One job is one attempt; asking again is a person's click.
//
// Smart captions (part 3b): with `smart`, on a video, the same GET that files
// the SRT queues a `caption_layout` job. The worker looks at a few frames of
// each cue (faces with YuNet, written text with the PP-OCRv3 detector, both
// run by OpenCV on our CPU, R$ 0) and answers one zone per cue: bottom, top
// or middle, whichever is free, never changing place for less than
// CAPTION_MIN_RUN_SECONDS. Only the zones are kept: no box, no face, no
// frame leaves the job. The next GET files one SRT per zone used (up to
// three) and the screen adds one caption clip per file, each in its place.

export const studioTranscriptionRequestSchema = z.object({
  fileId: z.uuid(),
  /** Place each cue away from faces and on-screen text (video only; ignored on audio). */
  smart: z.boolean().default(false),
  /** ISO 639-1; auto-detected when omitted. */
  language: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[A-Za-z]{2})?$/)
    .optional(),
});
export type StudioTranscriptionRequest = z.output<typeof studioTranscriptionRequestSchema>;

export type StudioTranscriptionState = StudioRenderState;

/** Where a smart caption cue sits, in the order it is preferred when free. */
export const CAPTION_ZONES = ['bottom', 'top', 'middle'] as const;
export type CaptionZone = (typeof CAPTION_ZONES)[number];

export const CAPTION_ZONE_LABEL: Record<CaptionZone, string> = {
  bottom: 'embaixo',
  top: 'em cima',
  middle: 'no meio',
};

/** A caption never changes place for a stretch shorter than this. */
export const CAPTION_MIN_RUN_SECONDS = 2;

/** The SRT of one zone: `vídeo.srt` -> `vídeo.legenda-em-cima.srt`. */
export const zoneSrtName = (srtName: string, zone: CaptionZone) =>
  `${srtName.replace(/\.srt$/i, '')}.legenda-${CAPTION_ZONE_LABEL[zone].replace(/ /g, '-')}.srt`;

/**
 * The transcript's segments split by the zone chosen for each (by index), in
 * CAPTION_ZONES order, zones with no cue left out. Empty segments are dropped
 * the same way `segmentsToSrt` drops them.
 */
export function segmentsByZone<T extends { start: number; end: number; text: string }>(
  segments: readonly T[],
  zones: readonly CaptionZone[],
): { zone: CaptionZone; segments: T[] }[] {
  return CAPTION_ZONES.map((zone) => ({
    zone,
    segments: segments.filter(
      (segment, index) => (zones[index] ?? 'bottom') === zone && segment.text.trim() !== '',
    ),
  })).filter((group) => group.segments.length > 0);
}

/** The smart placement of one transcription, when it was asked for. */
export interface StudioCaptionLayout {
  state: StudioRenderState;
  /** `<code>: <phrase>`, when failed. The plain SRT is still there to use. */
  error: string | null;
  /** One SRT per zone used, once filed. */
  files: { id: string; version: number; name: string; zone: CaptionZone; cues: number }[];
}

export interface StudioTranscription {
  id: string;
  state: StudioTranscriptionState;
  /** `<code>: <phrase>`, when failed. */
  error: string | null;
  sourceFileId: string;
  /** The SRT in the Drive, once filed. */
  file: { id: string; version: number; name: string; folderId: string } | null;
  /** What Whisper detected, once done. */
  language: string | null;
  segments: number | null;
  /** Null when smart captions were not asked for (or the file is audio). */
  layout: StudioCaptionLayout | null;
  createdAt: string;
  finishedAt: string | null;
}

export const STUDIO_TRANSCRIPTION_STATE_LABEL: Record<StudioTranscriptionState, string> = {
  pending: 'Na fila',
  running: 'Transcrevendo',
  done: 'Legenda pronta',
  failed: 'Falhou',
};

export const STUDIO_CAPTION_LAYOUT_STATE_LABEL: Record<StudioRenderState, string> = {
  pending: 'Na fila para posicionar',
  running: 'Procurando rostos e textos no vídeo',
  done: 'Posições prontas',
  failed: 'Não deu para posicionar',
};

/** Whisper's segments as an SRT document. Timestamps are `HH:MM:SS,mmm`. */
export function segmentsToSrt(
  segments: readonly { start: number; end: number; text: string }[],
): string {
  const stamp = (seconds: number) => {
    const total = Math.max(0, seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const whole = Math.floor(total % 60);
    const millis = Math.round((total - Math.floor(total)) * 1000);
    const pad = (value: number, size = 2) => String(value).padStart(size, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(whole)},${pad(millis, 3)}`;
  };
  return segments
    .filter((segment) => segment.text.trim() !== '')
    .map(
      (segment, index) =>
        `${index + 1}\n${stamp(segment.start)} --> ${stamp(Math.max(segment.end, segment.start + 0.5))}\n${segment.text.trim()}\n`,
    )
    .join('\n');
}

/** How a text clip sits on the canvas. The properties panel edits these; the core stores them. */
export const STUDIO_POSITIONS = [
  'topLeft',
  'top',
  'topRight',
  'left',
  'center',
  'right',
  'bottomLeft',
  'bottom',
  'bottomRight',
] as const;
export type StudioPosition = (typeof STUDIO_POSITIONS)[number];

export const STUDIO_TRANSITIONS = ['none', 'fade', 'fadeSlow', 'fadeFast'] as const;
export type StudioTransition = (typeof STUDIO_TRANSITIONS)[number];

/** Keyboard shortcuts the workspace adds on top of the core's (space, arrows, Ctrl+Z, Delete). */
export const STUDIO_SHORTCUTS = [
  { keys: 'Espaço', does: 'Tocar ou pausar' },
  { keys: 'Ctrl+Z / Ctrl+Shift+Z', does: 'Desfazer / refazer' },
  { keys: 'Delete', does: 'Remover o item selecionado' },
  { keys: 'S', does: 'Salvar no Drive' },
  { keys: '← →', does: 'Um quadro para trás ou para a frente' },
] as const;
