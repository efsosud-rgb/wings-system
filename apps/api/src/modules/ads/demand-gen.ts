import {
  DEMAND_GEN_LOGO_MAX_BYTES,
  DEMAND_GEN_LOGO_MIN_PX,
  DEMAND_GEN_LOGO_TYPES,
  parseYoutubeVideoRef,
  type YoutubeVideoCheck,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { driveFiles } from '../../db/schema/index.js';
import { readImageHeader } from '../../lib/image-header.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import { DriveError, fileFor } from '../drive/service.js';
import type { DriveAccess } from '../drive/access.js';
import type { PlannedWrite } from './platform/types.js';

/**
 * What a YouTube (Demand Gen) campaign needs checked by the server before it
 * becomes a request, and loaded right before it is written: the videos exist
 * on YouTube and are not private, and the logo is a Drive file Google takes.
 */

// --- videos ------------------------------------------------------------------------------

const OEMBED = 'https://www.youtube.com/oembed';

/**
 * YouTube's public oEmbed, which needs no key: 200 for a public or unlisted
 * video (it cannot tell the two apart, and Google takes both), 401/403 for a
 * private one (or one whose owner blocked embedding), 400/404 for none. No
 * answer is "unavailable", never a yes. The title is shown to the person and
 * never logged.
 */
export async function checkYoutubeVideo(
  fetchImpl: typeof fetch,
  videoId: string,
): Promise<YoutubeVideoCheck> {
  const target = `${OEMBED}?format=json&url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`,
  )}`;
  let response: Response;
  try {
    response = await fetchImpl(target, { signal: AbortSignal.timeout(8_000) });
  } catch {
    return { videoId, status: 'unavailable' };
  }
  if (response.status === 200) {
    const body = (await response.json().catch(() => null)) as { title?: unknown } | null;
    return {
      videoId,
      status: 'ok',
      title: typeof body?.title === 'string' ? body.title.slice(0, 200) : null,
    };
  }
  if (response.status === 401 || response.status === 403) return { videoId, status: 'private' };
  if (response.status === 400 || response.status === 404) return { videoId, status: 'not_found' };
  return { videoId, status: 'unavailable' };
}

export async function checkYoutubeVideos(
  fetchImpl: typeof fetch,
  refs: string[],
): Promise<YoutubeVideoCheck[]> {
  const ids = [
    ...new Set(refs.map((ref) => parseYoutubeVideoRef(ref)).filter(Boolean)),
  ] as string[];
  return Promise.all(ids.map((id) => checkYoutubeVideo(fetchImpl, id)));
}

/** The first video Google would not take, in words; null when all are fine. */
export function videoRefusal(
  checks: YoutubeVideoCheck[],
): { code: 'video_unavailable' | 'video_check_unavailable'; message: string } | null {
  const bad = checks.find((check) => check.status === 'not_found' || check.status === 'private');
  if (bad) {
    return {
      code: 'video_unavailable',
      message:
        bad.status === 'private'
          ? `O vídeo ${bad.videoId} está privado no YouTube (ou não deixa ser incorporado): deixe-o público ou não listado.`
          : `O vídeo ${bad.videoId} não existe no YouTube. Confira o link.`,
    };
  }
  if (checks.some((check) => check.status === 'unavailable')) {
    return {
      code: 'video_check_unavailable',
      message: 'Não deu para conferir o vídeo no YouTube agora. Tente de novo em instantes.',
    };
  }
  return null;
}

// --- logo --------------------------------------------------------------------------------

export type LogoCheck =
  | { ok: true; data: Buffer }
  | {
      ok: false;
      code: 'logo_not_found' | 'logo_refused' | 'storage_unavailable';
      message: string;
    };

/**
 * The logo as Google takes it for a Demand Gen ad: PNG or JPEG (by content,
 * not by name), square within 1 %, at least 128 px, up to 5 MB. With
 * `access`, the file must also be one the person sees in the Drive — another
 * department's file is "not found", as everywhere in the Drive.
 */
export async function readDemandGenLogo(
  db: Database,
  storage: ObjectStorage | null,
  fileId: string,
  access?: DriveAccess,
): Promise<LogoCheck> {
  const notFound = {
    ok: false as const,
    code: 'logo_not_found' as const,
    message: 'A logo não foi encontrada no Drive. Escolha de novo.',
  };
  if (access) {
    try {
      await fileFor({ db, storage, maxFileBytes: 0, now: () => new Date() }, access, fileId);
    } catch (error) {
      if (error instanceof DriveError) return notFound;
      throw error;
    }
  }
  const [file] = await db.select().from(driveFiles).where(eq(driveFiles.id, fileId)).limit(1);
  if (!file || file.trashedAt) return notFound;
  const refused = (message: string) => ({
    ok: false as const,
    code: 'logo_refused' as const,
    message,
  });
  if (!(DEMAND_GEN_LOGO_TYPES as readonly string[]).includes(file.mimeType)) {
    return refused('A logo precisa ser PNG ou JPEG.');
  }
  if (file.byteSize > DEMAND_GEN_LOGO_MAX_BYTES) return refused('A logo pode ter até 5 MB.');
  if (!storage) {
    return {
      ok: false,
      code: 'storage_unavailable',
      message: 'O Drive não está disponível agora.',
    };
  }
  const bytes = await storage.get(file.storageKey);
  if (!bytes || bytes.length !== file.byteSize) return notFound;
  const header = readImageHeader(bytes);
  if (!header || header.type !== file.mimeType) {
    return refused('A logo não é um PNG ou JPEG legível.');
  }
  const { width, height } = header;
  if (Math.abs(width - height) > Math.max(width, height) * 0.01) {
    return refused(`A logo precisa ser quadrada (esta tem ${width} × ${height}).`);
  }
  if (width < DEMAND_GEN_LOGO_MIN_PX) {
    return refused(
      `A logo precisa ter ao menos ${DEMAND_GEN_LOGO_MIN_PX} × ${DEMAND_GEN_LOGO_MIN_PX} pixels.`,
    );
  }
  return { ok: true, data: Buffer.from(bytes) };
}

/**
 * A Demand Gen write with its logo read from the Drive, right before it is
 * validated or sent: the bytes go inline in the one mutate. Any other write
 * passes untouched.
 */
export async function withDemandGenLogo(
  db: Database,
  storage: ObjectStorage | null,
  write: PlannedWrite,
): Promise<{ ok: true; write: PlannedWrite } | { ok: false; message: string }> {
  const demandGen = write.kind === 'create_campaign' ? write.spec.google?.demandGen : undefined;
  if (write.kind !== 'create_campaign' || !demandGen) return { ok: true, write };
  const logo = await readDemandGenLogo(db, storage, demandGen.logo.driveFileId);
  if (!logo.ok) return { ok: false, message: logo.message };
  return {
    ok: true,
    write: {
      ...write,
      spec: {
        ...write.spec,
        google: {
          ...write.spec.google!,
          demandGen: {
            ...demandGen,
            logo: { ...demandGen.logo, data: logo.data.toString('base64') },
          },
        },
      },
    },
  };
}
