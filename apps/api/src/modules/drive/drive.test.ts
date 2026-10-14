import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DRIVE_CLIENT_STAGES,
  DRIVE_FOLDER_SLOTS,
  SESSION_COOKIE,
  type Client,
  type DriveFile,
  type DriveFolder,
  type DriveUploadTicket,
  type RoleKey,
  type SectorSlug,
} from '@wings/shared';
import { and, eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { byteRangeOf } from './routes.js';
import type { Database } from '../../db/client.js';
import { seed } from '../../db/seed.js';
import { auditLog, driveFiles, driveFolders, driveTemplateNodes } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  clientRegister,
  createEmployee,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';

/**
 * The Drive over the local backend in a temporary folder: no test reaches a
 * bucket. The R2 path is covered at the end with a bucket played by `fetch`.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let dir: string;

const envOf = (extra: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    MEDIA_DIR: dir,
    DRIVE_MAX_FILE_BYTES: '1000',
    ...extra,
  });

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-drive-'));
  app = await buildApp({ env: envOf(), db });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
});

const SECTOR_OF: Partial<Record<RoleKey, SectorSlug>> = {
  admin_master: 'diretoria',
  diretoria: 'diretoria',
  marketing: 'marketing',
};

async function sessionFor(role: RoleKey, on: FastifyInstance = app) {
  const employee = await createEmployee(db, {
    role,
    sector: SECTOR_OF[role] ?? (role.startsWith('formatacao') ? 'formatacao' : 'comercial'),
  });
  const login = await on.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}
type Session = Awaited<ReturnType<typeof sessionFor>>;

const tree = async (session: Session) =>
  (await app.inject({ url: '/drive/tree', cookies: session.cookies })).json<{
    folders: DriveFolder[];
  }>().folders;
const folderAt = async (session: Session, path: string) => {
  const found = (await tree(session)).find((folder) => folder.path === path);
  if (!found) throw new Error(`no folder at ${path}`);
  return found;
};

/** The whole upload, as a browser does it: ask, send the bytes to the address, confirm. */
async function upload(
  session: Session,
  folderId: string,
  name: string,
  bytes: Buffer,
  extra: Record<string, unknown> = {},
) {
  const asked = await app.inject({
    method: 'POST',
    url: '/drive/uploads',
    cookies: session.cookies,
    payload: { folderId, name, mimeType: 'application/pdf', byteSize: bytes.length, ...extra },
  });
  if (asked.statusCode !== 201) return { asked, file: null };
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
  return { asked, done, ticket, file: done.json<{ file: DriveFile }>().file };
}

describe('the folder model', () => {
  it('is seeded once, makes its folders, and running the seed again changes nothing', async () => {
    const before = await db.select().from(driveFolders);
    const paths = before.map((folder) => folder.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/Formatação',
        '/Formatação/Marketing/Mídia',
        '/Formatação/RH-DP',
        '/Formatação/Projetos',
        '/Clientes',
        '/Comercial/Propostas Comerciais',
        '/RH-DP/Documentos',
        '/RH-DP/Contratos',
      ]),
    );
    // The old layout is gone: no "Clientes" inside a department, no dossier.
    expect(paths.filter((path) => path.includes('/Clientes') && path !== '/Clientes')).toEqual([]);
    expect(before.every((folder) => folder.origin === 'template')).toBe(true);
    await seed(db);
    expect(await db.select().from(driveFolders)).toHaveLength(before.length);
    const nodes = await db.select().from(driveTemplateNodes);
    const clientsNodes = nodes.filter((node) => node.kind === 'clients');
    expect(clientsNodes).toHaveLength(1);
    expect(clientsNodes[0]).toMatchObject({ parentId: null, department: 'clientes' });
    // Every node of a client's tree has its function, for the Portal and the import.
    expect(
      nodes
        .filter((node) => node.parentId !== null && node.slot !== null)
        .map((node) => node.slot)
        .sort(),
    ).toEqual([...DRIVE_FOLDER_SLOTS].sort());
  });

  it('gives a new client its numbered tree, renames and renumbers it, and keeps it when it is switched off', async () => {
    const marketing = await sessionFor('marketing');
    const made = await app.inject({
      method: 'POST',
      url: '/clients',
      cookies: marketing.cookies,
      payload: clientRegister('Padaria Aurora'),
    });
    const client = made.json<{ client: Client }>().client;
    expect(client.number).toBe(1);
    const rows = async () =>
      db.select().from(driveFolders).where(eq(driveFolders.clientId, client.id));
    const paths = async () => (await rows()).map((folder) => folder.path).sort();
    const root = '/Clientes/01. Padaria Aurora';
    expect(await paths()).toEqual(
      [
        root,
        ...DRIVE_CLIENT_STAGES.map((stage) => `${root}/${stage.name}`),
        `${root}/08 Marketing/Mídia`,
        `${root}/Documentos Enviados`,
        `${root}/Reuniões`,
        `${root}/Entrega`,
        ...DRIVE_CLIENT_STAGES.map((stage) => `${root}/Entrega/${stage.name}`),
      ].sort(),
    );
    // Each stage folder belongs to its department, and carries its slot.
    const bySlot = new Map((await rows()).map((folder) => [folder.slot, folder]));
    expect(bySlot.get('01')?.department).toBe('imersao');
    expect(bySlot.get('05')?.department).toBe('projetos');
    expect(bySlot.get('06')?.department).toBe('juridico');
    expect(bySlot.get('entrega_06')?.department).toBe('juridico');
    expect(bySlot.get('midia')?.department).toBe('marketing');
    expect(bySlot.get('enviados')?.department).toBe('clientes');
    // Wings Company is who the work is by: it has no client folder.
    expect(
      await db.select().from(driveFolders).where(like(driveFolders.path, '/Clientes/%Wings%')),
    ).toHaveLength(0);

    // Something made by hand inside follows the rename too.
    const admin = await sessionFor('admin_master');
    const sent = await folderAt(admin, `${root}/Documentos Enviados`);
    await app.inject({
      method: 'POST',
      url: '/drive/folders',
      cookies: admin.cookies,
      payload: { parentId: sent.id, name: 'Alvarás' },
    });
    const count = (await paths()).length;
    await app.inject({
      method: 'PATCH',
      url: `/clients/${client.id}`,
      cookies: marketing.cookies,
      payload: { name: 'Aurora Pães' },
    });
    expect((await paths()).every((path) => path.startsWith('/Clientes/01. Aurora Pães'))).toBe(
      true,
    );
    expect(await paths()).toContain('/Clientes/01. Aurora Pães/Documentos Enviados/Alvarás');

    // The number is editable, and never repeated.
    const renumbered = await app.inject({
      method: 'PATCH',
      url: `/clients/${client.id}`,
      cookies: marketing.cookies,
      payload: { number: 7 },
    });
    expect(renumbered.json<{ client: Client }>().client.number).toBe(7);
    expect((await paths()).every((path) => path.startsWith('/Clientes/07. Aurora Pães'))).toBe(
      true,
    );
    const next = (
      await app.inject({
        method: 'POST',
        url: '/clients',
        cookies: marketing.cookies,
        payload: clientRegister('Sushi do Bairro'),
      })
    ).json<{ client: Client }>().client;
    expect(next.number).toBe(8);
    const clash = await app.inject({
      method: 'PATCH',
      url: `/clients/${next.id}`,
      cookies: marketing.cookies,
      payload: { number: 7 },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ error: 'number_taken' });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/clients/${next.id}`,
          cookies: marketing.cookies,
          payload: { number: 0 },
        })
      ).statusCode,
    ).toBe(400);
    expect(await paths()).toHaveLength(count);

    await app.inject({
      method: 'PATCH',
      url: `/clients/${client.id}`,
      cookies: marketing.cookies,
      payload: { active: false },
    });
    expect(await paths()).toHaveLength(count);
  });

  it('is edited by who manages the Drive, and "Sincronizar pastas" applies it', async () => {
    const admin = await sessionFor('admin_master');
    const marketing = await sessionFor('marketing');
    expect(
      (await app.inject({ url: '/drive/template', cookies: marketing.cookies })).statusCode,
    ).toBe(403);
    const nodes = (await app.inject({ url: '/drive/template', cookies: admin.cookies })).json<{
      nodes: { id: string; name: string; parentId: string | null; kind: string }[];
    }>().nodes;
    const comercial = nodes.find((node) => node.name === 'Comercial' && node.parentId === null);
    const added = await app.inject({
      method: 'POST',
      url: '/drive/template',
      cookies: admin.cookies,
      payload: { parentId: comercial?.id, name: 'Contratos Fechados' },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ node: { department: 'comercial', kind: 'folder' } });
    // A "Clientes" inside a "Clientes" is refused.
    const clientsNode = nodes.find((node) => node.kind === 'clients');
    // A folder of the client's tree has a function: it can be renamed, not taken out.
    const stageNode = nodes.find((node) => node.parentId === clientsNode?.id);
    const refused = await app.inject({
      method: 'DELETE',
      url: `/drive/template/${stageNode?.id}`,
      cookies: admin.cookies,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'folder_has_role' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/drive/template',
          cookies: admin.cookies,
          payload: { parentId: clientsNode?.id, name: 'Outros', kind: 'clients' },
        })
      ).statusCode,
    ).toBe(400);

    const synced = await app.inject({ method: 'POST', url: '/drive/sync', cookies: admin.cookies });
    expect(synced.json()).toMatchObject({ foldersCreated: 1 });
    const folder = await folderAt(admin, '/Comercial/Contratos Fechados');
    expect(folder.managed).toBe(true);
    // Again: nothing to do.
    expect(
      (await app.inject({ method: 'POST', url: '/drive/sync', cookies: admin.cookies })).json(),
    ).toMatchObject({ foldersCreated: 0, foldersRenamed: 0 });

    // Out of the model, the folder stays, as an ordinary one.
    const nodeId = added.json<{ node: { id: string } }>().node.id;
    await app.inject({
      method: 'DELETE',
      url: `/drive/template/${nodeId}`,
      cookies: admin.cookies,
    });
    expect((await folderAt(admin, '/Comercial/Contratos Fechados')).managed).toBe(false);
  });
});

describe('who sees what, decided by the server', () => {
  // Outside the client tree; the tree has a test of its own below.
  const accessible = (folders: DriveFolder[]) =>
    [
      ...new Set(
        folders
          .filter((folder) => folder.accessible && !folder.path.startsWith('/Clientes'))
          .map((f) => f.path.split('/').slice(0, 3).join('/')),
      ),
    ].sort();

  it.each([
    ['marketing', ['/Formatação/Marketing']],
    ['formatacao_juridico', ['/Formatação/Jurídico']],
    ['formatacao_financeiro', ['/Formatação/Financeiro']],
    ['formatacao_contabil_tributario', ['/Formatação/Financeiro']],
    ['formatacao_processos_projetos', ['/Formatação/Processos', '/Formatação/Projetos']],
    ['formatacao_logistica', ['/Formatação/Logística']],
    ['formatacao_ti', ['/Formatação/TI']],
    ['rh_dp', ['/Formatação/RH-DP', '/RH-DP', '/RH-DP/Contratos', '/RH-DP/Documentos']],
    ['gerente_comercial', ['/Comercial', '/Comercial/Propostas Comerciais']],
  ] as [RoleKey, string[]][])('%s works only in its own tree', async (role, expected) => {
    const session = await sessionFor(role);
    const folders = await tree(session);
    expect(accessible(folders).filter((path) => !path.includes('Contratos Fechados'))).toEqual(
      expected,
    );
    // The folders above are there to be walked through, and open nothing.
    const above = folders.filter((folder) => !folder.accessible);
    for (const folder of above) {
      expect(folder.canWrite).toBe(false);
      expect(
        (await app.inject({ url: `/drive/folders/${folder.id}`, cookies: session.cookies }))
          .statusCode,
      ).toBe(404);
    }
    // Nothing of another department is even listed.
    const other = role === 'formatacao_ti' ? '/Formatação/Jurídico' : '/Formatação/TI';
    expect(folders.some((folder) => folder.path.startsWith(other))).toBe(false);
  });

  const IMERSAO = ['01', '02', '03', 'entrega_01', 'entrega_02', 'entrega_03'];
  const ALL_SLOTS = ['client', ...DRIVE_FOLDER_SLOTS];
  it.each([
    // [role, what it reads, what it writes], by slot ('client' is the client's own folder).
    ['marketing', [...IMERSAO, '08', 'midia', 'entrega_08'], ['08', 'midia', 'entrega_08']],
    ['formatacao_juridico', [...IMERSAO, '06', 'entrega_06'], ['06', 'entrega_06']],
    ['formatacao_financeiro', [...IMERSAO, '04', 'entrega_04'], ['04', 'entrega_04']],
    ['formatacao_contabil_tributario', [...IMERSAO, '04', 'entrega_04'], ['04', 'entrega_04']],
    ['formatacao_logistica', IMERSAO, []],
    ['formatacao_ti', IMERSAO, []],
    ['rh_dp', IMERSAO, []],
    ['gerente_comercial', ['07', 'entrega_07'], ['07', 'entrega_07']],
    // Processos e Projetos sees the whole client and runs 01–03, 05 and the client's own folders.
    [
      'formatacao_processos_projetos',
      ALL_SLOTS,
      ['client', ...IMERSAO, '05', 'entrega_05', 'enviados', 'reunioes', 'entrega'],
    ],
  ] as [RoleKey, string[], string[]][])(
    'in a client’s tree, %s reads and writes exactly its folders',
    async (role, reads, writes) => {
      const admin = await sessionFor('admin_master');
      const created = await app.inject({
        method: 'POST',
        url: '/clients',
        cookies: admin.cookies,
        payload: clientRegister(`Cliente de ${role}`),
      });
      const clientId = created.json<{ client: Client }>().client.id;
      const session = await sessionFor(role);
      const mine = (await tree(session)).filter((folder) => folder.clientId === clientId);
      const slotOf = (folder: DriveFolder) => folder.slot ?? 'client';
      expect(
        mine
          .filter((folder) => folder.accessible)
          .map(slotOf)
          .sort(),
      ).toEqual([...reads].sort());
      expect(
        mine
          .filter((folder) => folder.canWrite)
          .map(slotOf)
          .sort(),
      ).toEqual([...writes].sort());

      // Read-only is enforced by the server, not only shown: an upload into 01 is refused.
      const imersao = mine.find((folder) => folder.slot === '01');
      if (imersao?.accessible && !imersao.canWrite) {
        const asked = await app.inject({
          method: 'POST',
          url: '/drive/uploads',
          cookies: session.cookies,
          payload: {
            folderId: imersao.id,
            name: 'a.pdf',
            mimeType: 'application/pdf',
            byteSize: 3,
          },
        });
        expect(asked.statusCode).toBe(403);
      }
      // A folder it does not read answers 404, like any other department's.
      const hidden = (await tree(admin)).find(
        (folder) => folder.clientId === clientId && !reads.includes(folder.slot ?? 'client'),
      );
      if (hidden) {
        expect(
          (await app.inject({ url: `/drive/folders/${hidden.id}`, cookies: session.cookies }))
            .statusCode,
        ).toBe(404);
      }
    },
  );

  it.each(['admin_master', 'diretoria'] as RoleKey[])('%s sees everything', async (role) => {
    const session = await sessionFor(role);
    const folders = await tree(session);
    expect(folders).toHaveLength((await db.select().from(driveFolders)).length);
    expect(folders.every((folder) => folder.accessible && folder.canWrite)).toBe(true);
  });

  it('answers "not found" for another department’s folder and file, by id, in search and in the trash', async () => {
    const admin = await sessionFor('admin_master');
    const marketing = await sessionFor('marketing');
    const legal = await folderAt(admin, '/Formatação/Jurídico');
    const { file } = await upload(admin, legal.id, 'Parecer sigiloso.pdf', Buffer.from('legal'));
    if (!file) throw new Error('expected a file');

    const as = (url: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', payload?: object) =>
      app.inject({ method, url, cookies: marketing.cookies, payload });
    expect((await as(`/drive/folders/${legal.id}`)).statusCode).toBe(404);
    expect((await as(`/drive/files/${file.id}/link`)).statusCode).toBe(404);
    expect((await as(`/drive/files/${file.id}/versions`)).statusCode).toBe(404);
    expect((await as(`/drive/files/${file.id}/trash`, 'POST')).statusCode).toBe(404);
    expect((await as(`/drive/files/${file.id}`, 'PATCH', { name: 'x.pdf' })).statusCode).toBe(404);
    expect(
      (
        await as('/drive/uploads', 'POST', {
          folderId: legal.id,
          name: 'a.pdf',
          mimeType: 'application/pdf',
          byteSize: 3,
        })
      ).statusCode,
    ).toBe(404);
    // Moving one of its own files INTO the other department is refused too.
    const own = await folderAt(marketing, '/Formatação/Marketing');
    const mine = (await upload(marketing, own.id, 'Briefing.pdf', Buffer.from('mkt'))).file;
    expect((await as(`/drive/files/${mine?.id}`, 'PATCH', { folderId: legal.id })).statusCode).toBe(
      404,
    );

    const found = (await as('/drive/search?q=sigiloso')).json<{ files: DriveFile[] }>().files;
    expect(found).toEqual([]);
    await app.inject({
      method: 'POST',
      url: `/drive/files/${file.id}/trash`,
      cookies: admin.cookies,
    });
    expect((await as('/drive/trash')).json<{ files: DriveFile[] }>().files).toEqual([]);
    // Diretoria finds it.
    const director = await sessionFor('diretoria');
    expect(
      (await app.inject({ url: '/drive/trash', cookies: director.cookies }))
        .json<{ files: DriveFile[] }>()
        .files.map((item) => item.id),
    ).toContain(file.id);
  });

  it('is closed without a login, and the model is closed to who does not manage it', async () => {
    expect((await app.inject({ url: '/drive/tree' })).statusCode).toBe(401);
    const seller = await sessionFor('vendedor_expansao');
    expect(
      (await app.inject({ method: 'POST', url: '/drive/sync', cookies: seller.cookies }))
        .statusCode,
    ).toBe(403);
    // Eric, 14/10: a seller has no Drive at all; their deals' files open through the deal.
    expect((await app.inject({ url: '/drive/tree', cookies: seller.cookies })).statusCode).toBe(
      403,
    );
  });
});

describe('files', () => {
  it('exist only after storage confirms them, and never show where they are kept', async () => {
    const marketing = await sessionFor('marketing');
    const folder = await folderAt(marketing, '/Formatação/Marketing');
    const bytes = Buffer.from('%PDF-1.7 proposal');

    // Asked for, and not sent: nothing exists.
    const asked = await app.inject({
      method: 'POST',
      url: '/drive/uploads',
      cookies: marketing.cookies,
      payload: {
        folderId: folder.id,
        name: 'Nunca enviado.pdf',
        mimeType: 'application/pdf',
        byteSize: 10,
      },
    });
    const orphan = asked.json<{ ticket: DriveUploadTicket }>().ticket;
    const early = await app.inject({
      method: 'POST',
      url: `/drive/uploads/${orphan.uploadId}/complete`,
      cookies: marketing.cookies,
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'upload_incomplete' });
    // The address takes the promised size and nothing else.
    const wrongSize = await app.inject({
      method: 'PUT',
      url: orphan.url.replace('http://localhost:5173/api', ''),
      headers: { 'content-type': 'application/pdf', 'content-length': '4' },
      payload: Buffer.from('abcd'),
    });
    expect(wrongSize.statusCode).toBe(403);

    const { file, ticket } = await upload(marketing, folder.id, 'Proposta Aurora.pdf', bytes);
    expect(file).toMatchObject({
      name: 'Proposta Aurora.pdf',
      byteSize: bytes.length,
      version: 1,
      folderPath: '/Formatação/Marketing',
    });
    // Somebody else cannot confirm it again, nor can it be confirmed twice.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/drive/uploads/${ticket?.uploadId}/complete`,
          cookies: marketing.cookies,
        })
      ).statusCode,
    ).toBe(404);

    const listed = await app.inject({
      url: `/drive/folders/${folder.id}`,
      cookies: marketing.cookies,
    });
    const [row] = await db
      .select()
      .from(driveFiles)
      .where(eq(driveFiles.id, file?.id ?? ''));
    expect(row?.storageKey).toMatch(/^drive\/\d{4}-\d{2}\/[0-9a-f-]{36}$/);
    expect(row?.checksum).toMatch(/^md5:[0-9a-f]{32}$/);
    for (const text of [listed.payload, JSON.stringify(file), JSON.stringify(ticket)]) {
      expect(text).not.toContain(row?.storageKey ?? 'x');
      expect(text).not.toContain(dir);
    }

    // A short address downloads it, with its own name.
    const link = await app.inject({
      url: `/drive/files/${file?.id}/link?disposition=inline`,
      cookies: marketing.cookies,
    });
    const { url, expiresAt } = link.json<{ url: string; expiresAt: string }>();
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const fetched = await app.inject({ url: url.replace('http://localhost:5173/api', '') });
    expect(fetched.rawPayload.equals(bytes)).toBe(true);
    expect(fetched.headers['content-disposition']).toContain(
      "filename*=UTF-8''Proposta%20Aurora.pdf",
    );
    expect(fetched.headers['content-type']).toBe('application/pdf');
    expect(fetched.headers['accept-ranges']).toBe('bytes');

    // A video seeks by byte range: the same link answers 206 with the slice asked for.
    const path = url.replace('http://localhost:5173/api', '');
    const slice = await app.inject({ url: path, headers: { range: 'bytes=1-2' } });
    expect(slice.statusCode).toBe(206);
    expect(slice.headers['content-range']).toBe(`bytes 1-2/${bytes.length}`);
    expect(slice.headers['content-length']).toBe('2');
    expect(slice.rawPayload.equals(bytes.subarray(1, 3))).toBe(true);
    const tail = await app.inject({ url: path, headers: { range: 'bytes=2-' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(bytes.subarray(2))).toBe(true);
    const beyond = await app.inject({ url: path, headers: { range: `bytes=${bytes.length}-` } });
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers['content-range']).toBe(`bytes */${bytes.length}`);
  });

  it('reads a Range header the way a browser writes one', () => {
    expect(byteRangeOf(undefined, 10)).toBeNull();
    expect(byteRangeOf('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(byteRangeOf('bytes=3-5', 10)).toEqual({ start: 3, end: 5 });
    expect(byteRangeOf('bytes=3-50', 10)).toEqual({ start: 3, end: 9 });
    expect(byteRangeOf('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
    expect(byteRangeOf('bytes=10-', 10)).toBe('unsatisfiable');
    expect(byteRangeOf('bytes=5-3', 10)).toBe('unsatisfiable');
    expect(byteRangeOf('items=1-2', 10)).toBeNull();
  });

  it('refuses a file over the limit, and a name already in the folder unless it is a replacement', async () => {
    const marketing = await sessionFor('marketing');
    const folder = await folderAt(marketing, '/Formatação/Marketing/Mídia');
    const big = await upload(marketing, folder.id, 'Grande.pdf', Buffer.alloc(1001));
    expect(big.asked.statusCode).toBe(413);
    expect(big.asked.json()).toMatchObject({ error: 'too_large', maxFileBytes: 1000 });

    const first = await upload(marketing, folder.id, 'Logo.pdf', Buffer.from('v1'));
    const again = await upload(marketing, folder.id, 'LOGO.pdf', Buffer.from('v2'));
    expect(again.asked.statusCode).toBe(409);
    expect(again.asked.json()).toMatchObject({
      error: 'name_taken',
      existingFileId: first.file?.id,
    });

    // Replacing keeps what was there as a version.
    const replaced = await upload(marketing, folder.id, 'Logo.pdf', Buffer.from('version two'), {
      replaceFileId: first.file?.id,
    });
    expect(replaced.file).toMatchObject({ id: first.file?.id, version: 2, byteSize: 11 });
    const versions = await app.inject({
      url: `/drive/files/${first.file?.id}/versions`,
      cookies: marketing.cookies,
    });
    expect(versions.json()).toMatchObject({ versions: [{ version: 1, byteSize: 2 }] });
    const old = await app.inject({
      url: `/drive/files/${first.file?.id}/link?version=1`,
      cookies: marketing.cookies,
    });
    const body = await app.inject({
      url: old.json<{ url: string }>().url.replace('http://localhost:5173/api', ''),
    });
    expect(body.payload).toBe('v1');
  });

  it('renames, tags and moves; trashes, restores, and empties after thirty days', async () => {
    const marketing = await sessionFor('marketing');
    const admin = await sessionFor('admin_master');
    const root = await folderAt(marketing, '/Formatação/Marketing');
    const made = await app.inject({
      method: 'POST',
      url: '/drive/folders',
      cookies: marketing.cookies,
      payload: { parentId: root.id, name: 'Campanha RJ' },
    });
    const campaign = made.json<{ folder: DriveFolder }>().folder;
    expect(campaign).toMatchObject({ path: '/Formatação/Marketing/Campanha RJ', managed: false });
    // The model's folders are kept by the system.
    const managed = await app.inject({
      method: 'PATCH',
      url: `/drive/folders/${root.id}`,
      cookies: marketing.cookies,
      payload: { name: 'Mkt' },
    });
    expect(managed.json()).toMatchObject({ error: 'managed_folder' });

    const { file } = await upload(marketing, root.id, 'Roteiro.pdf', Buffer.from('script'));
    const moved = await app.inject({
      method: 'PATCH',
      url: `/drive/files/${file?.id}`,
      cookies: marketing.cookies,
      payload: { folderId: campaign.id, name: 'Roteiro final.pdf', tags: ['RJ', 'rj', 'Reels'] },
    });
    expect(moved.json<{ file: DriveFile }>().file).toMatchObject({
      folderId: campaign.id,
      name: 'Roteiro final.pdf',
      tags: ['rj', 'reels'],
    });
    const byTag = await app.inject({ url: '/drive/search?tag=reels', cookies: marketing.cookies });
    expect(byTag.json<{ files: DriveFile[] }>().files.map((item) => item.id)).toEqual([file?.id]);

    // A folder with something in it is not deleted; in the trash still counts.
    await app.inject({
      method: 'POST',
      url: `/drive/files/${file?.id}/trash`,
      cookies: marketing.cookies,
    });
    const remove = () =>
      app.inject({
        method: 'DELETE',
        url: `/drive/folders/${campaign.id}`,
        cookies: marketing.cookies,
      });
    expect((await remove()).json()).toMatchObject({ error: 'folder_not_empty' });
    const listed = await app.inject({
      url: `/drive/folders/${campaign.id}`,
      cookies: marketing.cookies,
    });
    expect(listed.json<{ files: DriveFile[] }>().files).toEqual([]);

    const restored = await app.inject({
      method: 'POST',
      url: `/drive/files/${file?.id}/restore`,
      cookies: marketing.cookies,
    });
    expect(restored.json<{ file: DriveFile }>().file.trashedAt).toBeNull();

    // Emptying by hand is for who manages; after thirty days it happens by itself.
    await app.inject({
      method: 'POST',
      url: `/drive/files/${file?.id}/trash`,
      cookies: marketing.cookies,
    });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/drive/files/${file?.id}`,
          cookies: marketing.cookies,
        })
      ).statusCode,
    ).toBe(403);
    const [row] = await db
      .select()
      .from(driveFiles)
      .where(eq(driveFiles.id, file?.id ?? ''));
    const month = row?.storageKey.split('/')[1] ?? '';
    const stored = row?.storageKey.split('/')[2] ?? '';
    expect(await readdir(join(dir, 'drive', month))).toContain(stored);
    await db
      .update(driveFiles)
      .set({ trashedAt: new Date(Date.now() - 31 * 24 * 3600_000) })
      .where(eq(driveFiles.id, file?.id ?? ''));
    const trash = await app.inject({ url: '/drive/trash', cookies: admin.cookies });
    expect(trash.json<{ files: DriveFile[] }>().files.some((item) => item.id === file?.id)).toBe(
      false,
    );
    expect(await readdir(join(dir, 'drive', month))).not.toContain(stored);
    expect((await remove()).statusCode).toBe(204);
  });

  it('leaves every operation on the audit trail, by id and never by file name', async () => {
    const marketing = await sessionFor('marketing');
    const folder = await folderAt(marketing, '/Formatação/Marketing');
    const { file } = await upload(
      marketing,
      folder.id,
      'Contrato João da Silva.pdf',
      Buffer.from('x'),
    );
    await app.inject({ url: `/drive/files/${file?.id}/link`, cookies: marketing.cookies });
    await app.inject({
      method: 'PATCH',
      url: `/drive/files/${file?.id}`,
      cookies: marketing.cookies,
      payload: { name: 'Contrato Maria.pdf' },
    });
    await app.inject({
      method: 'POST',
      url: `/drive/files/${file?.id}/trash`,
      cookies: marketing.cookies,
    });
    const trail = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.actorEmployeeId, marketing.employeeId), like(auditLog.action, 'drive.%')),
      );
    expect(trail.map((row) => row.action).sort()).toEqual([
      'drive.file_downloaded',
      'drive.file_trashed',
      'drive.file_updated',
      'drive.file_uploaded',
      'drive.upload_requested',
    ]);
    expect(JSON.stringify(trail.map((row) => row.metadata))).not.toMatch(/João|Maria|Contrato/);
  });
});

describe('with R2 configured', () => {
  it('hands the browser a pre-signed R2 address, never receives the bytes, and confirms with a HEAD', async () => {
    const objects = new Map<string, number>();
    const seen: string[] = [];
    const bucket: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      seen.push(`${init?.method} ${url.pathname}`);
      const size = objects.get(url.pathname);
      return size === undefined
        ? new Response(null, { status: 404 })
        : new Response(null, {
            status: 200,
            headers: { 'content-length': String(size), etag: '"e1"' },
          });
    };
    const r2 = await buildApp({
      env: envOf({
        R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
        R2_BUCKET: 'wings-staging',
        R2_ACCESS_KEY_ID: 'AKID',
        R2_SECRET_ACCESS_KEY: 'r2-secret-never-shown',
      }),
      db,
      storageFetch: bucket,
    });
    try {
      const marketing = await sessionFor('marketing', r2);
      const folder = await folderAt(marketing, '/Formatação/Marketing');
      const asked = await r2.inject({
        method: 'POST',
        url: '/drive/uploads',
        cookies: marketing.cookies,
        payload: { folderId: folder.id, name: 'Video.mp4', mimeType: 'video/mp4', byteSize: 900 },
      });
      const { ticket } = asked.json<{ ticket: DriveUploadTicket }>();
      const address = new URL(ticket.url);
      expect(address.origin).toBe('https://acct.r2.cloudflarestorage.com');
      expect(address.pathname).toMatch(/^\/wings-staging\/drive\/\d{4}-\d{2}\/[0-9a-f-]{36}$/);
      expect(address.searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;content-type;host',
      );
      expect(asked.payload).not.toContain('r2-secret-never-shown');
      // With R2 there is no route of ours that takes the bytes.
      expect(
        (await r2.inject({ method: 'PUT', url: '/drive/blob?t=anything-at-all-here-to-try' }))
          .statusCode,
      ).toBe(404);

      const complete = () =>
        r2.inject({
          method: 'POST',
          url: `/drive/uploads/${ticket.uploadId}/complete`,
          cookies: marketing.cookies,
        });
      expect((await complete()).json()).toMatchObject({ error: 'upload_incomplete' });
      objects.set(address.pathname, 900); // the browser's PUT arrived
      const done = await complete();
      expect(done.statusCode).toBe(201);
      expect(done.json()).toMatchObject({ file: { name: 'Video.mp4', byteSize: 900 } });
      expect(seen.every((call) => call.startsWith('HEAD '))).toBe(true);

      const link = await r2.inject({
        url: `/drive/files/${done.json<{ file: DriveFile }>().file.id}/link?disposition=inline`,
        cookies: marketing.cookies,
      });
      const url = new URL(link.json<{ url: string }>().url);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('response-content-disposition')).toContain('inline');
    } finally {
      await r2.close();
    }
  });
});
