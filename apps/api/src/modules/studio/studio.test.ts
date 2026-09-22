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
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
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
async function upload(session: Session, folderId: string, name: string, bytes: Buffer) {
  const asked = await app.inject({
    method: 'POST',
    url: '/drive/uploads',
    cookies: session.cookies,
    payload: { folderId, name, mimeType: 'video/mp4', byteSize: bytes.length },
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
