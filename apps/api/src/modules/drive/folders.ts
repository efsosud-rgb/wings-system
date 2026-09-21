import {
  DRIVE_MEDIA_FOLDER,
  DRIVE_TEMPLATE_SEED,
  WINGS_CLIENT_ID,
  type DriveSyncResult,
  type DriveTemplateSeed,
} from '@wings/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clients, driveFolders, driveTemplateNodes } from '../../db/schema/index.js';

/**
 * The folders the system keeps: the model, and a folder per client under every
 * "Clientes" node of the model. Everything here can run again at any time and
 * only ever adds or renames: a folder is never deleted by a sync.
 */

type FolderRow = typeof driveFolders.$inferSelect;
type NodeRow = typeof driveTemplateNodes.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** A client's name as a folder name: separators cannot be part of one. */
export const folderNameOf = (name: string) =>
  name
    .replace(/[\\/\p{Cc}]/gu, '-')
    .trim()
    .slice(0, 120) || 'Cliente';

/** Renames a folder and rewrites the path of everything under it. */
export async function renameFolderTree(tx: Tx | Database, folder: FolderRow, name: string) {
  const parentPath = folder.path.slice(0, folder.path.length - folder.name.length - 1);
  await moveFolderTree(tx, folder, { name, parentId: folder.parentId, parentPath });
}

/** Puts a folder (and its subtree) under another parent and/or name. */
export async function moveFolderTree(
  tx: Tx | Database,
  folder: FolderRow,
  to: { name: string; parentId: string | null; parentPath: string },
): Promise<string> {
  const path = `${to.parentPath}/${to.name}`;
  // Compared by length, not LIKE: a name may hold % or _.
  await tx.execute(sql`
    update drive_folders
       set path = ${path} || substr(path, ${folder.path.length + 1})
     where path = ${folder.path} or starts_with(path, ${`${folder.path}/`})`);
  await tx
    .update(driveFolders)
    .set({ name: to.name, parentId: to.parentId })
    .where(eq(driveFolders.id, folder.id));
  return path;
}

/** Writes the seed model, once: a model somebody edited is never overwritten. */
export async function seedDriveTemplate(db: Database): Promise<void> {
  const [existing] = await db
    .select({ id: driveTemplateNodes.id })
    .from(driveTemplateNodes)
    .limit(1);
  if (existing) return;
  const write = async (nodes: DriveTemplateSeed[], parentId: string | null) => {
    for (const [position, node] of nodes.entries()) {
      const [row] = await db
        .insert(driveTemplateNodes)
        .values({
          parentId,
          name: node.name,
          kind: node.clients ? 'clients' : 'folder',
          department: node.department,
          position,
        })
        .returning({ id: driveTemplateNodes.id });
      if (!row) throw new Error('failed to seed drive template');
      await write(node.children ?? [], row.id);
    }
  };
  await write(DRIVE_TEMPLATE_SEED, null);
}

/**
 * Makes the Drive match the model and the client register: every node has its
 * folder, every active client has a folder under every "Clientes" node with
 * that node's children inside, and a folder whose node or client was renamed
 * takes the new name. One at a time, under a lock.
 */
export async function syncDriveFolders(db: Database): Promise<DriveSyncResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7301, 1)`);
    const nodes = await tx
      .select()
      .from(driveTemplateNodes)
      .orderBy(asc(driveTemplateNodes.position), asc(driveTemplateNodes.createdAt));
    const everyClient = await tx.select().from(clients).orderBy(asc(clients.name));
    const folders = await tx.select().from(driveFolders);
    const result: DriveSyncResult = {
      foldersCreated: 0,
      foldersRenamed: 0,
      clients: everyClient.filter((client) => client.active).length,
    };
    const childrenOf = (parentId: string | null) =>
      nodes.filter((node) => node.parentId === parentId);

    async function ensure(input: {
      parent: FolderRow | null;
      node: NodeRow;
      origin: 'template' | 'client' | 'client_child';
      clientId: string | null;
      name: string;
      /** A client that was switched off keeps its folders but gets no new ones. */
      create: boolean;
    }): Promise<FolderRow | null> {
      const parentId = input.parent?.id ?? null;
      const siblings = folders.filter((folder) => folder.parentId === parentId);
      let folder =
        siblings.find(
          (item) =>
            item.templateNodeId === input.node.id &&
            item.origin === input.origin &&
            item.clientId === input.clientId,
        ) ??
        // A folder somebody made by hand with the same name is taken over, not duplicated.
        siblings.find(
          (item) =>
            item.origin === 'manual' && item.name.toLowerCase() === input.name.toLowerCase(),
        );
      const parentPath = input.parent?.path ?? '';

      if (!folder) {
        if (!input.create) return null;
        const [made] = await tx
          .insert(driveFolders)
          .values({
            parentId,
            name: input.name,
            path: `${parentPath}/${input.name}`,
            department: input.node.department,
            clientId: input.clientId,
            origin: input.origin,
            templateNodeId: input.node.id,
          })
          .returning();
        if (!made) throw new Error('failed to create drive folder');
        folders.push(made);
        result.foldersCreated += 1;
        return made;
      }

      if (folder.name !== input.name) {
        const taken = siblings.some(
          (item) => item.id !== folder?.id && item.name.toLowerCase() === input.name.toLowerCase(),
        );
        if (!taken) {
          const before = folder.path;
          const path = await moveFolderTree(tx, folder, {
            name: input.name,
            parentId,
            parentPath,
          });
          for (const item of folders) {
            if (item.path === before || item.path.startsWith(`${before}/`)) {
              item.path = path + item.path.slice(before.length);
            }
          }
          folder.name = input.name;
          result.foldersRenamed += 1;
        }
      }
      if (
        folder.templateNodeId !== input.node.id ||
        folder.origin !== input.origin ||
        folder.department !== input.node.department ||
        folder.clientId !== input.clientId
      ) {
        const changes = {
          templateNodeId: input.node.id,
          origin: input.origin,
          department: input.node.department,
          clientId: input.clientId,
        };
        await tx.update(driveFolders).set(changes).where(eq(driveFolders.id, folder.id));
        folder = Object.assign(folder, changes);
      }
      return folder;
    }

    async function walk(
      parent: FolderRow | null,
      node: NodeRow,
      client: typeof clients.$inferSelect | null,
    ): Promise<void> {
      const folder = await ensure({
        parent,
        node,
        origin: client ? 'client_child' : 'template',
        clientId: client?.id ?? null,
        name: node.name,
        create: client === null || client.active,
      });
      if (!folder) return;
      if (node.kind !== 'clients' || client) {
        for (const child of childrenOf(node.id)) await walk(folder, child, client);
        return;
      }
      // Wings Company is who the work is BY, in these folders: it gets no client folder.
      for (const each of everyClient.filter((item) => item.id !== WINGS_CLIENT_ID)) {
        const clientFolder = await ensure({
          parent: folder,
          node,
          origin: 'client',
          clientId: each.id,
          name: folderNameOf(each.name),
          create: each.active,
        });
        if (!clientFolder) continue;
        for (const child of childrenOf(node.id)) await walk(clientFolder, child, each);
      }
    }

    for (const root of childrenOf(null)) await walk(null, root, null);

    // What was made by hand inside a folder follows that folder's department and client.
    await tx.execute(sql`
      with recursive tree as (
        select id, department, client_id from drive_folders where origin <> 'manual'
        union all
        select child.id, tree.department, tree.client_id
          from drive_folders child join tree on child.parent_id = tree.id
         where child.origin = 'manual'
      )
      update drive_folders f
         set department = tree.department, client_id = tree.client_id
        from tree
       where f.id = tree.id and f.origin = 'manual'
         and (f.department <> tree.department or f.client_id is distinct from tree.client_id)`);
    return result;
  });
}

/**
 * The folder the media library lives in: Formatação/Marketing/Mídia for Wings
 * Company, Formatação/Marketing/Clientes/<Cliente>/Mídia for a client. Found by
 * what it is (department, client, name), so a renamed "Marketing" still works.
 */
export async function mediaFolderFor(db: Database, clientId: string): Promise<FolderRow | null> {
  const find = () =>
    db
      .select()
      .from(driveFolders)
      .where(
        and(
          eq(driveFolders.department, 'marketing'),
          eq(driveFolders.name, DRIVE_MEDIA_FOLDER),
          clientId === WINGS_CLIENT_ID
            ? and(isNull(driveFolders.clientId), eq(driveFolders.origin, 'template'))
            : and(eq(driveFolders.clientId, clientId), eq(driveFolders.origin, 'client_child')),
        ),
      )
      .orderBy(asc(driveFolders.createdAt))
      .limit(1);
  const [found] = await find();
  if (found) return found;
  // A client registered a moment ago, or a database the sync never ran on.
  await syncDriveFolders(db);
  const [made] = await find();
  return made ?? null;
}
