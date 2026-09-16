import { PROTECTED_ROLES, ROLE_KEYS, ROLES, type RoleKey } from './roles.js';
import {
  ROLE_PERMISSIONS,
  SECTOR_MANAGER_GRANTS,
  type PermissionKey,
  type Scope,
} from './permissions.js';
import { TI_SECTOR, isWithinSector, type SectorSlug } from './sectors.js';

/** Who is asking. Built from the session on every request — never from the client. */
export interface Actor {
  employeeId: string;
  role: RoleKey;
  sector: SectorSlug;
  isSectorManager: boolean;
}

/** What is being acted on. Omit for permissions that are not row-specific. */
export interface Target {
  /** Sector the target row belongs to (employee record, time entry, lead). */
  sector?: SectorSlug;
  /** Employee who owns the row, for `own` scope checks. */
  ownerEmployeeId?: string;
  /** Role being granted, for `roles.assign`. */
  role?: RoleKey;
}

export type Decision = { allowed: true; scope: Scope } | { allowed: false; reason: DenyReason };

export type DenyReason =
  | 'no_permission'
  | 'out_of_scope'
  | 'diretoria_ti_block'
  | 'role_rank_too_high'
  | 'protected_role'
  | 'self_role_change';

/**
 * Hard denials, evaluated before any grant.
 *
 * Decision of 2026-09-15: Diretoria cannot see TI sector employee records at
 * all — a full block, not merely a restriction on TI tooling.
 */
function hardDeny(actor: Actor, _permission: PermissionKey, target: Target): DenyReason | null {
  if (actor.role === 'diretoria' && target.sector && isWithinSector(target.sector, TI_SECTOR)) {
    return 'diretoria_ti_block';
  }
  return null;
}

/** Effective scope for a permission, combining the role matrix with the manager flag. */
export function grantedScope(actor: Actor, permission: PermissionKey): Scope | null {
  const fromRole = ROLE_PERMISSIONS[actor.role][permission];
  const fromFlag = actor.isSectorManager ? SECTOR_MANAGER_GRANTS[permission] : undefined;
  if (!fromRole && !fromFlag) return null;
  // Widest of the two wins.
  const rank: Record<Scope, number> = { own: 1, sector: 2, all: 3 };
  if (!fromRole) return fromFlag ?? null;
  if (!fromFlag) return fromRole;
  return rank[fromFlag] > rank[fromRole] ? fromFlag : fromRole;
}

function scopeSatisfied(actor: Actor, scope: Scope, target: Target): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'sector':
      return target.sector === undefined || isWithinSector(target.sector, actor.sector);
    case 'own':
      return target.ownerEmployeeId === undefined || target.ownerEmployeeId === actor.employeeId;
  }
}

/**
 * The single authorization entry point. The API must call this for every
 * request; the frontend may call it to hide UI, but never to decide access.
 */
export function can(actor: Actor, permission: PermissionKey, target: Target = {}): Decision {
  const denied = hardDeny(actor, permission, target);
  if (denied) return { allowed: false, reason: denied };

  const scope = grantedScope(actor, permission);
  if (!scope) return { allowed: false, reason: 'no_permission' };
  if (!scopeSatisfied(actor, scope, target)) return { allowed: false, reason: 'out_of_scope' };

  if (permission === 'roles.assign' && target.role) {
    const escalation = roleAssignmentDenial(actor, target.role, target.ownerEmployeeId);
    if (escalation) return { allowed: false, reason: escalation };
  }

  return { allowed: true, scope };
}

/**
 * Privilege-escalation guards for granting a role:
 *  - only Admin Master may grant Admin Master or Diretoria;
 *  - nobody may grant a role at or above their own rank;
 *  - nobody may change their own role.
 */
export function roleAssignmentDenial(
  actor: Actor,
  targetRole: RoleKey,
  targetEmployeeId?: string,
): DenyReason | null {
  if (targetEmployeeId && targetEmployeeId === actor.employeeId) return 'self_role_change';
  if (actor.role === 'admin_master') return null;
  if (PROTECTED_ROLES.includes(targetRole)) return 'protected_role';
  if (ROLES[targetRole].rank >= ROLES[actor.role].rank) return 'role_rank_too_high';
  return null;
}

/**
 * Roles this actor may grant, in rank order. The form uses it to build the
 * dropdown; the API checks the same rule again on submit, so a tampered form
 * gains nothing.
 */
export function assignableRoles(actor: Actor, targetEmployeeId?: string): RoleKey[] {
  return ROLE_KEYS.filter((role) => roleAssignmentDenial(actor, role, targetEmployeeId) === null);
}

/** Whether login/logout of this role generates RH/DP time-clock entries. */
export function tracksTime(role: RoleKey): boolean {
  return ROLES[role].tracksTime;
}
