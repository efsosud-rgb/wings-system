import type { EmployeeStatus } from '../employees/schema.js';
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
  | 'self_role_change'
  | 'admin_master_record'
  | 'diretoria_level'
  | 'diretoria_account'
  | 'last_admin_master'
  | 'sector_manager_powers'
  | 'role_permissions_exceed';

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

const SCOPE_RANK: Record<Scope, number> = { own: 1, sector: 2, all: 3 };

/** Effective scope for a permission, combining the role matrix with the manager flag. */
export function grantedScope(actor: Actor, permission: PermissionKey): Scope | null {
  const fromRole = ROLE_PERMISSIONS[actor.role][permission];
  const fromFlag = actor.isSectorManager ? SECTOR_MANAGER_GRANTS[permission] : undefined;
  if (!fromRole && !fromFlag) return null;
  // Widest of the two wins.
  if (!fromRole) return fromFlag ?? null;
  if (!fromFlag) return fromRole;
  return SCOPE_RANK[fromFlag] > SCOPE_RANK[fromRole] ? fromFlag : fromRole;
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
 * The sector-manager guards for granting a role:
 *  - only Admin Master may grant Admin Master or Diretoria;
 *  - nobody else may grant a role at or above their own rank;
 *  - nobody but an Admin Master may change their own role.
 *
 * This is the rule for actors holding only `roles.assign`. Whether a given
 * change is allowed at all is `roleChangeDenial`'s question, not this one's.
 */
export function roleAssignmentDenial(
  actor: Actor,
  targetRole: RoleKey,
  targetEmployeeId?: string,
): DenyReason | null {
  if (actor.role === 'admin_master') return null;
  if (targetEmployeeId && targetEmployeeId === actor.employeeId) return 'self_role_change';
  if (PROTECTED_ROLES.includes(targetRole)) return 'protected_role';
  if (ROLES[targetRole].rank >= ROLES[actor.role].rank) return 'role_rank_too_high';
  return null;
}

/** True when `role` holds a permission `actor` lacks, or holds it wider than they do. */
function grantsBeyond(actor: Actor, role: RoleKey): boolean {
  return Object.entries(ROLE_PERMISSIONS[role]).some(([permission, scope]) => {
    if (!scope) return false;
    const held = grantedScope(actor, permission as PermissionKey);
    return !held || SCOPE_RANK[held] < SCOPE_RANK[scope];
  });
}

/** The employee whose access level is being set. Omit id and role on creation. */
export interface RoleChangeTarget {
  employeeId?: string;
  sector?: SectorSlug;
  currentRole?: RoleKey;
  /**
   * True when this employee is the only Admin Master who can still log in. Only
   * the API can know it; it travels on `EmployeeView` so the form can explain
   * the locked select, and the API counts again inside the write.
   */
  isLastActiveAdminMaster?: boolean;
}

/**
 * Whether `actor` may set `target`'s access level to `nextRole`. One rule for
 * the form and the API, decided 2026-09-19:
 *
 *  - Keeping the current level is never a change, so it is never denied.
 *  - Admin Master may change anyone, themselves included — except that the last
 *    Admin Master cannot be demoted: the system never runs without one.
 *  - Nobody else touches an Admin Master, and nobody else grants Admin Master.
 *  - Diretoria is granted and removed only by Diretoria or an Admin Master —
 *    RH/DP included, so it cannot promote a colleague into approving ad spend.
 *  - Holders of `employees.assign_roles` (Diretoria, RH/DP) may otherwise set
 *    any level for anyone but themselves.
 *  - Everyone else falls back to the sector-manager guards above, inside the
 *    scope `roles.assign` gives them, and only over people ranked below them
 *    (2026-10-13): a manager never demotes a colleague of equal or higher level.
 *    Without this, demoting that colleague first would open their login e-mail
 *    to the manager (`loginEmailChangeDenial`).
 */
export function roleChangeDenial(
  actor: Actor,
  target: RoleChangeTarget,
  nextRole: RoleKey,
): DenyReason | null {
  const blocked = hardDeny(actor, 'employees.assign_roles', target);
  if (blocked) return blocked;
  if (target.currentRole !== undefined && nextRole === target.currentRole) return null;

  if (actor.role === 'admin_master') {
    const demotesLastAdmin =
      target.currentRole === 'admin_master' && target.isLastActiveAdminMaster;
    return demotesLastAdmin ? 'last_admin_master' : null;
  }

  const isSelf = target.employeeId !== undefined && target.employeeId === actor.employeeId;
  if (target.currentRole === 'admin_master') return 'admin_master_record';
  const touchesDiretoria = nextRole === 'diretoria' || target.currentRole === 'diretoria';
  if (touchesDiretoria && actor.role !== 'diretoria') return 'diretoria_level';

  const wide = grantedScope(actor, 'employees.assign_roles');
  if (wide && scopeSatisfied(actor, wide, { sector: target.sector })) {
    if (isSelf) return 'self_role_change';
    return nextRole === 'admin_master' ? 'protected_role' : null;
  }

  const narrow = grantedScope(actor, 'roles.assign');
  if (!narrow) return 'no_permission';
  if (!scopeSatisfied(actor, narrow, { sector: target.sector })) return 'out_of_scope';
  const assignment = roleAssignmentDenial(actor, nextRole, target.employeeId);
  if (assignment) return assignment;
  const outranksActor =
    target.currentRole !== undefined && ROLES[target.currentRole].rank >= ROLES[actor.role].rank;
  if (outranksActor) return 'role_rank_too_high';
  // A lower rank can still hold powers the actor lacks: creating that account and taking its
  // invite, or setting a subordinate to it and taking their login, would hand them over
  // (security audit 2026-10-27, A2).
  return grantsBeyond(actor, nextRole) ? 'role_permissions_exceed' : null;
}

/** An existing employee whose login e-mail would change. */
export interface LoginEmailTarget extends RoleChangeTarget {
  employeeId: string;
  sector: SectorSlug;
  currentRole: RoleKey;
  /** Holds the sector-manager flag, and with it every power in `SECTOR_MANAGER_GRANTS`. */
  isSectorManager: boolean;
}

/**
 * Whether `actor` may change `target`'s login e-mail. One rule for the form and
 * the API, decided 2026-10-13 after the security audit: whoever holds the login
 * address can reset the password, so changing it is taking the account over.
 * The bar is therefore the access level's:
 *
 *  - The actor must be able to edit the record at all (`employees.update`).
 *  - Admin Master may change anyone's, themselves included.
 *  - Everyone else needs to be able to set this person to another level
 *    (`roleChangeDenial`): RH/DP never on Diretoria, nobody on their own
 *    address, nobody but an Admin Master on an Admin Master, and a sector
 *    manager or the Gerente Comercial only on someone ranked below them.
 *  - On a sector manager, they must also hold every power the flag gives
 *    (`managerPowersDenial`).
 */
export function loginEmailChangeDenial(actor: Actor, target: LoginEmailTarget): DenyReason | null {
  const edit = can(actor, 'employees.update', { sector: target.sector });
  if (!edit.allowed) return edit.reason;
  if (actor.role === 'admin_master') return null;

  const level = roleFieldState(actor, target).locked;
  if (level) return level;
  return target.isSectorManager ? managerPowersDenial(actor, target.sector) : null;
}

/**
 * Whether `actor` already holds, over `sector` and at least as wide, every
 * power the sector-manager flag gives (2026-10-13). Taking a manager's login
 * hands those powers over: otherwise the Gerente Comercial, who cannot switch
 * anyone off, could do it from a subordinate manager's account.
 * `employees.assign_roles` covers `roles.assign`: it sets more levels, not fewer.
 */
function managerPowersDenial(actor: Actor, sector: SectorSlug): DenyReason | null {
  for (const [permission, flagScope] of Object.entries(SECTOR_MANAGER_GRANTS)) {
    if (!flagScope) continue;
    const holders: PermissionKey[] =
      permission === 'roles.assign'
        ? ['roles.assign', 'employees.assign_roles']
        : [permission as PermissionKey];
    const held = holders.some((key) => {
      const decision = can(actor, key, { sector });
      return decision.allowed && SCOPE_RANK[decision.scope] >= SCOPE_RANK[flagScope];
    });
    if (!held) return 'sector_manager_powers';
  }
  return null;
}

/**
 * Whether `actor` may move an employee from `current` to `next` status.
 * Switching someone off, or back on, needs `employees.deactivate` over their
 * sector: editing the record is not enough. Active ↔ on leave is an ordinary
 * edit.
 *
 * Audit rule A11 (decided by Eric, 2026-10-29): only an Admin Master switches a
 * Diretoria account off or back on. RH/DP and Diretoria itself are refused, the
 * same bar as changing that account's login e-mail.
 */
export function statusChangeDenial(
  actor: Actor,
  target: { sector: SectorSlug; currentRole?: RoleKey },
  current: EmployeeStatus,
  next: EmployeeStatus,
): DenyReason | null {
  if (current === next) return null;
  if (current !== 'inactive' && next !== 'inactive') return null;
  const decision = can(actor, 'employees.deactivate', { sector: target.sector });
  if (!decision.allowed) return decision.reason;
  // Without employees.assign_roles, nobody switches off, or back on, someone above them
  // (security audit 2026-10-27, A3). Colleagues of the same level stay theirs to manage.
  const wide = can(actor, 'employees.assign_roles', { sector: target.sector }).allowed;
  if (target.currentRole && actor.role !== 'admin_master' && !wide) {
    if (PROTECTED_ROLES.includes(target.currentRole)) return 'protected_role';
    if (ROLES[target.currentRole].rank > ROLES[actor.role].rank) return 'role_rank_too_high';
  }
  // Audit rule A11: holders of employees.assign_roles (RH/DP) pass the checks above, but a
  // Diretoria account is still an Admin Master's alone to switch off or on.
  if (target.currentRole === 'diretoria' && actor.role !== 'admin_master') {
    return 'diretoria_account';
  }
  return null;
}

/** What the access-level select should offer, and why it is locked if it is. */
export interface RoleFieldState {
  /** In rank order. On an edit it always includes the current level. */
  options: RoleKey[];
  /** Set when no other level can be chosen; the form disables the select. */
  locked: DenyReason | null;
}

/**
 * Drives the form's dropdown. The API applies `roleChangeDenial` again on
 * submit, so a tampered form gains nothing.
 */
export function roleFieldState(actor: Actor, target: RoleChangeTarget = {}): RoleFieldState {
  const options = ROLE_KEYS.filter((role) => roleChangeDenial(actor, target, role) === null);
  if (target.currentRole === undefined) return { options, locked: null };
  if (options.some((role) => role !== target.currentRole)) return { options, locked: null };

  // Ask about the humblest other level: its answer is the underlying reason,
  // not a side effect of rank or of a protected role.
  const probe = [...ROLE_KEYS].reverse().find((role) => role !== target.currentRole);
  return { options, locked: probe ? roleChangeDenial(actor, target, probe) : null };
}

/** Levels this actor may set for `target`, in rank order. */
export function assignableRoles(actor: Actor, target: RoleChangeTarget = {}): RoleKey[] {
  return roleFieldState(actor, target).options;
}

/** Whether login/logout of this role generates RH/DP time-clock entries. */
export function tracksTime(role: RoleKey): boolean {
  return ROLES[role].tracksTime;
}
