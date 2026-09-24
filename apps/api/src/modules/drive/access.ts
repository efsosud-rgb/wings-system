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
  write: boolean;
  manage: boolean;
}

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
    write: grantedScope(actor, 'drive.write') !== null,
    manage: grantedScope(actor, 'drive.manage') !== null,
  };
}

/** The folder facts access depends on. */
export interface FolderReach {
  department: string;
  clientId: string | null;
}

export const seesDepartment = (access: DriveAccess, department: string) =>
  access.all || access.departments.has(department as DriveDepartment);

export const seesFolder = (access: DriveAccess, folder: FolderReach) =>
  seesDepartment(access, folder.department) || (access.clientView && folder.clientId !== null);

export const writesFolder = (access: DriveAccess, folder: FolderReach) =>
  access.write &&
  (access.all || access.writeDepartments.has(folder.department as DriveDepartment));

/** The same rule as `seesFolder`, as a condition on `drive_folders` for queries over files. */
export function folderReachSql(access: DriveAccess): SQL | undefined {
  if (access.all) return undefined;
  const departments = [...access.departments];
  const byDepartment =
    departments.length > 0
      ? sql`${driveFolders.department} in (${sql.join(
          departments.map((department) => sql`${department}`),
          sql`, `,
        )})`
      : sql`false`;
  return access.clientView
    ? sql`(${byDepartment} or ${driveFolders.clientId} is not null)`
    : byDepartment;
}
