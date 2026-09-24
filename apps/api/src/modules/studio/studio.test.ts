import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_COOKIE,
  STUDIO_LINK_TTL_SECONDS,
  wingsDriveRef,
  type DriveFile,
  type DriveFolder,
  type DriveUploadTicket,
  type RoleKey,
  type SectorSlug,
  type StudioRender,
  type StudioTranscription,
} from '@wings/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog, driveFiles, jobs } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { storageOf } from '../../lib/storage/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

/**
 * Wings Studio against the local storage backend. The worker never runs here:
 * its side of the contract (docs/studio/jobs.md) is played by writing the job
 * row and the object by hand, exactly as it would.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-studio-'));
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      MEDIA_DIR: dir,
    }),
    db,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
});

const SECTOR_OF: Partial<Record<RoleKey, SectorSlug>> = {
  admin_master: 'diretoria',
  marketing: 'marketing',
};

async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, { role, sector: SECTOR_OF[role] ?? 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}
type Session = Awaited<ReturnType<typeof sessionFor>>;

const folderAt = async (session: Session, path: string) => {
  const { folders } = (await app.inject({ url: '/drive/tree', cookies: session.cookies })).json<{
    folders: DriveFolder[];
  }>();
  const found = folders.find((folder) => folder.path === path);
  if (!found) throw new Error(`no folder at ${path}`);
  return found;
};

/** The whole upload, as the browser does it. */
async function upload(
  session: Session,
  folderId: string,
  name: string,
  bytes: Buffer,
  mimeType = 'video/mp4',
) {
  const asked = await app.inject({
    method: 'POST',
    url: '/drive/uploads',
    cookies: session.cookies,
    payload: { folderId, name, mimeType, byteSize: bytes.length },
  });
  expect(asked.statusCode).toBe(201);
  const { ticket } = asked.json<{ ticket: DriveUploadTicket }>();
  const sent = await app.inject({
    method: 'PUT',
    url: ticket.url.replace('http://localhost:5173/api', ''),
    headers: { ...ticket.headers, 'content-length': String(bytes.length) },
    payload: bytes,
  });
  expect(sent.statusCode).toBe(200);
  const done = await app.inject({
    method: 'POST',
    url: `/drive/uploads/${ticket.uploadId}/complete`,
    cookies: session.cookies,
  });
  expect(done.statusCode).toBe(201);
  return done.json<{ file: DriveFile }>().file;
}

/** A project the editor would save: one video clip, vertical. */
const projectWith = (src: string, size = { width: 1080, height: 1920 }) => ({
  timeline: {
    background: '#000000',
    tracks: [{ clips: [{ asset: { type: 'video', src }, start: 0, length: 4 }] }],
  },
  output: { format: 'mp4', size },
});

const render = (session: Session, id: string) =>
  app.inject({ url: `/studio/renders/${id}`, cookies: session.cookies });

/** What the worker does when it finishes: the object in storage, the row done. */
async function workerFinishes(
  jobId: string,
  bytes: Buffer | null,
  extra: Record<string, unknown> = {},
) {
  const row = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
  if (!row) throw new Error('no job');
  const input = row.input as { output: { storageKey: string } };
  const storage = storageOf(app.wings);
  if (!storage) throw new Error('no storage');
  if (bytes) await storage.put(input.output.storageKey, bytes, 'video/mp4');
  await db
    .update(jobs)
    .set({
      state: 'done',
      finishedAt: new Date(),
      output: {
        storageKey: input.output.storageKey,
        byteSize: bytes?.length ?? 999,
        mimeType: 'video/mp4',
        width: 1080,
        height: 1920,
        fps: 30,
        durationSeconds: 4,
        unsupported: [],
        renderSeconds: 1.2,
        ...extra,
      },
    })
    .where(eq(jobs.id, jobId));
}

let marketing: Session;
let rh: Session;
let admin: Session;
let media: DriveFolder;
let clip: DriveFile;

beforeAll(async () => {
  marketing = await sessionFor('marketing');
  rh = await sessionFor('rh_dp');
  admin = await sessionFor('admin_master');
  media = await folderAt(marketing, '/Formatação/Marketing/Mídia');
  clip = await upload(marketing, media.id, 'entrevista.mp4', Buffer.from('not really a video'));
});

describe('opening a file in the editor', () => {
  it('hands Marketing a link that lasts an hour, and writes it to the audit log by id', async () => {
    const before = Date.now();
    const response = await app.inject({
      url: `/studio/files/${clip.id}/link`,
      cookies: marketing.cookies,
    });
    expect(response.statusCode).toBe(200);
    const { url, expiresAt } = response.json<{ url: string; expiresAt: string }>();
    expect(url).toContain('/api/drive/blob?t=');
    expect(url).not.toContain(dir);
    const ttl = (new Date(expiresAt).getTime() - before) / 1000;
    expect(ttl).toBeGreaterThan(STUDIO_LINK_TTL_SECONDS - 30);
    expect(ttl).toBeLessThanOrEqual(STUDIO_LINK_TTL_SECONDS + 30);

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'studio.file_opened'), eq(auditLog.entityId, clip.id)));
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]?.metadata)).not.toContain('entrevista');
  });

  it('is closed to a role without marketing.media.edit, whatever its Drive access', async () => {
    const response = await app.inject({
      url: `/studio/files/${clip.id}/link`,
      cookies: rh.cookies,
    });
    expect(response.statusCode).toBe(403);
  });

  it("answers 404 for another department's file, like the Drive does", async () => {
    const rhFolder = await folderAt(admin, '/RH-DP/Documentos');
    const theirs = await upload(admin, rhFolder.id, 'holerite.mp4', Buffer.from('rh'));
    const response = await app.inject({
      url: `/studio/files/${theirs.id}/link`,
      cookies: marketing.cookies,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('asking the server to render', () => {
  it('refuses a project whose clip points at an address instead of a Drive file', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/studio/renders',
      cookies: marketing.cookies,
      payload: {
        project: projectWith('https://example.com/video.mp4'),
        destination: { folderId: media.id, name: 'corte.mp4' },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe('invalid_project');
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it('refuses a project without an output size', async () => {
    const project = projectWith(wingsDriveRef(clip.id));
    delete (project as { output?: unknown }).output;
    const response = await app.inject({
      method: 'POST',
      url: '/studio/renders',
      cookies: marketing.cookies,
      payload: { project, destination: { folderId: media.id, name: 'corte.mp4' } },
    });
    expect(response.statusCode).toBe(422);
  });

  it('queues a job with the storage keys resolved on the server, and none of them in the answer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/studio/renders',
      cookies: marketing.cookies,
      payload: {
        project: projectWith(wingsDriveRef(clip.id)),
        destination: { folderId: media.id, name: 'corte.mp4' },
      },
    });
    expect(response.statusCode).toBe(202);
    const { render: queued } = response.json<{ render: StudioRender }>();
    expect(queued.state).toBe('pending');
    expect(queued.file).toBeNull();
    expect(response.body).not.toContain('storageKey');
    expect(response.body).not.toContain('drive/');

    const [row] = await db.select().from(jobs).where(eq(jobs.id, queued.id));
    const [stored] = await db.select().from(driveFiles).where(eq(driveFiles.id, clip.id));
    const input = row?.input as {
      version: number;
      assets: Record<string, { storageKey: string; byteSize: number }>;
      output: { storageKey: string; width: number; height: number; fps: number };
      destination: { ownerId: string; folderId: string };
    };
    expect(row?.type).toBe('render');
    expect(input.version).toBe(1);
    expect(input.assets[clip.id]?.storageKey).toBe(stored?.storageKey);
    expect(input.assets[clip.id]?.byteSize).toBe(stored?.byteSize);
    expect(input.output.storageKey).toMatch(/^drive\//);
    expect(input.output).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    expect(input.destination).toMatchObject({ ownerId: marketing.employeeId, folderId: media.id });

    const audited = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'studio.render_requested'), eq(auditLog.entityId, queued.id)));
    expect(audited).toHaveLength(1);
  });

  it('refuses a destination folder outside the department', async () => {
    const rhFolder = await folderAt(admin, '/RH-DP/Documentos');
    const response = await app.inject({
      method: 'POST',
      url: '/studio/renders',
      cookies: marketing.cookies,
      payload: {
        project: projectWith(wingsDriveRef(clip.id)),
        destination: { folderId: rhFolder.id, name: 'corte.mp4' },
      },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('when the worker is done', () => {
  const ask = async (name: string, replaceFileId?: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/studio/renders',
      cookies: marketing.cookies,
      payload: {
        project: projectWith(wingsDriveRef(clip.id)),
        destination: { folderId: media.id, name, replaceFileId },
      },
    });
    expect(response.statusCode).toBe(202);
    return response.json<{ render: StudioRender }>().render;
  };

  it('files the result in the Drive on the first look, once, and audits it', async () => {
    const queued = await ask('corte-final.mp4');
    expect((await render(marketing, queued.id)).json<{ render: StudioRender }>().render.state).toBe(
      'pending',
    );

    await workerFinishes(queued.id, Buffer.from('rendered bytes'), {
      unsupported: ['faixa 1, clipe 1: transition wipeLeft rendered as cut'],
    });

    const first = (await render(marketing, queued.id)).json<{ render: StudioRender }>().render;
    expect(first.state).toBe('done');
    expect(first.file).toEqual({ id: expect.any(String), version: 1 });
    expect(first.unsupported).toHaveLength(1);

    const second = (await render(marketing, queued.id)).json<{ render: StudioRender }>().render;
    expect(second.file).toEqual(first.file);

    const filed = await db
      .select()
      .from(driveFiles)
      .where(and(eq(driveFiles.folderId, media.id), eq(driveFiles.name, 'corte-final.mp4')));
    expect(filed).toHaveLength(1);
    expect(filed[0]?.byteSize).toBe('rendered bytes'.length);
    expect(filed[0]?.ownerId).toBe(marketing.employeeId);

    const audited = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'studio.render_saved'), eq(auditLog.entityId, first.file!.id)),
      );
    expect(audited).toHaveLength(1);

    const listed = (await app.inject({ url: '/studio/renders', cookies: marketing.cookies })).json<{
      renders: StudioRender[];
    }>().renders;
    expect(listed.map((item) => item.id)).toContain(queued.id);
    const others = (await app.inject({ url: '/studio/renders', cookies: admin.cookies })).json<{
      renders: StudioRender[];
    }>().renders;
    expect(others.map((item) => item.id)).not.toContain(queued.id);
  });

  it('puts a render on top of an existing file as a new version', async () => {
    const queued = await ask('entrevista.mp4', clip.id);
    await workerFinishes(queued.id, Buffer.from('a second cut'));
    const done = (await render(marketing, queued.id)).json<{ render: StudioRender }>().render;
    expect(done.state).toBe('done');
    expect(done.file).toEqual({ id: clip.id, version: 2 });
  });

  it('marks the job failed when the promised object is not in storage', async () => {
    const queued = await ask('sumiu.mp4');
    await workerFinishes(queued.id, null);
    const failed = (await render(marketing, queued.id)).json<{ render: StudioRender }>().render;
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatch(/^output_missing/);
    expect(failed.file).toBeNull();
  });

  it("is invisible to somebody else's session", async () => {
    const queued = await ask('meu.mp4');
    expect((await render(admin, queued.id)).statusCode).toBe(404);
  });
});

describe('shapes drawn inline', () => {
  const withShape = (svg: string) => {
    const project = projectWith(wingsDriveRef(clip.id));
    project.timeline.tracks.unshift({
      clips: [{ asset: { type: 'svg', src: svg }, start: 0, length: 4 }],
    });
    return project;
  };

  it('accepts an inline SVG shape, which cites no file', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/studio/renders',
      cookies: marketing.cookies,
      payload: {
        project: withShape(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#e95228"/></svg>',
        ),
        destination: { folderId: media.id, name: 'com-forma.mp4' },
      },
    });
    expect(response.statusCode).toBe(202);
  });

  it('refuses a shape that would fetch something', async () => {
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://example.com/a.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'https://example.com/shape.svg',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/studio/renders',
        cookies: marketing.cookies,
        payload: { project: withShape(svg), destination: { folderId: media.id, name: 'x.mp4' } },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: string }>().error).toBe('invalid_project');
    }
  });
});

describe('captions by Whisper', () => {
  const ask = async (session: Session, fileId: string, language?: string) =>
    app.inject({
      method: 'POST',
      url: '/studio/transcriptions',
      cookies: session.cookies,
      payload: { fileId, ...(language ? { language } : {}) },
    });
  const look = (session: Session, id: string) =>
    app.inject({ url: `/studio/transcriptions/${id}`, cookies: session.cookies });

  /** What the worker does: the transcript JSON next to the source, the row done. */
  async function whisperFinishes(jobId: string, transcript: unknown | null) {
    const row = await db.query.jobs.findFirst({ where: eq(jobs.id, jobId) });
    if (!row) throw new Error('no job');
    const input = row.input as { storageKey: string };
    const outputStorageKey = `${input.storageKey}.transcript.json`;
    const storage = storageOf(app.wings);
    if (!storage) throw new Error('no storage');
    if (transcript) {
      await storage.put(
        outputStorageKey,
        Buffer.from(JSON.stringify(transcript)),
        'application/json',
      );
    }
    await db
      .update(jobs)
      .set({
        state: 'done',
        finishedAt: new Date(),
        output: {
          outputStorageKey,
          language: 'pt',
          languageProbability: 0.98,
          durationSeconds: 4,
          segments: [],
        },
      })
      .where(eq(jobs.id, jobId));
  }

  const segments = [
    { start: 0, end: 1.5, text: 'Olá, franqueado.' },
    { start: 1.5, end: 3.2, text: '  ' },
    { start: 3.2, end: 4, text: 'Vamos começar.' },
  ];

  it('queues a transcribe job the worker can read, with nothing of the storage in the answer', async () => {
    const response = await ask(marketing, clip.id, 'pt');
    expect(response.statusCode).toBe(202);
    const { transcription } = response.json<{ transcription: StudioTranscription }>();
    expect(transcription).toMatchObject({ state: 'pending', sourceFileId: clip.id, file: null });
    expect(response.body).not.toContain('storageKey');
    expect(response.body).not.toContain('drive/');

    const [row] = await db.select().from(jobs).where(eq(jobs.id, transcription.id));
    const [stored] = await db.select().from(driveFiles).where(eq(driveFiles.id, clip.id));
    expect(row?.type).toBe('transcribe');
    expect(row?.input).toMatchObject({
      version: 1,
      storageKey: stored?.storageKey,
      language: 'pt',
      destination: {
        folderId: media.id,
        name: 'entrevista.srt',
        sourceFileId: clip.id,
        ownerId: marketing.employeeId,
      },
    });
    const audited = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'studio.captions_requested'),
          eq(auditLog.entityId, transcription.id),
        ),
      );
    expect(audited).toHaveLength(1);
  });

  it('files the SRT next to the video on the first look, once, and audits it', async () => {
    const { transcription: queued } = (await ask(marketing, clip.id)).json<{
      transcription: StudioTranscription;
    }>();
    await whisperFinishes(queued.id, { language: 'pt', languageProbability: 0.98, segments });

    const first = (await look(marketing, queued.id)).json<{ transcription: StudioTranscription }>()
      .transcription;
    expect(first.state).toBe('done');
    expect(first.file).toMatchObject({ name: 'entrevista.srt', folderId: media.id, version: 1 });
    expect(first.language).toBe('pt');
    expect(first.segments).toBe(3);

    const second = (await look(marketing, queued.id)).json<{ transcription: StudioTranscription }>()
      .transcription;
    expect(second.file).toEqual(first.file);

    const filed = await db
      .select()
      .from(driveFiles)
      .where(and(eq(driveFiles.folderId, media.id), eq(driveFiles.name, 'entrevista.srt')));
    expect(filed).toHaveLength(1);
    expect(filed[0]?.mimeType).toBe('application/x-subrip');
    const storage = storageOf(app.wings);
    const srt = (await storage?.get(filed[0]!.storageKey))?.toString('utf8') ?? '';
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,500\nOlá, franqueado.');
    expect(srt).not.toContain('\n2\n00:00:01,500');
    expect(srt).toContain('00:00:03,200 --> 00:00:04,000\nVamos começar.');

    const audited = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'studio.captions_saved'), eq(auditLog.entityId, first.file!.id)),
      );
    expect(audited).toHaveLength(1);

    // Asking again puts the new SRT on top of the old one as a version.
    const { transcription: again } = (await ask(marketing, clip.id)).json<{
      transcription: StudioTranscription;
    }>();
    await whisperFinishes(again.id, { language: 'pt', languageProbability: 0.98, segments });
    const redone = (await look(marketing, again.id)).json<{ transcription: StudioTranscription }>()
      .transcription;
    expect(redone.file).toMatchObject({ id: first.file!.id, version: 2 });
  });

  it('takes audio too, and refuses an image', async () => {
    const audio = await upload(
      marketing,
      media.id,
      'narracao.mp3',
      Buffer.from('mp3'),
      'audio/mpeg',
    );
    expect((await ask(marketing, audio.id)).statusCode).toBe(202);
    const image = await upload(marketing, media.id, 'foto.png', Buffer.from('png'), 'image/png');
    const refused = await ask(marketing, image.id);
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ error: string }>().error).toBe('unsupported_file');
  });

  it('marks the job failed when the transcript is not in storage', async () => {
    const other = await upload(marketing, media.id, 'sem-audio.mp4', Buffer.from('mp4'));
    const { transcription: queued } = (await ask(marketing, other.id)).json<{
      transcription: StudioTranscription;
    }>();
    await whisperFinishes(queued.id, null);
    const failed = (await look(marketing, queued.id)).json<{ transcription: StudioTranscription }>()
      .transcription;
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatch(/^output_missing/);
    expect(failed.file).toBeNull();
  });

  describe('smart captions', () => {
    const askSmart = (fileId: string) =>
      app.inject({
        method: 'POST',
        url: '/studio/transcriptions',
        cookies: marketing.cookies,
        payload: { fileId, smart: true },
      });
    const layoutJobs = () => db.select().from(jobs).where(eq(jobs.type, 'caption_layout'));
    const shown = async (id: string) =>
      (await look(marketing, id)).json<{ transcription: StudioTranscription }>().transcription;

    it('queues one caption_layout job after the SRT, files one SRT per zone, once, and keeps no text in the job', async () => {
      const video = await upload(marketing, media.id, 'depoimento.mp4', Buffer.from('mp4'));
      const { transcription: queued } = (await askSmart(video.id)).json<{
        transcription: StudioTranscription;
      }>();
      expect(queued.layout).toEqual({ state: 'pending', error: null, files: [] });
      expect(await layoutJobs()).toHaveLength(0);

      await whisperFinishes(queued.id, { language: 'pt', languageProbability: 0.98, segments });
      const first = await shown(queued.id);
      expect(first.file).toMatchObject({ name: 'depoimento.srt' });
      expect(first.layout?.state).toBe('pending');
      await shown(queued.id);
      const [layoutJob, ...others] = await layoutJobs();
      expect(others).toHaveLength(0);
      if (!layoutJob) throw new Error('expected a caption_layout job');
      const input = layoutJob.input as Record<string, unknown>;
      expect(input.storageKey).toEqual(expect.any(String));
      expect(String(input.transcriptStorageKey)).toMatch(/\.transcript\.json$/);
      expect(JSON.stringify(input)).not.toMatch(/franqueado|começar/);

      // The worker answers one zone per segment (the empty one included) and nothing else.
      await db
        .update(jobs)
        .set({
          state: 'done',
          finishedAt: new Date(),
          output: { zones: ['top', 'top', 'bottom'], frames: 5, width: 1080, height: 1920 },
        })
        .where(eq(jobs.id, layoutJob.id));
      const placed = await shown(queued.id);
      expect(placed.layout?.state).toBe('done');
      expect(placed.layout?.files.map((file) => [file.zone, file.name, file.cues])).toEqual([
        ['bottom', 'depoimento.legenda-embaixo.srt', 1],
        ['top', 'depoimento.legenda-em-cima.srt', 1],
      ]);
      const storage = storageOf(app.wings);
      const [top] = await db
        .select()
        .from(driveFiles)
        .where(eq(driveFiles.name, 'depoimento.legenda-em-cima.srt'));
      const topSrt = (await storage?.get(top!.storageKey))?.toString('utf8') ?? '';
      expect(topSrt).toBe('1\n00:00:00,000 --> 00:00:01,500\nOlá, franqueado.\n');

      // Looking again files nothing twice.
      expect((await shown(queued.id)).layout?.files).toEqual(placed.layout?.files);
      const zoneFiles = await db
        .select()
        .from(driveFiles)
        .where(
          and(
            eq(driveFiles.folderId, media.id),
            sql`${driveFiles.name} like 'depoimento.legenda-%'`,
          ),
        );
      expect(zoneFiles).toHaveLength(2);
      const audited = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'studio.captions_layout_saved'));
      expect(audited).toHaveLength(1);
      expect(JSON.stringify(audited[0]?.metadata)).not.toMatch(/franqueado|começar/);
    });

    it('says when placing failed, and the plain SRT is still there', async () => {
      const video = await upload(marketing, media.id, 'loja.mp4', Buffer.from('mp4'));
      const { transcription: queued } = (await askSmart(video.id)).json<{
        transcription: StudioTranscription;
      }>();
      await whisperFinishes(queued.id, { language: 'pt', languageProbability: 0.98, segments });
      await shown(queued.id);
      const [layoutJob] = (await layoutJobs()).filter(
        (row) => (row.input as { transcriptionId: string }).transcriptionId === queued.id,
      );
      await db
        .update(jobs)
        .set({ state: 'failed', error: 'caption layout exited with status 3' })
        .where(eq(jobs.id, layoutJob!.id));
      const failed = await shown(queued.id);
      expect(failed.layout).toMatchObject({ state: 'failed', files: [] });
      expect(failed.file).toMatchObject({ name: 'loja.srt' });
    });

    it('gives an audio file the plain SRT only', async () => {
      const audio = await upload(marketing, media.id, 'voz.mp3', Buffer.from('mp3'), 'audio/mpeg');
      const { transcription } = (await askSmart(audio.id)).json<{
        transcription: StudioTranscription;
      }>();
      expect(transcription.layout).toBeNull();
    });
  });

  it("is invisible to somebody else's session, and closed without the permission", async () => {
    const { transcription: queued } = (await ask(marketing, clip.id)).json<{
      transcription: StudioTranscription;
    }>();
    expect((await look(admin, queued.id)).statusCode).toBe(404);
    expect((await ask(rh, clip.id)).statusCode).toBe(403);
  });
});
