import {
  STUDIO_AUDIO_BITRATE,
  parseWingsDriveRef,
  segmentsByZone,
  segmentsToSrt,
  zoneSrtName,
  type CaptionZone,
  type StudioCaptionLayout,
  type StudioRender,
  type StudioRenderRequest,
  type StudioRenderState,
  type StudioTranscription,
  type StudioTranscriptionRequest,
} from '@wings/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { driveFiles, driveUploads, jobs } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import type { DriveAccess } from '../drive/access.js';
import {
  DriveError,
  completeUpload,
  fileFor,
  folderFor,
  newStorageKey,
  type DriveDeps,
} from '../drive/service.js';

/**
 * Wings Studio on the server: hands the editor its links, turns a project into
 * a render job for the worker, and files the worker's result in the Drive.
 * The contract with the worker is docs/studio/jobs.md.
 */

export class StudioError extends Error {
  constructor(
    readonly code: 'invalid_project' | 'not_found' | 'storage_unavailable' | 'unsupported_file',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'StudioError';
  }
}

export interface StudioDeps {
  db: Database;
  drive: DriveDeps;
  now: () => Date;
}

/** What the job row carries, as docs/studio/jobs.md describes it. */
interface RenderInput {
  version: 1;
  project: Record<string, unknown>;
  assets: Record<string, { storageKey: string; mimeType: string; byteSize: number }>;
  output: {
    storageKey: string;
    container: 'mp4';
    width: number;
    height: number;
    fps: number;
    videoBitrate: number;
    audioBitrate: number;
  };
  destination: {
    folderId: string;
    name: string;
    replaceFileId: string | null;
    clientId: string | null;
    ownerId: string;
  };
}

interface RenderOutput {
  /** Set while one request is filing, so a second one waits. */
  filing?: true;
  storageKey?: string;
  byteSize?: number;
  mimeType?: string;
  unsupported?: string[];
  filed?: { driveFileId: string; version: number; at: string };
}

type JobRow = typeof jobs.$inferSelect;

// ---------------------------------------------------------------------------
// Reading a project
// ---------------------------------------------------------------------------

interface ClipRef {
  where: string;
  type: unknown;
  src: unknown;
}

/**
 * A shape is an SVG the core keeps inline (`asset.src` is the markup, no
 * scheme). It cites no file, so it is allowed as long as it fetches nothing:
 * no address, no script, no external reference. The worker draws none of it
 * and lists it as unsupported; the browser export does draw it.
 */
export function inlineSvgOk(src: unknown): boolean {
  if (typeof src !== 'string' || !src.trimStart().startsWith('<svg')) return false;
  // The namespace declaration is an identifier, not a fetch; everything else
  // that looks like an address is.
  const body = src.replace(/xmlns(?::[a-z]+)?\s*=\s*(["'])[^"']*\1/gi, '');
  return !/https?:|url\(|<script|xlink:href|href\s*=|<foreignObject|<image/i.test(body);
}

/** Every `asset.src` in the project, with where it sits, for the refusal message. */
function clipSources(project: Record<string, unknown>): ClipRef[] {
  const timeline = project['timeline'];
  const tracks =
    timeline && typeof timeline === 'object'
      ? (timeline as { tracks?: unknown }).tracks
      : undefined;
  if (!Array.isArray(tracks))
    throw new StudioError('invalid_project', 'O projeto não tem linha do tempo.');
  const refs: ClipRef[] = [];
  tracks.forEach((track, t) => {
    const clips =
      track && typeof track === 'object' ? (track as { clips?: unknown }).clips : undefined;
    if (!Array.isArray(clips)) return;
    clips.forEach((clip, c) => {
      const asset =
        clip && typeof clip === 'object' ? (clip as { asset?: unknown }).asset : undefined;
      if (!asset || typeof asset !== 'object' || !('src' in asset)) return;
      refs.push({
        where: `faixa ${t + 1}, clipe ${c + 1}`,
        type: (asset as { type?: unknown }).type,
        src: (asset as { src: unknown }).src,
      });
    });
  });
  return refs;
}

/** The Drive file ids a project cites. Anything that is an address instead is refused. */
export function projectFileIds(project: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const ref of clipSources(project)) {
    if (ref.type === 'svg') {
      if (!inlineSvgOk(ref.src)) {
        throw new StudioError(
          'invalid_project',
          `A forma em ${ref.where} aponta para um endereço ou traz código; só desenho inline é aceito.`,
        );
      }
      continue;
    }
    const id = parseWingsDriveRef(ref.src);
    if (!id) {
      throw new StudioError(
        'invalid_project',
        `O clipe em ${ref.where} aponta para um endereço, não para um arquivo do Drive.`,
      );
    }
    ids.add(id);
  }
  return [...ids];
}

function outputSize(project: Record<string, unknown>): { width: number; height: number } {
  const output = project['output'];
  const size =
    output && typeof output === 'object' ? (output as { size?: unknown }).size : undefined;
  const width = size && typeof size === 'object' ? (size as { width?: unknown }).width : undefined;
  const height =
    size && typeof size === 'object' ? (size as { height?: unknown }).height : undefined;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > 4096 ||
    height > 4096
  ) {
    throw new StudioError('invalid_project', 'O projeto não diz o tamanho do vídeo final.');
  }
  return { width, height };
}

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

export async function enqueueRender(
  deps: StudioDeps,
  access: DriveAccess,
  request: StudioRenderRequest,
): Promise<StudioRender> {
  if (!deps.drive.storage) {
    throw new StudioError('storage_unavailable', 'O armazenamento não está configurado.');
  }
  const ids = projectFileIds(request.project);
  const size = outputSize(request.project);
  const folder = await folderFor(deps.drive, access, request.destination.folderId, 'write');
  if (request.destination.replaceFileId) {
    const { file } = await fileFor(deps.drive, access, request.destination.replaceFileId, 'write');
    if (file.folderId !== folder.id || file.trashedAt) throw new DriveError('not_found');
  }

  const assets: RenderInput['assets'] = {};
  for (const id of ids) {
    // Read access is enough to cite a file; the department check is inside fileFor.
    const { file } = await fileFor(deps.drive, access, id);
    if (file.trashedAt) throw new DriveError('not_found');
    assets[id] = { storageKey: file.storageKey, mimeType: file.mimeType, byteSize: file.byteSize };
  }

  const now = deps.now();
  const input: RenderInput = {
    version: 1,
    project: request.project,
    assets,
    output: {
      storageKey: newStorageKey(now),
      container: 'mp4',
      width: size.width,
      height: size.height,
      fps: request.fps,
      videoBitrate: request.videoBitrate,
      audioBitrate: STUDIO_AUDIO_BITRATE,
    },
    destination: {
      folderId: folder.id,
      name: request.destination.name,
      replaceFileId: request.destination.replaceFileId ?? null,
      clientId: folder.clientId,
      ownerId: access.employeeId,
    },
  };
  const [row] = await deps.db.insert(jobs).values({ type: 'render', input }).returning();
  if (!row) throw new Error('render job was not inserted');
  return toRender(row);
}

// ---------------------------------------------------------------------------
// Reading and filing
// ---------------------------------------------------------------------------

const ownedBy = (employeeId: string) =>
  sql`${jobs.input} -> 'destination' ->> 'ownerId' = ${employeeId}`;

function toRender(row: JobRow): StudioRender {
  const input = row.input as RenderInput;
  const output = (row.output ?? {}) as RenderOutput;
  return {
    id: row.id,
    state: row.state as StudioRenderState,
    error: row.error,
    unsupported: Array.isArray(output.unsupported) ? output.unsupported.map(String) : [],
    file: output.filed ? { id: output.filed.driveFileId, version: output.filed.version } : null,
    destination: {
      folderId: input.destination.folderId,
      name: input.destination.name,
      replaceFileId: input.destination.replaceFileId,
    },
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** The person's own renders, newest first. An admin sees only their own here too. */
export async function listRenders(deps: StudioDeps, access: DriveAccess): Promise<StudioRender[]> {
  const rows = await deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, 'render'), ownedBy(access.employeeId)))
    .orderBy(desc(jobs.createdAt))
    .limit(20);
  return rows.map(toRender);
}

/**
 * One render. The first look at a finished job files its output in the Drive:
 * the object is checked with HEAD, a `drive_files` row (or a new version) is
 * made in the destination folder, and `output.filed` remembers it. The claim
 * is one conditional update, so two tabs polling at once file it once.
 */
export async function renderOf(
  deps: StudioDeps,
  access: DriveAccess,
  id: string,
): Promise<{ render: StudioRender; filedNow: boolean }> {
  const row = await deps.db.query.jobs.findFirst({
    where: and(eq(jobs.id, id), eq(jobs.type, 'render'), ownedBy(access.employeeId)),
  });
  if (!row) throw new StudioError('not_found', 'Render não encontrado.');
  const output = (row.output ?? {}) as RenderOutput;
  if (row.state !== 'done' || output.filed || output.filing) {
    return { render: toRender(row), filedNow: false };
  }

  // Claim the filing: only the update that finds no claim yet gets the row back.
  const [claimed] = await deps.db
    .update(jobs)
    .set({ output: sql`coalesce(${jobs.output}, '{}'::jsonb) || '{"filing": true}'::jsonb` })
    .where(
      and(
        eq(jobs.id, id),
        eq(jobs.state, 'done'),
        sql`coalesce(${jobs.output}, '{}'::jsonb) -> 'filed' is null`,
        sql`coalesce(${jobs.output}, '{}'::jsonb) -> 'filing' is null`,
      ),
    )
    .returning();
  if (!claimed) return { render: toRender(row), filedNow: false };
  const claimedOutput = (claimed.output ?? {}) as RenderOutput;
  const settle = (patch: Partial<typeof jobs.$inferInsert>) =>
    deps.db
      .update(jobs)
      .set({ ...patch, updatedAt: deps.now() })
      .where(eq(jobs.id, id))
      .returning();

  const input = claimed.input as RenderInput;
  const rest: RenderOutput = { ...claimedOutput };
  delete rest.filing;
  const key = rest.storageKey;
  const storage = deps.drive.storage;
  if (!storage)
    throw new StudioError('storage_unavailable', 'O armazenamento não está configurado.');
  const head =
    key !== undefined && key === input.output.storageKey ? await storage.head(key) : null;
  if (
    key === undefined ||
    !head ||
    typeof rest.byteSize !== 'number' ||
    head.size !== rest.byteSize
  ) {
    const [failed] = await settle({
      state: 'failed',
      error: 'output_missing: o arquivo renderizado não está no armazenamento',
      output: rest,
    });
    return { render: toRender(failed ?? claimed), filedNow: false };
  }

  try {
    const now = deps.now();
    const [upload] = await deps.db
      .insert(driveUploads)
      .values({
        folderId: input.destination.folderId,
        name: input.destination.name,
        mimeType: rest.mimeType ?? 'video/mp4',
        byteSize: head.size,
        storageKey: key,
        replaceFileId: input.destination.replaceFileId,
        requestedBy: access.employeeId,
        expiresAt: new Date(now.getTime() + 60_000),
      })
      .returning();
    if (!upload) throw new Error('render upload row was not inserted');
    const { file } = await completeUpload(deps.drive, access, upload.id);

    const filed = { driveFileId: file.id, version: file.version, at: now.toISOString() };
    const [done] = await settle({ output: { ...rest, filed } });
    await writeAudit(deps.db, {
      actorEmployeeId: access.employeeId,
      action: 'studio.render_saved',
      entity: 'drive_file',
      entityId: file.id,
      metadata: {
        jobId: id,
        version: file.version,
        replaced: input.destination.replaceFileId !== null,
      },
    });
    return { render: toRender(done ?? claimed), filedNow: true };
  } catch (error) {
    // Let the next look try again; the worker's output is untouched.
    await settle({ output: rest });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Captions: a transcribe job, and its SRT filed in the Drive
// ---------------------------------------------------------------------------

/** What the job row carries. The worker reads `storageKey` and `language` only. */
interface TranscribeInput {
  version: 1;
  storageKey: string;
  language?: string;
  /** Smart captions asked for, on a video: a caption_layout job follows the filing. */
  smart?: true;
  destination: {
    folderId: string;
    name: string;
    sourceFileId: string;
    clientId: string | null;
    ownerId: string;
  };
}

interface TranscribeOutput {
  filing?: true;
  outputStorageKey?: string;
  language?: string;
  segments?: number | unknown[];
  filed?: { driveFileId: string; version: number; name: string; at: string };
  /** The caption_layout job queued after the filing, when smart. */
  layoutJobId?: string;
}

/** What a caption_layout row carries. The worker reads the two keys only. */
interface LayoutInput {
  version: 1;
  storageKey: string;
  transcriptStorageKey: string;
  transcriptionId: string;
  destination: TranscribeInput['destination'];
}

/** The worker's zones, and what the API filed from them. */
interface LayoutOutput {
  zones?: CaptionZone[];
  frames?: number;
  filing?: true;
  filed?: { driveFileId: string; version: number; name: string; zone: CaptionZone; cues: number }[];
}

const SRT_MIME = 'application/x-subrip';

/** The worker's JSON, as much of it as the SRT needs. */
const transcriptSchema = z.object({
  language: z.string().optional(),
  segments: z.array(
    z.object({ start: z.number().min(0), end: z.number().min(0), text: z.string() }),
  ),
});

const srtNameOf = (name: string) => `${name.replace(/\.[^./]+$/, '') || name}.srt`;

export async function enqueueTranscription(
  deps: StudioDeps,
  access: DriveAccess,
  request: StudioTranscriptionRequest,
): Promise<StudioTranscription> {
  if (!deps.drive.storage) {
    throw new StudioError('storage_unavailable', 'O armazenamento não está configurado.');
  }
  // Read access is enough to cite the file; the SRT lands beside it, which
  // takes write access to the folder.
  const { file } = await fileFor(deps.drive, access, request.fileId);
  if (file.trashedAt) throw new DriveError('not_found');
  if (!/^(video|audio)\//.test(file.mimeType)) {
    throw new StudioError(
      'unsupported_file',
      'Só vídeo e áudio podem ser legendados. Escolha um arquivo de vídeo ou de áudio.',
    );
  }
  const folder = await folderFor(deps.drive, access, file.folderId, 'write');

  const input: TranscribeInput = {
    version: 1,
    storageKey: file.storageKey,
    ...(request.language ? { language: request.language } : {}),
    // Placing captions reads frames: a video only. An audio file gets the plain SRT.
    ...(request.smart && file.mimeType.startsWith('video/') ? { smart: true as const } : {}),
    destination: {
      folderId: folder.id,
      name: srtNameOf(file.name),
      sourceFileId: file.id,
      clientId: folder.clientId,
      ownerId: access.employeeId,
    },
  };
  const [row] = await deps.db.insert(jobs).values({ type: 'transcribe', input }).returning();
  if (!row) throw new Error('transcribe job was not inserted');
  return toTranscription(row);
}

function toTranscription(row: JobRow): StudioTranscription {
  const input = row.input as TranscribeInput;
  const output = (row.output ?? {}) as TranscribeOutput;
  return {
    id: row.id,
    state: row.state as StudioTranscription['state'],
    error: row.error,
    sourceFileId: input.destination.sourceFileId,
    file: output.filed
      ? {
          id: output.filed.driveFileId,
          version: output.filed.version,
          name: output.filed.name,
          folderId: input.destination.folderId,
        }
      : null,
    language: typeof output.language === 'string' ? output.language : null,
    layout:
      input.smart && row.state !== 'failed' ? { state: 'pending', error: null, files: [] } : null,
    segments:
      typeof output.segments === 'number'
        ? output.segments
        : Array.isArray(output.segments)
          ? output.segments.length
          : null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** Files one SRT in a Drive folder: a new version when a file of that name is already there. */
async function fileSrt(
  deps: StudioDeps,
  access: DriveAccess,
  folderId: string,
  name: string,
  text: string,
): Promise<{ file: Awaited<ReturnType<typeof completeUpload>>['file']; replaced: boolean }> {
  const storage = deps.drive.storage;
  if (!storage)
    throw new StudioError('storage_unavailable', 'O armazenamento não está configurado.');
  const now = deps.now();
  const srt = Buffer.from(text, 'utf8');
  const key = newStorageKey(now);
  await storage.put(key, srt, SRT_MIME);
  const [existing] = await deps.db
    .select({ id: driveFiles.id })
    .from(driveFiles)
    .where(
      and(
        eq(driveFiles.folderId, folderId),
        isNull(driveFiles.trashedAt),
        sql`lower(${driveFiles.name}) = lower(${name})`,
      ),
    );
  const [upload] = await deps.db
    .insert(driveUploads)
    .values({
      folderId,
      name,
      mimeType: SRT_MIME,
      byteSize: srt.length,
      storageKey: key,
      replaceFileId: existing?.id ?? null,
      requestedBy: access.employeeId,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    .returning();
  if (!upload) throw new Error('captions upload row was not inserted');
  const { file } = await completeUpload(deps.drive, access, upload.id);
  return { file, replaced: existing !== undefined };
}

/**
 * One transcription, and with `smart` its placement. The first look at a
 * finished transcription files the SRT (fileTranscription); the look after
 * that queues the caption_layout job once, under a row lock; the first look
 * at a finished layout files one SRT per zone used.
 */
export async function transcriptionOf(
  deps: StudioDeps,
  access: DriveAccess,
  id: string,
): Promise<{ transcription: StudioTranscription; filedNow: boolean }> {
  const result = await fileTranscription(deps, access, id);
  if (!result.transcription.layout) return result;
  const row = await deps.db.query.jobs.findFirst({
    where: and(eq(jobs.id, id), eq(jobs.type, 'transcribe'), ownedBy(access.employeeId)),
  });
  if (!row) return result;
  const layout = await layoutOf(deps, access, row);
  return { ...result, transcription: { ...toTranscription(row), layout } };
}

async function queueLayout(deps: StudioDeps, transcriptionId: string): Promise<string | null> {
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(jobs).where(eq(jobs.id, transcriptionId)).for('update');
    if (!locked) return null;
    const output = (locked.output ?? {}) as TranscribeOutput;
    if (output.layoutJobId) return output.layoutJobId;
    if (locked.state !== 'done' || !output.filed || !output.outputStorageKey) return null;
    const source = locked.input as TranscribeInput;
    const input: LayoutInput = {
      version: 1,
      storageKey: source.storageKey,
      transcriptStorageKey: output.outputStorageKey,
      transcriptionId,
      destination: source.destination,
    };
    const [queued] = await tx
      .insert(jobs)
      .values({ type: 'caption_layout', input })
      .returning({ id: jobs.id });
    if (!queued) throw new Error('caption_layout job was not inserted');
    await tx
      .update(jobs)
      .set({ output: { ...output, layoutJobId: queued.id } })
      .where(eq(jobs.id, transcriptionId));
    return queued.id;
  });
}

async function layoutOf(
  deps: StudioDeps,
  access: DriveAccess,
  transcription: JobRow,
): Promise<StudioCaptionLayout | null> {
  if (transcription.state === 'failed') return null;
  const pending: StudioCaptionLayout = { state: 'pending', error: null, files: [] };
  const layoutJobId = await queueLayout(deps, transcription.id);
  if (!layoutJobId) return pending;
  const row = await deps.db.query.jobs.findFirst({
    where: and(eq(jobs.id, layoutJobId), eq(jobs.type, 'caption_layout')),
  });
  if (!row) return pending;
  const shown = (current: JobRow): StudioCaptionLayout => {
    const output = (current.output ?? {}) as LayoutOutput;
    return {
      state: current.state as StudioCaptionLayout['state'],
      error: current.error,
      files: (output.filed ?? []).map((item) => ({
        id: item.driveFileId,
        version: item.version,
        name: item.name,
        zone: item.zone,
        cues: item.cues,
      })),
    };
  };
  const output = (row.output ?? {}) as LayoutOutput;
  if (row.state !== 'done' || output.filed || output.filing) {
    // Still being filed by another look: not ready until it is.
    return output.filing ? { ...shown(row), state: 'running' } : shown(row);
  }

  const [claimed] = await deps.db
    .update(jobs)
    .set({ output: sql`coalesce(${jobs.output}, '{}'::jsonb) || '{"filing": true}'::jsonb` })
    .where(
      and(
        eq(jobs.id, row.id),
        eq(jobs.state, 'done'),
        sql`coalesce(${jobs.output}, '{}'::jsonb) -> 'filed' is null`,
        sql`coalesce(${jobs.output}, '{}'::jsonb) -> 'filing' is null`,
      ),
    )
    .returning();
  if (!claimed) return { ...shown(row), state: 'running' };
  const rest: LayoutOutput = { ...((claimed.output ?? {}) as LayoutOutput) };
  delete rest.filing;
  const settle = async (patch: Partial<typeof jobs.$inferInsert>) => {
    const [settled] = await deps.db
      .update(jobs)
      .set({ ...patch, updatedAt: deps.now() })
      .where(eq(jobs.id, row.id))
      .returning();
    return settled ?? claimed;
  };

  const input = claimed.input as LayoutInput;
  const bytes = await deps.drive.storage?.get(input.transcriptStorageKey);
  let transcript: z.output<typeof transcriptSchema> | null = null;
  if (bytes) {
    try {
      const parsed = transcriptSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      transcript = parsed.success ? parsed.data : null;
    } catch {
      transcript = null;
    }
  }
  if (!transcript || !Array.isArray(rest.zones)) {
    return shown(
      await settle({
        state: 'failed',
        error: 'output_missing: a transcrição ou as posições não estão no armazenamento',
        output: rest,
      }),
    );
  }

  try {
    const filed: NonNullable<LayoutOutput['filed']> = [];
    for (const group of segmentsByZone(transcript.segments, rest.zones)) {
      const name = zoneSrtName(input.destination.name, group.zone);
      const { file } = await fileSrt(
        deps,
        access,
        input.destination.folderId,
        name,
        segmentsToSrt(group.segments),
      );
      filed.push({
        driveFileId: file.id,
        version: file.version,
        name: file.name,
        zone: group.zone,
        cues: group.segments.length,
      });
    }
    const done = await settle({ output: { ...rest, filed } });
    await writeAudit(deps.db, {
      actorEmployeeId: access.employeeId,
      action: 'studio.captions_layout_saved',
      entity: 'job',
      entityId: row.id,
      // Counts only: which zones, how many cues each. No text, no measurement.
      metadata: {
        transcriptionId: input.transcriptionId,
        frames: rest.frames ?? null,
        files: filed.map((item) => ({ id: item.driveFileId, zone: item.zone, cues: item.cues })),
      },
    });
    return shown(done);
  } catch (error) {
    await settle({ output: rest });
    throw error;
  }
}

/**
 * One transcription. Like `renderOf`: the first look at a finished job turns
 * the worker's segments into an SRT and files it next to the source, as a new
 * version when a file of that name is already there. Claimed with one
 * conditional update, so two tabs polling at once file it once.
 */
async function fileTranscription(
  deps: StudioDeps,
  access: DriveAccess,
  id: string,
): Promise<{ transcription: StudioTranscription; filedNow: boolean }> {
  const row = await deps.db.query.jobs.findFirst({
    where: and(eq(jobs.id, id), eq(jobs.type, 'transcribe'), ownedBy(access.employeeId)),
  });
  if (!row) throw new StudioError('not_found', 'Legenda não encontrada.');
  const output = (row.output ?? {}) as TranscribeOutput;
  if (row.state !== 'done' || output.filed || output.filing) {
    return { transcription: toTranscription(row), filedNow: false };
  }

  const [claimed] = await deps.db
    .update(jobs)
    .set({ output: sql`coalesce(${jobs.output}, '{}'::jsonb) || '{"filing": true}'::jsonb` })
    .where(
      and(
        eq(jobs.id, id),
        eq(jobs.state, 'done'),
        sql`coalesce(${jobs.output}, '{}'::jsonb) -> 'filed' is null`,
        sql`coalesce(${jobs.output}, '{}'::jsonb) -> 'filing' is null`,
      ),
    )
    .returning();
  if (!claimed) return { transcription: toTranscription(row), filedNow: false };
  const settle = (patch: Partial<typeof jobs.$inferInsert>) =>
    deps.db
      .update(jobs)
      .set({ ...patch, updatedAt: deps.now() })
      .where(eq(jobs.id, id))
      .returning();

  const input = claimed.input as TranscribeInput;
  const rest: TranscribeOutput = { ...((claimed.output ?? {}) as TranscribeOutput) };
  delete rest.filing;
  const storage = deps.drive.storage;
  if (!storage)
    throw new StudioError('storage_unavailable', 'O armazenamento não está configurado.');

  const bytes = rest.outputStorageKey ? await storage.get(rest.outputStorageKey) : null;
  let transcript: z.output<typeof transcriptSchema> | null = null;
  if (bytes) {
    try {
      const parsed = transcriptSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      transcript = parsed.success ? parsed.data : null;
    } catch {
      transcript = null;
    }
  }
  if (!transcript) {
    const [failed] = await settle({
      state: 'failed',
      error: 'output_missing: a transcrição não está no armazenamento',
      output: rest,
    });
    return { transcription: toTranscription(failed ?? claimed), filedNow: false };
  }

  try {
    const now = deps.now();
    const { file, replaced } = await fileSrt(
      deps,
      access,
      input.destination.folderId,
      input.destination.name,
      segmentsToSrt(transcript.segments),
    );

    const filed = {
      driveFileId: file.id,
      version: file.version,
      name: file.name,
      at: now.toISOString(),
    };
    const [done] = await settle({
      output: {
        ...rest,
        language: transcript.language ?? rest.language,
        segments: transcript.segments.length,
        filed,
      },
    });
    await writeAudit(deps.db, {
      actorEmployeeId: access.employeeId,
      action: 'studio.captions_saved',
      entity: 'drive_file',
      entityId: file.id,
      metadata: {
        jobId: id,
        version: file.version,
        segments: transcript.segments.length,
        replaced,
      },
    });
    return { transcription: toTranscription(done ?? claimed), filedNow: true };
  } catch (error) {
    await settle({ output: rest });
    throw error;
  }
}
