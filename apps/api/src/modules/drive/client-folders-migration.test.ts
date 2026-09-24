import { DRIVE_MEDIA_FOLDER, type DriveDepartment, type DriveTemplateSeed } from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  clients,
  driveFiles,
  driveFolders,
  driveTemplateNodes,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { ClientFolderMigrationBlocked, migrateClientFolders } from './client-folders-migration.js';
import { mediaFolderFor, syncDriveFolders, writeTemplateNodes } from './folders.js';

/**
 * The model as it was until 2026-09-24: "Clientes/<Cliente>" inside every
 * department, plus the dossier under Formatação. The test puts a database in
 * that state, with files, and moves it.
 */
const clientsOf = (department: DriveDepartment, children: DriveTemplateSeed[] = []) => ({
  name: 'Clientes',
  department,
  clients: true,
  children,
});
const area = (name: string, department: DriveDepartment): DriveTemplateSeed => ({
  name,
  department,
  children: [clientsOf(department)],
});
const OLD_SEED: DriveTemplateSeed[] = [
  {
    name: 'Formatação',
    department: 'formatacao',
    children: [
      {
        name: 'Marketing',
        department: 'marketing',
        children: [
          { name: DRIVE_MEDIA_FOLDER, department: 'marketing' },
          clientsOf('marketing', [{ name: DRIVE_MEDIA_FOLDER, department: 'marketing' }]),
        ],
      },
      area('Jurídico', 'juridico'),
      area('Logística', 'logistica'),
      clientsOf('formatacao', [
        { name: 'Reuniões', department: 'formatacao' },
        { name: 'Documentos', department: 'formatacao' },
        { name: 'Contrato', department: 'formatacao' },
        { name: 'Propostas', department: 'formatacao' },
        { name: DRIVE_MEDIA_FOLDER, department: 'formatacao' },
      ]),
    ],
  },
  { name: 'Comercial', department: 'comercial', children: [clientsOf('comercial')] },
];

let harness: TestDatabase;
let db: Database;
let ownerId: string;
let aurora: string;
let closed: string;
const files: Record<string, string> = {};

async function folder(path: string) {
  const [row] = await db.select().from(driveFolders).where(eq(driveFolders.path, path));
  if (!row) throw new Error(`no folder at ${path}`);
  return row;
}

async function putFile(path: string, name: string, clientId: string | null = null) {
  const [row] = await db
    .insert(driveFiles)
    .values({
      folderId: (await folder(path)).id,
      name,
      mimeType: 'application/pdf',
      byteSize: 3,
      storageKey: `drive/2026-09/${name}`,
      ownerId,
      clientId,
    })
    .returning();
  if (!row) throw new Error('insert failed');
  return row.id;
}

async function placeOf(fileId: string) {
  const [row] = await db
    .select({ path: driveFolders.path, name: driveFiles.name, key: driveFiles.storageKey })
    .from(driveFiles)
    .innerJoin(driveFolders, eq(driveFolders.id, driveFiles.folderId))
    .where(eq(driveFiles.id, fileId));
  return row;
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  ownerId = (await createEmployee(db, { role: 'admin_master', sector: 'diretoria' })).id;
  // Back to the old model: the seed wrote the new one, so it is replaced wholesale.
  await db.delete(driveFolders);
  await db.delete(driveTemplateNodes);
  await writeTemplateNodes(db, OLD_SEED, null);
  const [a] = await db
    .insert(clients)
    .values({ name: 'Padaria Aurora', slug: 'padaria-aurora', number: 3 })
    .returning();
  const [b] = await db
    .insert(clients)
    .values({ name: 'Loja Fechada', slug: 'loja-fechada', number: 4, active: true })
    .returning();
  if (!a || !b) throw new Error('clients');
  aurora = a.id;
  closed = b.id;
  await syncDriveFolders(db);
  // A client switched off later keeps its old folders, and gets no new tree.
  await db.update(clients).set({ active: false }).where(eq(clients.id, closed));

  files.media = await putFile('/Formatação/Marketing/Clientes/03. Padaria Aurora/Mídia', 'arte.png', aurora);
  files.legal = await putFile('/Formatação/Jurídico/Clientes/03. Padaria Aurora', 'parecer.pdf');
  // A folder somebody made by hand, inside the old client folder.
  const [manual] = await db
    .insert(driveFolders)
    .values({
      parentId: (await folder('/Formatação/Jurídico/Clientes/03. Padaria Aurora')).id,
      name: 'Pareceres 2026',
      path: '/Formatação/Jurídico/Clientes/03. Padaria Aurora/Pareceres 2026',
      department: 'juridico',
      clientId: aurora,
      origin: 'manual',
    })
    .returning();
  if (!manual) throw new Error('manual folder');
  files.nested = await putFile(manual.path, 'marcas.pdf');
  files.logistics = await putFile('/Formatação/Logística/Clientes/03. Padaria Aurora', 'rotas.pdf');
  files.document = await putFile('/Formatação/Clientes/03. Padaria Aurora/Documentos', 'cnpj.pdf');
  files.contract = await putFile('/Formatação/Clientes/03. Padaria Aurora/Contrato', 'contrato.pdf');
  files.proposal = await putFile('/Formatação/Clientes/03. Padaria Aurora/Propostas', 'proposta.pdf');
  // Same name, landing in the same place (07 Comercial): nothing may be overwritten.
  files.proposalToo = await putFile('/Comercial/Clientes/03. Padaria Aurora', 'proposta.pdf');
  files.closed = await putFile('/Formatação/Jurídico/Clientes/04. Loja Fechada', 'distrato.pdf');
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

describe('moving the Drive to Clientes/<NN. Nome>', () => {
  it('simulates without writing anything, and says what it would do', async () => {
    const nodesBefore = await db.select().from(driveTemplateNodes);
    const foldersBefore = await db.select().from(driveFolders);
    const legalBefore = await placeOf(files.legal as string);

    const report = await migrateClientFolders(db, { apply: false });
    expect(report.applied).toBe(false);
    expect(report.templateChanged).toBe(true);
    // Five old "Clientes" nodes, two clients.
    expect(report.oldClientFolders).toBe(10);
    expect(report.moves).toHaveLength(8);
    expect(report.left).toEqual([
      expect.objectContaining({ fileId: files.closed, reason: 'o cliente está inativo e não tem a pasta nova' }),
    ]);

    expect(await db.select().from(driveTemplateNodes)).toHaveLength(nodesBefore.length);
    expect(await db.select().from(driveFolders)).toHaveLength(foldersBefore.length);
    expect(await placeOf(files.legal as string)).toEqual(legalBefore);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'drive.file_migrated'));
    expect(audits).toHaveLength(0);
  });

  it('stops without writing anything while an old folder still holds a file', async () => {
    const simulated = await migrateClientFolders(db, { apply: false });
    expect(simulated.blockedBy).toEqual([
      '/Formatação/Jurídico/Clientes',
      '/Formatação/Jurídico/Clientes/04. Loja Fechada',
    ]);
    const before = await db.select().from(driveFolders);
    const error = await migrateClientFolders(db, { apply: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClientFolderMigrationBlocked);
    expect((error as Error).message).toContain('/Formatação/Jurídico/Clientes/04. Loja Fechada');
    expect(await db.select().from(driveFolders)).toHaveLength(before.length);
    expect((await placeOf(files.legal as string))?.path).toBe('/Formatação/Jurídico/Clientes/03. Padaria Aurora');
  });

  it('applies: new tree, every file in its folder, nothing lost, the emptied old folders deleted', async () => {
    // What a person does after the stop: the client comes back, so its file has a place.
    await db.update(clients).set({ active: true }).where(eq(clients.id, closed));
    const report = await migrateClientFolders(db, { apply: true });
    expect(report.applied).toBe(true);
    expect(report.blockedBy).toEqual([]);
    expect(report.moves).toHaveLength(9);
    const root = '/Clientes/03. Padaria Aurora';
    expect(await placeOf(files.media as string)).toMatchObject({ path: `${root}/08 Marketing/Mídia` });
    expect(await placeOf(files.legal as string)).toMatchObject({ path: `${root}/06 Jurídico` });
    // The sub-folder made by hand comes along.
    expect(await placeOf(files.nested as string)).toMatchObject({
      path: `${root}/06 Jurídico/Pareceres 2026`,
    });
    // An area with no stage of its own lands in 05 Operacional, under its name.
    expect(await placeOf(files.logistics as string)).toMatchObject({
      path: `${root}/05 Operacional/Logística`,
    });
    expect(await placeOf(files.document as string)).toMatchObject({ path: `${root}/Documentos Enviados` });
    expect(await placeOf(files.contract as string)).toMatchObject({ path: `${root}/06 Jurídico` });
    const proposals = [await placeOf(files.proposal as string), await placeOf(files.proposalToo as string)];
    expect(proposals.map((row) => row?.path)).toEqual([`${root}/07 Comercial`, `${root}/07 Comercial`]);
    expect(proposals.map((row) => row?.name).sort()).toEqual(['proposta (migrado).pdf', 'proposta.pdf']);
    expect(await placeOf(files.closed as string)).toMatchObject({
      path: '/Clientes/04. Loja Fechada/06 Jurídico',
    });
    // Bytes stay where they are: only the folder changes.
    expect((await placeOf(files.legal as string))?.key).toBe('drive/2026-09/parecer.pdf');

    // Moved files belong to the client, and the manual sub-folder to the stage's department.
    const [nestedFolder] = await db
      .select()
      .from(driveFolders)
      .where(eq(driveFolders.path, `${root}/06 Jurídico/Pareceres 2026`));
    expect(nestedFolder).toMatchObject({ department: 'juridico', clientId: aurora, origin: 'manual' });
    const [legalRow] = await db.select().from(driveFiles).where(eq(driveFiles.id, files.legal as string));
    expect(legalRow?.clientId).toBe(aurora);

    // The model is the new one.
    const nodes = await db.select().from(driveTemplateNodes);
    expect(nodes.filter((node) => node.kind === 'clients')).toEqual([
      expect.objectContaining({ parentId: null, name: 'Clientes', department: 'clientes' }),
    ]);
    // The old layout is gone: every folder it made, and the hand-made one inside, now empty.
    const remaining = (await db.select().from(driveFolders)).map((folder) => folder.path);
    expect(remaining.filter((path) => /\/Clientes/.test(path) && !path.startsWith('/Clientes'))).toEqual([]);
    // Every folder the old nodes made (27), plus the one made by hand inside.
    expect(report.oldFolders).toHaveLength(27);
    expect(report.foldersDeleted).toBe(28);
    const deleted = await db.select().from(auditLog).where(eq(auditLog.action, 'drive.folder_deleted'));
    expect(deleted).toHaveLength(report.foldersDeleted);
    // Every move is on the audit trail, by id.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'drive.file_migrated'));
    expect(audits).toHaveLength(9);
    expect(JSON.stringify(audits.map((row) => row.metadata))).not.toContain('.pdf');
    // The media library of the client is the new folder.
    expect((await mediaFolderFor(db, aurora))?.path).toBe(`${root}/08 Marketing/Mídia`);
    const [count] = await db
      .execute<{ n: number }>(sql`select count(*)::int as n from drive_files`)
      .then((result) => result.rows);
    expect(count?.n).toBe(9);
  });

  it('runs again without doing anything', async () => {
    const report = await migrateClientFolders(db, { apply: true });
    expect(report).toMatchObject({ templateChanged: false, oldClientFolders: 0, moves: [], foldersCreated: 0 });
  });
});
