import {
  DRIVE_CLIENT_VIEW_ROLES,
  DRIVE_ROLE_DEPARTMENTS,
  DRIVE_ROLE_READ_ONLY_DEPARTMENTS,
  grantedScope,
  type Actor,
  type DriveDepartment,
} from '@wings/shared';
import { sql, type SQL } from 'drizzle-orm';
import { driveFolders } from '../../db/schema/index.js';

/**
 * What one person may do in the Drive. Decided here, on the server, from the
 * role: the screen only ever shows what these answers allowed.
 *
 * Scope `all` (Admin Master, Diretoria) is every folder. Scope `sector` is the
 * departments of the role, and nothing outside them: a folder of another
 * department is not listed, not searched and not opened by id.
 *
 * Reading and writing are separate (2026-09-24): a role may read a department
 * it does not write (every Formatação area reads 01–03 of each client), and a
 * whole-client role reads every folder of every client while writing only in
 * its own departments.
 *
 * The deals' folders (Comercial / Negociações / <deal>) follow the lead rule, not
 * the department (2026-10-07): the files of a deal are as private as the deal. Only
 * somebody who sees every lead (`dealFolders`) reaches that subtree here; a seller
 * reaches the files of their own deals through the deal's own routes
 * (`dealFilesAccess`, used only after the lead was checked), and the folder name is
 * the deal's name, so even the tree does not list it for them.
 */
export interface DriveAccess {
  employeeId: string;
  all: boolean;
  /** Departments the person reads (includes the ones they write). */
  departments: ReadonlySet<DriveDepartment>;
  /** Departments the person writes in, when they hold `drive.write`. */
  writeDepartments: ReadonlySet<DriveDepartment>;
  /** Reads every folder that belongs to a client, whatever its department. */
  clientView: boolean;
  /** Reaches the deals' folders: holds `leads.read` with scope `all`. Anything else is closed. */
  dealFolders: boolean;
  write: boolean;
  manage: boolean;
}

/** The folder every deal's folder sits under; a deal's files are filed at `<this>/<deal name>`. */
export const DEALS_PATH = '/Comercial/Negociações';

/** Whether a folder path is the deals' folder itself or anything below it. */
export const isDealsPath = (path: string) =>
  path === DEALS_PATH || path.startsWith(`${DEALS_PATH}/`);

/**
 * The same person's access with the deals' folders open. Only for a route that already checked the
 * lead itself (`leadInScope`), and only to touch that lead's own files.
 */
export const dealFilesAccess = (access: DriveAccess): DriveAccess => ({
  ...access,
  dealFolders: true,
});

/**
 * The access a deal's own routes use for that deal's files when the person has no Drive (the
 * sellers, Eric 14/10): the Comercial tree with the deals' folders open, writing when the person
 * edits deals. Only for a route that already checked the lead itself (`leadInScope`), like
 * `dealFilesAccess`.
 */
export function leadFilesAccessOf(actor: Actor): DriveAccess {
  const write = grantedScope(actor, 'leads.write') !== null;
  return {
    employeeId: actor.employeeId,
    all: false,
    departments: new Set<DriveDepartment>(['comercial']),
    writeDepartments: new Set<DriveDepartment>(write ? ['comercial'] : []),
    clientView: false,
    dealFolders: true,
    write,
    manage: false,
  };
}

/** The Drive access of a deal's own routes: the person's Drive, or the deal-only access without one. */
export const dealRouteAccessOf = (actor: Actor): DriveAccess => {
  const drive = driveAccessOf(actor);
  return drive ? dealFilesAccess(drive) : leadFilesAccessOf(actor);
};

export function driveAccessOf(actor: Actor): DriveAccess | null {
  const read = grantedScope(actor, 'drive.read');
  if (!read) return null;
  const all = read === 'all';
  const own = all ? [] : (DRIVE_ROLE_DEPARTMENTS[actor.role] ?? []);
  const readOnly = all ? [] : (DRIVE_ROLE_READ_ONLY_DEPARTMENTS[actor.role] ?? []);
  return {
    employeeId: actor.employeeId,
    all,
    departments: new Set([...own, ...readOnly]),
    writeDepartments: new Set(own),
    clientView: !all && DRIVE_CLIENT_VIEW_ROLES.includes(actor.role),
    dealFolders: grantedScope(actor, 'leads.read') === 'all',
    write: grantedScope(actor, 'drive.write') !== null,
    manage: grantedScope(actor, 'drive.manage') !== null,
  };
}

/** The folder facts access depends on. */
export interface FolderReach {
  department: string;
  clientId: string | null;
  /** The folder's path (names from the root); decides the deals' folders. Never optional: a missing one must not open them. */
  path: string;
}

export const seesDepartment = (access: DriveAccess, department: string) =>
  access.all || access.departments.has(department as DriveDepartment);

export const seesFolder = (access: DriveAccess, folder: FolderReach) =>
  (access.dealFolders || !isDealsPath(folder.path)) &&
  (seesDepartment(access, folder.department) || (access.clientView && folder.clientId !== null));

export const writesFolder = (access: DriveAccess, folder: FolderReach) =>
  (access.dealFolders || !isDealsPath(folder.path)) &&
  access.write &&
  (access.all || access.writeDepartments.has(folder.department as DriveDepartment));

/** The same rule as `seesFolder`, as a condition on `drive_folders` for queries over files. */
export function folderReachSql(access: DriveAccess): SQL | undefined {
  if (access.all && access.dealFolders) return undefined;
  const outsideDeals = access.dealFolders
    ? sql`true`
    : sql`not (${driveFolders.path} = ${DEALS_PATH} or starts_with(${driveFolders.path}, ${`${DEALS_PATH}/`}))`;
  if (access.all) return outsideDeals;
  const departments = [...access.departments];
  const byDepartment =
    departments.length > 0
      ? sql`${driveFolders.department} in (${sql.join(
          departments.map((department) => sql`${department}`),
          sql`, `,
        )})`
      : sql`false`;
  const byReach = access.clientView
    ? sql`(${byDepartment} or ${driveFolders.clientId} is not null)`
    : byDepartment;
  return access.dealFolders ? byReach : sql`(${byReach} and ${outsideDeals})`;
}
