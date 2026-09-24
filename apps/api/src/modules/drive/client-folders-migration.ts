import {
  DRIVE_CLIENTS_ROOT,
  DRIVE_DEPARTMENTS,
  WINGS_CLIENT_ID,
  type DriveDepartment,
  type DriveFolderSlot,
} from '@wings/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { auditLog, driveFiles, driveFolders, driveTemplateNodes } from '../../db/schema/index.js';
import { syncDriveFolders, writeTemplateNodes } from './folders.js';

/**
 * Moves the Drive from "Clientes/<Cliente> inside every department, plus the
 * dossier" to one top-level `Clientes/<NN. Nome>/…` tree (decision of
 * 2026-09-24). Four steps, in one transaction:
 *
 *  1. the model: the old per-department "Clientes" nodes and the dossier go,
 *     the new `Clientes` root comes in (DRIVE_CLIENTS_ROOT);
 *  2. the folders the old nodes made become ordinary folders, where they are;
 *  3. the sync makes every active client's new tree;
 *  4. every file inside an old client folder moves to the matching folder of
 *     the new tree (only `folder_id` changes: the bytes stay where they are),
 *     keeping the sub-folders a person made by hand.
 *
 * No file is ever deleted. The old folders, once empty, are deleted with the
 * folders inside them (decision of 2026-09-24). If one still holds a file (its
 * client is inactive, so it has no new tree) or an unconfirmed upload,
 * `apply: true` stops and writes nothing: the person decides what to do with
 * it first. `apply: false` runs everything and rolls it back: the report is
 * what `apply: true` would do.
 */

export interface ClientFolderMigrationReport {
  applied: boolean;
  /** False when the model was already the new one: nothing to change there. */
  templateChanged: boolean;
  nodesRemoved: number;
  nodesAdded: number;
  foldersCreated: number;
  foldersRenamed: number;
  oldClientFolders: number;
  /** Every folder the old nodes made; the empty ones (with what is inside them) are deleted. */
  oldFolders: { path: string; empty: boolean }[];
  foldersDeleted: number;
  /** Old folders still holding a file: `apply` stops, and nothing is written. */
  blockedBy: string[];
  clients: { id: string; number: number | null; folder: string | null; active: boolean }[];
  moves: { fileId: string; from: string; to: string; renamed: boolean; trashed: boolean }[];
  left: { fileId: string; from: string; reason: string }[];
  /** Areas whose old client files land in a folder of another department. */
  accessNotes: string[];
}

class Rollback extends Error {
  constructor(readonly report: ClientFolderMigrationReport) {
    super('dry run');
  }
}

/** `apply` found old folders still holding files: everything was rolled back. */
export class ClientFolderMigrationBlocked extends Error {
  constructor(readonly report: ClientFolderMigrationReport) {
    super(
      `parado sem gravar nada: ${report.blockedBy.length} pasta(s) antiga(s) ainda têm arquivos: ${report.blockedBy.join(', ')}`,
    );
    this.name = 'ClientFolderMigrationBlocked';
  }
}
const Blocked = ClientFolderMigrationBlocked;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type NodeRow = typeof driveTemplateNodes.$inferSelect;
type FolderRow = typeof driveFolders.$inferSelect;

/** Where a department's old client folder goes in the new tree. */
const AREA_TARGET: Record<string, { slot: DriveFolderSlot; subfolder?: string }> = {
  marketing: { slot: '08' },
  juridico: { slot: '06' },
  financeiro: { slot: '04' },
  comercial: { slot: '07' },
  processos: { slot: '05' },
  projetos: { slot: '05' },
  producao: { slot: '05', subfolder: 'Produção' },
  logistica: { slot: '05', subfolder: 'Logística' },
  ti: { slot: '05', subfolder: 'TI' },
  rh_dp: { slot: '05', subfolder: 'RH-DP' },
};

/** Inside an old client folder, a named child goes to its own slot (Mídia, and the dossier's). */
const CHILD_TARGET: Record<string, DriveFolderSlot> = {
  mídia: 'midia',
  midia: 'midia',
  reuniões: 'reunioes',
  reunioes: 'reunioes',
  documentos: 'enviados',
  contrato: '06',
  propostas: '07',
};

const lower = (text: string) => text.trim().toLowerCase();

export async function migrateClientFolders(
  db: Database,
  options: { apply: boolean },
): Promise<ClientFolderMigrationReport> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(7301, 1)`);
      const report = await migrate(tx);
      if (!options.apply) throw new Rollback(report);
      if (report.blockedBy.length > 0) throw new Blocked(report);
      return { ...report, applied: true };
    });
  } catch (error) {
    if (error instanceof Rollback) return { ...error.report, applied: false };
    throw error;
  }
}

async function migrate(tx: Tx): Promise<ClientFolderMigrationReport> {
  const report: ClientFolderMigrationReport = {
    applied: false,
    templateChanged: false,
    nodesRemoved: 0,
    nodesAdded: 0,
    foldersCreated: 0,
    foldersRenamed: 0,
    oldClientFolders: 0,
    oldFolders: [],
    foldersDeleted: 0,
    blockedBy: [],
    clients: [],
    moves: [],
    left: [],
    accessNotes: [],
  };

  const nodes = await tx.select().from(driveTemplateNodes);
  const childrenOf = (id: string | null) => nodes.filter((node) => node.parentId === id);
  const isNewRoot = (node: NodeRow) =>
    node.parentId === null && node.kind === 'clients' && childrenOf(node.id).some((child) => child.slot === '01');
  const oldClientNodes = nodes.filter((node) => node.kind === 'clients' && !isNewRoot(node));
  const hasNewRoot = nodes.some(isNewRoot);

  // --- what the old client folders hold, read before the model changes ------------
  const folders = await tx.select().from(driveFolders);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const oldNodeIds = new Set<string>();
  const collect = (node: NodeRow) => {
    oldNodeIds.add(node.id);
    for (const child of childrenOf(node.id)) collect(child);
  };
  oldClientNodes.forEach(collect);

  const oldClientFolders = folders.filter(
    (folder) =>
      folder.origin === 'client' &&
      folder.templateNodeId !== null &&
      oldClientNodes.some((node) => node.id === folder.templateNodeId) &&
      folder.clientId !== null &&
      folder.clientId !== WINGS_CLIENT_ID,
  );
  report.oldClientFolders = oldClientFolders.length;

  interface Planned {
    clientId: string;
    root: FolderRow;
    /** Department of the old "Clientes" node the folder came from. */
    area: string;
  }
  const planned: Planned[] = oldClientFolders.map((root) => ({
    clientId: root.clientId as string,
    root,
    area: nodes.find((node) => node.id === root.templateNodeId)?.department ?? 'formatacao',
  }));

  // --- 1 and 2: the model ------------------------------------------------------------
  if (oldClientNodes.length > 0 || !hasNewRoot) {
    report.templateChanged = true;
    if (oldNodeIds.size > 0) {
      const ids = [...oldNodeIds];
      await tx
        .update(driveFolders)
        .set({ origin: 'manual', templateNodeId: null, slot: null })
        .where(inArray(driveFolders.templateNodeId, ids));
      // Deepest first: a node's children go before it.
      const depth = (node: NodeRow): number =>
        node.parentId && oldNodeIds.has(node.parentId)
          ? 1 + depth(nodes.find((item) => item.id === node.parentId) as NodeRow)
          : 0;
      const ordered = nodes.filter((node) => oldNodeIds.has(node.id)).sort((a, b) => depth(b) - depth(a));
      for (const node of ordered) {
        await tx.delete(driveTemplateNodes).where(eq(driveTemplateNodes.id, node.id));
      }
      report.nodesRemoved = ordered.length;
    }
    if (!hasNewRoot) {
      const before = (await tx.select({ id: driveTemplateNodes.id }).from(driveTemplateNodes)).length;
      await writeTemplateNodes(tx, [DRIVE_CLIENTS_ROOT], null, childrenOf(null).filter((n) => !oldNodeIds.has(n.id)).length);
      report.nodesAdded =
        (await tx.select({ id: driveTemplateNodes.id }).from(driveTemplateNodes)).length - before;
    }
  }

  // --- 3: the new trees ----------------------------------------------------------------
  const synced = await syncDriveFolders(tx);
  report.foldersCreated += synced.foldersCreated;
  report.foldersRenamed += synced.foldersRenamed;

  const current = await tx.select().from(driveFolders).orderBy(asc(driveFolders.path));
  const slotFolder = (clientId: string, slot: DriveFolderSlot) =>
    current.find((folder) => folder.clientId === clientId && folder.slot === slot && folder.origin === 'client_child');

  const clientRows = await tx.execute<{ id: string; number: number | null; active: boolean }>(
    sql`select id, number, active from clients where id <> ${WINGS_CLIENT_ID} order by number nulls last`,
  );
  for (const client of clientRows.rows) {
    const folder = current.find((item) => item.clientId === client.id && item.origin === 'client');
    report.clients.push({ id: client.id, number: client.number, folder: folder?.path ?? null, active: client.active });
  }

  // --- 4: the files ----------------------------------------------------------------------
  /** A manual sub-folder under `parent`, made if missing. */
  async function subfolder(parent: FolderRow, name: string): Promise<FolderRow> {
    const existing = current.find(
      (folder) => folder.parentId === parent.id && lower(folder.name) === lower(name),
    );
    if (existing) return existing;
    const [made] = await tx
      .insert(driveFolders)
      .values({
        parentId: parent.id,
        name,
        path: `${parent.path}/${name}`,
        department: parent.department,
        clientId: parent.clientId,
        origin: 'manual',
      })
      .returning();
    if (!made) throw new Error('failed to create a sub-folder');
    current.push(made);
    report.foldersCreated += 1;
    return made;
  }

  const notedAreas = new Set<string>();
  for (const plan of planned) {
    const area = AREA_TARGET[plan.area];
    // Every folder of this old client tree, with the path of names below the root.
    const tree = folders.filter(
      (folder) => folder.id === plan.root.id || folder.path.startsWith(`${plan.root.path}/`),
    );
    const files = tree.length
      ? await tx.select().from(driveFiles).where(inArray(driveFiles.folderId, tree.map((folder) => folder.id)))
      : [];
    for (const file of files) {
      const from = byId.get(file.folderId) as FolderRow;
      const below = from.path.slice(plan.root.path.length).split('/').filter(Boolean);

      // Which slot: the dossier and the named children decide by name; the rest by area.
      let slot: DriveFolderSlot | null = null;
      let rest = below;
      const first = below[0] ? CHILD_TARGET[lower(below[0])] : undefined;
      if (first && (plan.area === 'formatacao' || first === 'midia')) {
        slot = first;
        rest = below.slice(1);
      } else if (plan.area === 'formatacao') {
        slot = 'enviados';
      } else if (area) {
        slot = area.slot;
        rest = area.subfolder ? [area.subfolder, ...below] : below;
      }
      let target = slot ? slotFolder(plan.clientId, slot) : undefined;
      if (!slot || !target) {
        report.left.push({
          fileId: file.id,
          from: from.path,
          reason: !slot
            ? `a área "${plan.area}" não tem pasta correspondente`
            : 'o cliente está inativo e não tem a pasta nova',
        });
        continue;
      }
      for (const name of rest) target = await subfolder(target, name);

      const targetDepartment = target.department;
      if (targetDepartment !== plan.area && plan.area !== 'formatacao' && !notedAreas.has(plan.area)) {
        notedAreas.add(plan.area);
        report.accessNotes.push(
          `Arquivos de clientes de ${DRIVE_DEPARTMENTS[plan.area as DriveDepartment] ?? plan.area} vão para ${target.path.split('/').slice(3).join('/') || target.name}, que é de ${DRIVE_DEPARTMENTS[targetDepartment as DriveDepartment] ?? targetDepartment}: quem é só de ${DRIVE_DEPARTMENTS[plan.area as DriveDepartment] ?? plan.area} deixa de vê-los.`,
        );
      }

      // Same name in the destination: the moved one takes a suffix; nothing is overwritten.
      let name = file.name;
      const taken = async (candidate: string) =>
        (
          await tx
            .select({ id: driveFiles.id })
            .from(driveFiles)
            .where(and(eq(driveFiles.folderId, target.id), eq(driveFiles.name, candidate), isNull(driveFiles.trashedAt)))
            .limit(1)
        ).length > 0;
      if (!file.trashedAt) {
        for (let attempt = 1; await taken(name); attempt += 1) {
          const dot = file.name.lastIndexOf('.');
          const [stem, extension] = dot > 0 ? [file.name.slice(0, dot), file.name.slice(dot)] : [file.name, ''];
          name = `${stem} (migrado${attempt > 1 ? ` ${attempt}` : ''})${extension}`;
        }
      }
      await tx
        .update(driveFiles)
        .set({ folderId: target.id, clientId: plan.clientId, name, updatedAt: new Date() })
        .where(eq(driveFiles.id, file.id));
      // By id, never by name (docs/drive.md).
      await tx.insert(auditLog).values({
        action: 'drive.file_migrated',
        entity: 'drive_file',
        entityId: file.id,
        metadata: { fromFolderId: from.id, toFolderId: target.id, renamed: name !== file.name },
      });
      report.moves.push({
        fileId: file.id,
        from: from.path,
        to: target.path,
        renamed: name !== file.name,
        trashed: file.trashedAt !== null,
      });
    }
  }

  // Sub-folders made above take their department and client from the new tree.
  const again = await syncDriveFolders(tx);
  report.foldersCreated += again.foldersCreated;
  report.foldersRenamed += again.foldersRenamed;

  // What the old model leaves behind (decision of 2026-09-24): empty folders go; if any
  // still holds a file (or an upload waiting to be confirmed), the whole migration stops.
  const oldRoots = folders.filter(
    (folder) => folder.templateNodeId !== null && oldNodeIds.has(folder.templateNodeId),
  );
  if (oldRoots.length > 0) {
    const all = await tx.select().from(driveFolders);
    const under = (root: FolderRow) =>
      all.filter((folder) => folder.id === root.id || folder.path.startsWith(`${root.path}/`));
    const doomed = new Map<string, FolderRow>();
    for (const root of oldRoots) for (const folder of under(root)) doomed.set(folder.id, folder);
    const ids = [...doomed.keys()];
    const holding = await tx.execute<{ folder_id: string }>(sql`
      select folder_id from drive_files where folder_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      union
      select folder_id from drive_uploads where folder_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    const busy = new Set(holding.rows.map((row) => row.folder_id));
    const occupied = (folder: FolderRow) => under(folder).some((item) => busy.has(item.id));
    report.oldFolders = oldRoots
      .map((folder) => ({ path: folder.path, empty: !occupied(folder) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    report.blockedBy = report.oldFolders.filter((folder) => !folder.empty).map((folder) => folder.path);
    if (report.blockedBy.length === 0) {
      // Deepest first, so a folder goes after everything inside it.
      const ordered = [...doomed.values()].sort((a, b) => b.path.length - a.path.length);
      for (const folder of ordered) {
        await tx.delete(driveFolders).where(eq(driveFolders.id, folder.id));
        await tx.insert(auditLog).values({
          action: 'drive.folder_deleted',
          entity: 'drive_folder',
          entityId: folder.id,
          metadata: { reason: 'client_folders_migration', empty: true },
        });
      }
      report.foldersDeleted = ordered.length;
    }
  }
  return report;
}
