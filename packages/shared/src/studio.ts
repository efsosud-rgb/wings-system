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
} as const;
export type StudioAspect = keyof typeof STUDIO_ASPECTS;
export const STUDIO_ASPECT_KEYS = Object.keys(STUDIO_ASPECTS) as StudioAspect[];

/** What the screen saves in the Drive and opens again. */
export const studioProjectFileSchema = z.object({
  kind: z.literal('wings-studio-project'),
  version: z.literal(1),
  name: z.string().trim().min(1).max(120),
  aspect: z.enum(STUDIO_ASPECT_KEYS),
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
