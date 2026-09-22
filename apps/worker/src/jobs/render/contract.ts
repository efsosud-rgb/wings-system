/**
 * The `render` job's contract with the API: docs/studio/jobs.md. The API's
 * side of the same shapes lives in `apps/api/src/modules/studio/service.ts`
 * (`RenderInput`/`RenderOutput`) — duplicated here, not imported, because
 * `apps/worker` is a separate deployable.
 */

/** `<code>: <phrase>`, from docs/studio/jobs.md. Never a file name, a storage
 * key, a prompt or a client's name — `phrase` is checked for that at the call
 * sites that build one from ffmpeg's own words. */
export const RENDER_ERROR_CODES = [
  'invalid_project',
  'asset_missing',
  'asset_undecodable',
  'too_long',
  'render_failed',
  'timeout',
] as const;
export type RenderErrorCode = (typeof RENDER_ERROR_CODES)[number];

export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    phrase: string,
  ) {
    super(`${code}: ${phrase}`);
    this.name = 'RenderError';
  }
}

export interface RenderAsset {
  storageKey: string;
  mimeType: string;
  byteSize: number;
}

/** What the job's `input` column carries. `destination` is left untyped and
 * ignored: the worker never reads it (docs/studio/jobs.md, rule "o worker não
 * lê"). */
export interface RenderJobInput {
  version: 1;
  project: unknown;
  assets: Record<string, RenderAsset>;
  output: {
    storageKey: string;
    container: 'mp4';
    width: number;
    height: number;
    fps: number;
    videoBitrate: number;
    audioBitrate: number;
  };
}

export interface RenderJobOutput {
  storageKey: string;
  byteSize: number;
  checksum: string;
  mimeType: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  unsupported: string[];
  renderSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRenderAsset(value: unknown): value is RenderAsset {
  return (
    isRecord(value) &&
    typeof value.storageKey === 'string' &&
    value.storageKey.length > 0 &&
    typeof value.mimeType === 'string' &&
    typeof value.byteSize === 'number' &&
    Number.isFinite(value.byteSize) &&
    value.byteSize >= 0
  );
}

/** Structural validation only — the same spirit as the API's own
 * `projectFileIds` (apps/api/src/modules/studio/service.ts): permissive about
 * anything decorative (that becomes `unsupported` in the plan), strict about
 * what would make the job meaningless. */
export function parseRenderInput(input: unknown): RenderJobInput {
  if (!isRecord(input)) throw new RenderError('invalid_project', 'o job não tem um projeto');
  if (input.version !== 1) {
    throw new RenderError('invalid_project', `versão do job não suportada (${String(input.version)})`);
  }
  if (!isRecord(input.project)) {
    throw new RenderError('invalid_project', 'o projeto não é um objeto');
  }
  if (!isRecord(input.assets)) {
    throw new RenderError('invalid_project', 'a lista de arquivos do job está ausente');
  }
  const assets: Record<string, RenderAsset> = {};
  for (const [id, asset] of Object.entries(input.assets)) {
    if (!isRenderAsset(asset)) {
      throw new RenderError('invalid_project', `arquivo "${id}" do job não tem os campos esperados`);
    }
    assets[id] = asset;
  }
  const output = input.output;
  if (
    !isRecord(output) ||
    typeof output.storageKey !== 'string' ||
    !output.storageKey ||
    output.container !== 'mp4' ||
    typeof output.width !== 'number' ||
    typeof output.height !== 'number' ||
    typeof output.fps !== 'number' ||
    typeof output.videoBitrate !== 'number' ||
    typeof output.audioBitrate !== 'number'
  ) {
    throw new RenderError('invalid_project', 'a saída pedida pelo job não tem os campos esperados');
  }
  return {
    version: 1,
    project: input.project,
    assets,
    output: {
      storageKey: output.storageKey,
      container: 'mp4',
      width: output.width,
      height: output.height,
      fps: output.fps,
      videoBitrate: output.videoBitrate,
      audioBitrate: output.audioBitrate,
    },
  };
}
