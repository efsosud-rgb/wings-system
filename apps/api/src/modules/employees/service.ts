import {
  SECTOR_SLUGS,
  can,
  maskCpf,
  roleChangeDenial,
  type Actor,
  type EmployeeCreate,
  type EmployeeListQuery,
  type EmployeeListResult,
  type EmployeeStatus,
  type EmployeeUpdate,
  type EmployeeView,
  type RoleKey,
  type SectorSlug,
} from '@wings/shared';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { employees, roles, sectors } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import type { CpfCrypto } from '../../lib/cpf-crypto.js';
import { revokeAllSessions, type RequestContext } from '../auth/service.js';

export type EmployeeFailure =
  | 'forbidden'
  | 'not_found'
  | 'cpf_taken'
  | 'email_taken'
  | 'role_not_allowed'
  | 'manager_flag_forbidden'
  | 'admin_master_record'
  | 'last_admin_master';

export type Result<T> = { ok: true; value: T } | { ok: false; reason: EmployeeFailure };

type Row = {
  id: string;
  full_name: string;
  cpf_encrypted: string;
  birth_date: string;
  phone: string;
  email: string;
  cargo: string;
  sector_slug: string;
  role_key: string;
  admission_date: string;
  status: EmployeeStatus;
  is_sector_manager: boolean;
  is_last_active_admin_master: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date | string;
  last_login_at: Date | string | null;
} & Record<string, unknown>;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toView(row: Row, cpfCrypto: CpfCrypto): EmployeeView {
  // Masking needs the digits, so the value is decrypted server-side and only
  // the masked form leaves this function. The full CPF is returned exclusively
  // by revealCpf(), which is audited.
  let cpfMasked = '***.***.***-**';
  try {
    cpfMasked = maskCpf(cpfCrypto.decrypt(row.cpf_encrypted));
  } catch {
    // Unreadable ciphertext (e.g. an anonymised record) stays fully masked.
  }

  return {
    id: row.id,
    fullName: row.full_name,
    cpfMasked,
    birthDate: row.birth_date,
    phone: row.phone,
    email: row.email,
    cargo: row.cargo,
    sector: row.sector_slug as SectorSlug,
    role: row.role_key as RoleKey,
    admissionDate: row.admission_date,
    status: row.status,
    isSectorManager: row.is_sector_manager,
    isLastActiveAdminMaster: row.is_last_active_admin_master,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    lastLoginAt: toIso(row.last_login_at),
  };
}

/**
 * Admin Masters who can still log in. `on_leave` counts: only `inactive` blocks
 * a login, so an Admin Master on leave can still come back and run the system.
 */
const USABLE_ADMIN_MASTERS = sql`
  select count(*) from employees a
    join roles ar on ar.id = a.role_id
   where ar.key = 'admin_master' and a.status <> 'inactive'
`;

const SELECT_EMPLOYEE = sql`
  select e.id, e.full_name, e.cpf_encrypted, e.birth_date, e.phone, e.email, e.cargo,
         s.slug as sector_slug, r.key as role_key, e.admission_date, e.status,
         e.is_sector_manager,
         (r.key = 'admin_master' and e.status <> 'inactive' and (${USABLE_ADMIN_MASTERS}) = 1)
           as is_last_active_admin_master,
         e.created_by, creator.full_name as created_by_name,
         e.created_at, e.last_login_at
    from employees e
    join sectors s on s.id = e.sector_id
    join roles r on r.id = e.role_id
    left join employees creator on creator.id = e.created_by
`;

/**
 * Sectors this actor may see employees in, derived by asking the policy about
 * each sector rather than re-implementing scope rules. This is what makes the
 * Diretoria/TI block apply to lists as well as to single records.
 */
export function visibleSectors(actor: Actor): SectorSlug[] {
  return SECTOR_SLUGS.filter((slug) => can(actor, 'employees.read', { sector: slug }).allowed);
}

export async function listEmployees(
  db: Database,
  actor: Actor,
  cpfCrypto: CpfCrypto,
  query: EmployeeListQuery = {},
): Promise<EmployeeListResult> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const allowed = visibleSectors(actor);

  const decision = can(actor, 'employees.read');
  const ownOnly = decision.allowed && decision.scope === 'own';

  if (allowed.length === 0 && !ownOnly) {
    return { employees: [], total: 0, page, pageSize };
  }

  const conditions: SQL[] = [];
  if (ownOnly) {
    conditions.push(sql`e.id = ${actor.employeeId}`);
  } else {
    conditions.push(
      sql`s.slug in (${sql.join(
        allowed.map((slug) => sql`${slug}`),
        sql`, `,
      )})`,
    );
  }
  if (query.sector) conditions.push(sql`s.slug = ${query.sector}`);
  if (query.status) conditions.push(sql`e.status = ${query.status}`);
  if (query.search?.trim()) {
    const term = `%${query.search.trim()}%`;
    conditions.push(
      sql`(e.full_name ilike ${term} or e.email ilike ${term} or e.cargo ilike ${term})`,
    );
  }

  const where = sql.join(conditions, sql` and `);

  const countRows = await db.execute<{ total: string } & Record<string, unknown>>(sql`
    select count(*)::text as total
      from employees e
      join sectors s on s.id = e.sector_id
     where ${where}
  `);

  const rows = await db.execute<Row>(sql`
    ${SELECT_EMPLOYEE}
    where ${where}
    order by e.full_name asc
    limit ${pageSize} offset ${(page - 1) * pageSize}
  `);

  return {
    employees: rows.rows.map((row) => toView(row, cpfCrypto)),
    total: Number(countRows.rows[0]?.total ?? 0),
    page,
    pageSize,
  };
}

async function fetchRow(db: Database, id: string): Promise<Row | null> {
  const rows = await db.execute<Row>(sql`${SELECT_EMPLOYEE} where e.id = ${id} limit 1`);
  return rows.rows[0] ?? null;
}

export async function getEmployee(
  db: Database,
  actor: Actor,
  cpfCrypto: CpfCrypto,
  id: string,
): Promise<Result<EmployeeView>> {
  const row = await fetchRow(db, id);
  if (!row) return { ok: false, reason: 'not_found' };

  const decision = can(actor, 'employees.read', {
    sector: row.sector_slug as SectorSlug,
    ownerEmployeeId: row.id,
  });
  // A blocked record is reported as not found: whether a TI employee exists is
  // itself information Diretoria should not get.
  if (!decision.allowed) return { ok: false, reason: 'not_found' };

  return { ok: true, value: toView(row, cpfCrypto) };
}

async function idsInUse(
  db: Database,
  args: { email?: string; cpfIndex?: string; exceptId?: string },
): Promise<{ emailTaken: boolean; cpfTaken: boolean }> {
  const rows = await db.execute<{ email: string; cpf_index: string } & Record<string, unknown>>(sql`
    select email, cpf_index from employees
     where (${args.email ? sql`lower(email) = ${args.email.toLowerCase()}` : sql`false`}
        or ${args.cpfIndex ? sql`cpf_index = ${args.cpfIndex}` : sql`false`})
       and ${args.exceptId ? sql`id <> ${args.exceptId}` : sql`true`}
  `);
  return {
    emailTaken: rows.rows.some((r) => r.email.toLowerCase() === args.email?.toLowerCase()),
    cpfTaken: rows.rows.some((r) => r.cpf_index === args.cpfIndex),
  };
}

export async function createEmployee(
  db: Database,
  actor: Actor,
  cpfCrypto: CpfCrypto,
  input: EmployeeCreate,
  ctx: RequestContext = {},
): Promise<Result<EmployeeView>> {
  if (!can(actor, 'employees.create', { sector: input.sector }).allowed) {
    return { ok: false, reason: 'forbidden' };
  }
  if (roleChangeDenial(actor, { sector: input.sector }, input.role)) {
    return { ok: false, reason: 'role_not_allowed' };
  }
  // The sector-manager flag is an Admin Master decision only.
  if (input.isSectorManager && actor.role !== 'admin_master') {
    return { ok: false, reason: 'manager_flag_forbidden' };
  }

  const cpfIndex = cpfCrypto.index(input.cpf);
  const taken = await idsInUse(db, { email: input.email, cpfIndex });
  if (taken.cpfTaken) return { ok: false, reason: 'cpf_taken' };
  if (taken.emailTaken) return { ok: false, reason: 'email_taken' };

  const role = await db.query.roles.findFirst({ where: eq(roles.key, input.role) });
  const sector = await db.query.sectors.findFirst({ where: eq(sectors.slug, input.sector) });
  if (!role || !sector) return { ok: false, reason: 'not_found' };

  const [created] = await db
    .insert(employees)
    .values({
      fullName: input.fullName,
      cpfEncrypted: cpfCrypto.encrypt(input.cpf),
      cpfIndex,
      birthDate: input.birthDate,
      phone: input.phone,
      email: input.email,
      cargo: input.cargo,
      sectorId: sector.id,
      roleId: role.id,
      admissionDate: input.admissionDate,
      status: input.status,
      isSectorManager: input.isSectorManager,
      createdBy: actor.employeeId,
      deactivatedAt: input.status === 'inactive' ? new Date() : null,
    })
    .returning({ id: employees.id });

  if (!created) return { ok: false, reason: 'not_found' };

  await writeAudit(db, {
    actorEmployeeId: actor.employeeId,
    action: 'employee.created',
    entity: 'employee',
    entityId: created.id,
    targetEmployeeId: created.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    // Field names and classifications only — never the personal values.
    metadata: {
      sector: input.sector,
      role: input.role,
      status: input.status,
      isSectorManager: input.isSectorManager,
    },
  });

  const row = await fetchRow(db, created.id);
  return row ? { ok: true, value: toView(row, cpfCrypto) } : { ok: false, reason: 'not_found' };
}

export async function updateEmployee(
  db: Database,
  actor: Actor,
  cpfCrypto: CpfCrypto,
  id: string,
  input: EmployeeUpdate,
  ctx: RequestContext = {},
): Promise<Result<EmployeeView>> {
  const current = await fetchRow(db, id);
  if (!current) return { ok: false, reason: 'not_found' };

  const currentSector = current.sector_slug as SectorSlug;
  if (!can(actor, 'employees.read', { sector: currentSector }).allowed) {
    return { ok: false, reason: 'not_found' };
  }
  const currentRole = current.role_key as RoleKey;
  // Nobody but an Admin Master edits an Admin Master. Without this, anyone with
  // update rights over that sector could point the account's e-mail at their
  // own mailbox and take it over with a password reset.
  if (currentRole === 'admin_master' && actor.role !== 'admin_master') {
    return { ok: false, reason: 'admin_master_record' };
  }
  if (!can(actor, 'employees.update', { sector: currentSector }).allowed) {
    // `employees.assign_roles` alone (Diretoria) changes the access level and
    // nothing else on the record.
    const touchesOtherFields = Object.entries(input).some(
      ([field, value]) => field !== 'role' && value !== undefined,
    );
    const levelOnly =
      can(actor, 'employees.assign_roles', { sector: currentSector }).allowed &&
      !touchesOtherFields;
    if (!levelOnly) return { ok: false, reason: 'forbidden' };
  }
  // Moving someone requires authority over the destination too, otherwise a
  // manager could push an employee out of their own scope, or pull one in.
  if (input.sector && input.sector !== currentSector) {
    if (!can(actor, 'employees.update', { sector: input.sector }).allowed) {
      return { ok: false, reason: 'forbidden' };
    }
  }

  const roleChanges = input.role !== undefined && input.role !== currentRole;
  if (input.role !== undefined && roleChanges) {
    const denial = roleChangeDenial(
      actor,
      {
        employeeId: id,
        sector: input.sector ?? currentSector,
        currentRole,
        isLastActiveAdminMaster: current.is_last_active_admin_master,
      },
      input.role,
    );
    if (denial === 'last_admin_master') return { ok: false, reason: 'last_admin_master' };
    if (denial) return { ok: false, reason: 'role_not_allowed' };
  }

  if (
    input.isSectorManager !== undefined &&
    input.isSectorManager !== current.is_sector_manager &&
    actor.role !== 'admin_master'
  ) {
    return { ok: false, reason: 'manager_flag_forbidden' };
  }

  const nextCpfIndex = input.cpf ? cpfCrypto.index(input.cpf) : undefined;
  if (input.email || nextCpfIndex) {
    const taken = await idsInUse(db, {
      email: input.email,
      cpfIndex: nextCpfIndex,
      exceptId: id,
    });
    if (taken.cpfTaken) return { ok: false, reason: 'cpf_taken' };
    if (taken.emailTaken) return { ok: false, reason: 'email_taken' };
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const changed: string[] = [];

  /** Records a column change and remembers the field name for the audit entry. */
  const setField = (column: string, value: unknown): void => {
    patch[column] = value;
    changed.push(column);
  };

  if (input.fullName !== undefined) setField('fullName', input.fullName);
  if (input.birthDate !== undefined) setField('birthDate', input.birthDate);
  if (input.phone !== undefined) setField('phone', input.phone);
  if (input.email !== undefined) setField('email', input.email);
  if (input.cargo !== undefined) setField('cargo', input.cargo);
  if (input.admissionDate !== undefined) setField('admissionDate', input.admissionDate);
  if (input.isSectorManager !== undefined) setField('isSectorManager', input.isSectorManager);
  if (input.cpf !== undefined) {
    patch.cpfEncrypted = cpfCrypto.encrypt(input.cpf);
    patch.cpfIndex = nextCpfIndex;
    changed.push('cpf');
  }
  if (input.sector && input.sector !== currentSector) {
    const sector = await db.query.sectors.findFirst({ where: eq(sectors.slug, input.sector) });
    if (!sector) return { ok: false, reason: 'not_found' };
    patch.sectorId = sector.id;
    changed.push('sector');
  }
  if (input.role !== undefined && roleChanges) {
    const role = await db.query.roles.findFirst({ where: eq(roles.key, input.role) });
    if (!role) return { ok: false, reason: 'not_found' };
    patch.roleId = role.id;
    changed.push('role');
  }
  if (input.status !== undefined && input.status !== current.status) {
    patch.status = input.status;
    patch.deactivatedAt = input.status === 'inactive' ? new Date() : null;
    changed.push('status');
  }

  // Demoting or deactivating an Admin Master: count again under a lock, so two
  // Admin Masters demoting each other at the same moment cannot both succeed.
  const removesAnAdminMaster =
    currentRole === 'admin_master' &&
    current.status !== 'inactive' &&
    (roleChanges || patch.status === 'inactive');
  if (removesAnAdminMaster) {
    const kept = await db.transaction(async (tx) => {
      const usable = await tx.execute<{ id: string } & Record<string, unknown>>(sql`
        select a.id from employees a
          join roles ar on ar.id = a.role_id
         where ar.key = 'admin_master' and a.status <> 'inactive'
           for update of a
      `);
      if (usable.rows.length <= 1) return false;
      await tx.update(employees).set(patch).where(eq(employees.id, id));
      return true;
    });
    if (!kept) return { ok: false, reason: 'last_admin_master' };
  } else {
    await db.update(employees).set(patch).where(eq(employees.id, id));
  }

  // Deactivation or a role change must end access immediately, not at expiry.
  const revokes = changed.includes('role') || patch.status === 'inactive';
  if (revokes) {
    await revokeAllSessions(db, id, patch.status === 'inactive' ? 'deactivated' : 'role_changed');
  }

  await writeAudit(db, {
    actorEmployeeId: actor.employeeId,
    action: 'employee.updated',
    entity: 'employee',
    entityId: id,
    targetEmployeeId: id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    // Which fields changed, never the old or new values.
    metadata: {
      changed,
      ...(changed.includes('role') ? { role: input.role } : {}),
      ...(changed.includes('sector') ? { sector: input.sector } : {}),
      ...(changed.includes('status') ? { status: input.status } : {}),
      sessionsRevoked: revokes,
    },
  });

  // Every access-level change gets its own entry: who, whom, from what, to what.
  if (input.role !== undefined && roleChanges) {
    await writeAudit(db, {
      actorEmployeeId: actor.employeeId,
      action: 'employee.role_changed',
      entity: 'employee',
      entityId: id,
      targetEmployeeId: id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { previousRole: currentRole, newRole: input.role },
    });
  }

  const row = await fetchRow(db, id);
  return row ? { ok: true, value: toView(row, cpfCrypto) } : { ok: false, reason: 'not_found' };
}

/**
 * Returns the full CPF. Separate endpoint on purpose: it needs its own
 * permission, it is always audited, and it never appears in a URL or a list
 * response (LGPD).
 */
export async function revealCpf(
  db: Database,
  actor: Actor,
  cpfCrypto: CpfCrypto,
  id: string,
  ctx: RequestContext = {},
): Promise<Result<{ cpf: string }>> {
  const row = await fetchRow(db, id);
  if (!row) return { ok: false, reason: 'not_found' };

  const sector = row.sector_slug as SectorSlug;
  if (!can(actor, 'employees.read', { sector }).allowed) return { ok: false, reason: 'not_found' };
  if (!can(actor, 'employees.pii.view', { sector }).allowed) {
    return { ok: false, reason: 'forbidden' };
  }

  let cpf: string;
  try {
    cpf = cpfCrypto.decrypt(row.cpf_encrypted);
  } catch {
    return { ok: false, reason: 'not_found' };
  }

  await writeAudit(db, {
    actorEmployeeId: actor.employeeId,
    action: 'employee.cpf_revealed',
    entity: 'employee',
    entityId: id,
    targetEmployeeId: id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { sector },
  });

  return { ok: true, value: { cpf } };
}
