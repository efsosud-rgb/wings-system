import {
  DRIVE_ROLE_DEPARTMENTS,
  grantedScope,
  type Actor,
  type DriveDepartment,
} from '@wings/shared';

/**
 * What one person may do in the Drive. Decided here, on the server, from the
 * role: the screen only ever shows what these answers allowed.
 *
 * Scope `all` (Admin Master, Diretoria) is every folder. Scope `sector` is the
 * departments of the role, and nothing outside them: a folder of another
 * department is not listed, not searched and not opened by id.
 */
export interface DriveAccess {
  employeeId: string;
  all: boolean;
  departments: ReadonlySet<DriveDepartment>;
  write: boolean;
  manage: boolean;
}

export function driveAccessOf(actor: Actor): DriveAccess | null {
  const read = grantedScope(actor, 'drive.read');
  if (!read) return null;
  const all = read === 'all';
  return {
    employeeId: actor.employeeId,
    all,
    departments: new Set(all ? [] : (DRIVE_ROLE_DEPARTMENTS[actor.role] ?? [])),
    write: grantedScope(actor, 'drive.write') !== null,
    manage: grantedScope(actor, 'drive.manage') !== null,
  };
}

export const seesDepartment = (access: DriveAccess, department: string) =>
  access.all || access.departments.has(department as DriveDepartment);
