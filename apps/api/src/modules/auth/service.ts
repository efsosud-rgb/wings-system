import {
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_ATTEMPTS,
  SESSION_ABSOLUTE_HOURS,
  SESSION_IDLE_MINUTES,
  grantedScope,
  tracksTime,
  type Actor,
  type PermissionKey,
  type RoleKey,
  type Scope,
  type SectorSlug,
  type SessionUser,
} from '@wings/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { employeeCredentials, employees, sessions } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { fakeVerify, verifyPassword } from '../../lib/password.js';
import { generateToken, hashToken } from '../../lib/tokens.js';
import { recordLogin, recordLogout, recordSessionTimeout } from '../timeclock/service.js';
import { PERMISSION_KEYS } from '@wings/shared';

export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface LoginSuccess {
  ok: true;
  token: string;
  expiresAt: Date;
  user: SessionUser;
}

export type LoginFailureReason = 'invalid_credentials' | 'account_locked' | 'account_inactive';

export interface LoginFailure {
  ok: false;
  reason: LoginFailureReason;
  /** Only set for account_locked, so the UI can say how long to wait. */
  retryAfterSeconds?: number;
}

export type LoginResult = LoginSuccess | LoginFailure;

interface EmployeeRow {
  id: string;
  fullName: string;
  email: string;
  cargo: string;
  status: 'active' | 'inactive' | 'on_leave';
  isSectorManager: boolean;
  lastLoginAt: Date | null;
  roleKey: RoleKey;
  sectorSlug: SectorSlug;
}

/**
 * Raw SQL rows can hand back timestamps as strings, so every mapping goes
 * through here rather than trusting the driver to produce Date objects.
 */
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

async function findEmployeeByEmail(db: Database, email: string): Promise<EmployeeRow | null> {
  const rows = await db.execute<{
    id: string;
    full_name: string;
    email: string;
    cargo: string;
    status: 'active' | 'inactive' | 'on_leave';
    is_sector_manager: boolean;
    last_login_at: Date | string | null;
    role_key: string;
    sector_slug: string;
  }>(sql`
    select e.id, e.full_name, e.email, e.cargo, e.status, e.is_sector_manager, e.last_login_at,
           r.key as role_key, s.slug as sector_slug
    from employees e
    join roles r on r.id = e.role_id
    join sectors s on s.id = e.sector_id
    where lower(e.email) = ${email.toLowerCase()}
    limit 1
  `);

  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    cargo: row.cargo,
    status: row.status,
    isSectorManager: row.is_sector_manager,
    lastLoginAt: toDate(row.last_login_at),
    roleKey: row.role_key as RoleKey,
    sectorSlug: row.sector_slug as SectorSlug,
  };
}

export function actorFrom(employee: EmployeeRow): Actor {
  return {
    employeeId: employee.id,
    role: employee.roleKey,
    sector: employee.sectorSlug,
    isSectorManager: employee.isSectorManager,
  };
}

function effectivePermissions(actor: Actor): Partial<Record<PermissionKey, Scope>> {
  const result: Partial<Record<PermissionKey, Scope>> = {};
  for (const permission of PERMISSION_KEYS) {
    const scope = grantedScope(actor, permission);
    if (scope) result[permission] = scope;
  }
  return result;
}

function toSessionUser(employee: EmployeeRow, expiresAt: Date): SessionUser {
  const actor = actorFrom(employee);
  return {
    employeeId: employee.id,
    fullName: employee.fullName,
    email: employee.email,
    cargo: employee.cargo,
    role: employee.roleKey,
    sector: employee.sectorSlug,
    isSectorManager: employee.isSectorManager,
    tracksTime: tracksTime(employee.roleKey),
    permissions: effectivePermissions(actor),
    lastLoginAt: employee.lastLoginAt ? employee.lastLoginAt.toISOString() : null,
    sessionExpiresAt: expiresAt.toISOString(),
  };
}

/**
 * Password login.
 *
 * Failures are deliberately indistinguishable from the outside: a wrong
 * password, an unknown e-mail and a credential-less account all return
 * `invalid_credentials` after comparable work.
 */
export async function login(
  db: Database,
  input: { email: string; password: string },
  ctx: RequestContext = {},
): Promise<LoginResult> {
  const employee = await findEmployeeByEmail(db, input.email);

  if (!employee) {
    await fakeVerify();
    await writeAudit(db, {
      action: 'session.login_failed',
      entity: 'session',
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'unknown_email' },
    });
    return { ok: false, reason: 'invalid_credentials' };
  }

  const credentials = await db.query.employeeCredentials.findFirst({
    where: eq(employeeCredentials.employeeId, employee.id),
  });

  const now = new Date();
  if (credentials?.lockedUntil && credentials.lockedUntil > now) {
    await writeAudit(db, {
      actorEmployeeId: employee.id,
      action: 'session.login_failed',
      entity: 'session',
      targetEmployeeId: employee.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'locked' },
    });
    return {
      ok: false,
      reason: 'account_locked',
      retryAfterSeconds: Math.ceil((credentials.lockedUntil.getTime() - now.getTime()) / 1000),
    };
  }

  const passwordOk = credentials?.passwordHash
    ? await verifyPassword(credentials.passwordHash, input.password)
    : (await fakeVerify(), false);

  if (!passwordOk) {
    await registerFailedAttempt(db, employee.id, credentials?.failedAttempts ?? 0);
    await writeAudit(db, {
      actorEmployeeId: employee.id,
      action: 'session.login_failed',
      entity: 'session',
      targetEmployeeId: employee.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: credentials?.passwordHash ? 'wrong_password' : 'no_credentials' },
    });
    return { ok: false, reason: 'invalid_credentials' };
  }

  // Deactivated employees keep their record but lose access immediately.
  if (employee.status === 'inactive') {
    await writeAudit(db, {
      actorEmployeeId: employee.id,
      action: 'session.login_denied',
      entity: 'session',
      targetEmployeeId: employee.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'inactive' },
    });
    return { ok: false, reason: 'account_inactive' };
  }

  await db
    .update(employeeCredentials)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: now })
    .where(eq(employeeCredentials.employeeId, employee.id));

  const token = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_HOURS * 3600_000);
  const sessionId = hashToken(token);

  await db.insert(sessions).values({
    id: sessionId,
    employeeId: employee.id,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  });

  await db.update(employees).set({ lastLoginAt: now }).where(eq(employees.id, employee.id));

  const clocked = await recordLogin(db, {
    employeeId: employee.id,
    role: employee.roleKey,
    sessionId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    occurredAt: now,
  });

  await writeAudit(db, {
    actorEmployeeId: employee.id,
    action: 'session.login',
    entity: 'session',
    entityId: sessionId,
    targetEmployeeId: employee.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { timeEntryCreated: clocked },
  });

  return { ok: true, token, expiresAt, user: toSessionUser(employee, expiresAt) };
}

async function registerFailedAttempt(
  db: Database,
  employeeId: string,
  currentFailures: number,
): Promise<void> {
  const attempts = currentFailures + 1;
  const locked = attempts >= LOGIN_MAX_ATTEMPTS;
  await db
    .insert(employeeCredentials)
    .values({
      employeeId,
      failedAttempts: attempts,
      lockedUntil: locked ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000) : null,
    })
    .onConflictDoUpdate({
      target: employeeCredentials.employeeId,
      set: {
        failedAttempts: attempts,
        lockedUntil: locked ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000) : null,
        updatedAt: new Date(),
      },
    });
}

export interface ResolvedSession {
  sessionId: string;
  employee: EmployeeRow;
  actor: Actor;
  expiresAt: Date;
  user: SessionUser;
}

/**
 * Validates the cookie token. Returns null for anything unusable: unknown,
 * revoked, idle-expired, absolute-expired, or belonging to a deactivated
 * employee. An idle-expired session is closed here, which is what produces the
 * `session_timeout` clock-out at the last activity time.
 */
export async function resolveSession(
  db: Database,
  token: string,
  ctx: RequestContext = {},
): Promise<ResolvedSession | null> {
  const sessionId = hashToken(token);
  const session = await db.query.sessions.findFirst({
    where: and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)),
  });
  if (!session) return null;

  const now = new Date();
  const idleDeadline = new Date(session.lastSeenAt.getTime() + SESSION_IDLE_MINUTES * 60_000);

  if (now > session.expiresAt || now > idleDeadline) {
    const timedOut = now > idleDeadline && now <= session.expiresAt;
    await closeSession(db, {
      sessionId,
      employeeId: session.employeeId,
      at: timedOut ? session.lastSeenAt : session.expiresAt,
      source: 'session_timeout',
      ctx,
    });
    return null;
  }

  const employee = await findEmployeeById(db, session.employeeId);
  if (!employee || employee.status === 'inactive') {
    await closeSession(db, {
      sessionId,
      employeeId: session.employeeId,
      at: now,
      source: 'session_timeout',
      ctx,
    });
    return null;
  }

  // Throttled write: refreshing on every request would be a write per call.
  if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));
  }

  return {
    sessionId,
    employee,
    actor: actorFrom(employee),
    expiresAt: session.expiresAt,
    user: toSessionUser(employee, session.expiresAt),
  };
}

async function findEmployeeById(db: Database, id: string): Promise<EmployeeRow | null> {
  const rows = await db.execute<{
    id: string;
    full_name: string;
    email: string;
    cargo: string;
    status: 'active' | 'inactive' | 'on_leave';
    is_sector_manager: boolean;
    last_login_at: Date | string | null;
    role_key: string;
    sector_slug: string;
  }>(sql`
    select e.id, e.full_name, e.email, e.cargo, e.status, e.is_sector_manager, e.last_login_at,
           r.key as role_key, s.slug as sector_slug
    from employees e
    join roles r on r.id = e.role_id
    join sectors s on s.id = e.sector_id
    where e.id = ${id}
    limit 1
  `);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    cargo: row.cargo,
    status: row.status,
    isSectorManager: row.is_sector_manager,
    lastLoginAt: toDate(row.last_login_at),
    roleKey: row.role_key as RoleKey,
    sectorSlug: row.sector_slug as SectorSlug,
  };
}

async function closeSession(
  db: Database,
  args: {
    sessionId: string;
    employeeId: string;
    at: Date;
    source: 'logout' | 'session_timeout';
    ctx: RequestContext;
  },
): Promise<boolean> {
  const updated = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, args.sessionId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  // Another request may have closed it first; only the winner writes the
  // clock-out, so a session can never produce two closing entries.
  if (updated.length === 0) return false;

  const employee = await findEmployeeById(db, args.employeeId);
  if (!employee) return true;

  const entry = {
    employeeId: args.employeeId,
    role: employee.roleKey,
    sessionId: args.sessionId,
    ip: args.ctx.ip,
    userAgent: args.ctx.userAgent,
    occurredAt: args.at,
  };
  const clocked =
    args.source === 'logout'
      ? await recordLogout(db, entry)
      : await recordSessionTimeout(db, entry);

  await writeAudit(db, {
    actorEmployeeId: args.employeeId,
    action: args.source === 'logout' ? 'session.logout' : 'session.timeout',
    entity: 'session',
    entityId: args.sessionId,
    targetEmployeeId: args.employeeId,
    ip: args.ctx.ip,
    userAgent: args.ctx.userAgent,
    metadata: { timeEntryCreated: clocked },
  });
  return true;
}

export async function logout(db: Database, token: string, ctx: RequestContext = {}): Promise<void> {
  const sessionId = hashToken(token);
  const session = await db.query.sessions.findFirst({
    where: and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)),
  });
  if (!session) return;

  await closeSession(db, {
    sessionId,
    employeeId: session.employeeId,
    at: new Date(),
    source: 'logout',
    ctx,
  });
}

/**
 * Revokes every active session of an employee. Called when an employee is
 * deactivated or their role changes, so access ends immediately rather than at
 * the next token expiry.
 */
export async function revokeAllSessions(
  db: Database,
  employeeId: string,
  reason: string,
): Promise<number> {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.employeeId, employeeId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  if (revoked.length > 0) {
    await writeAudit(db, {
      actorEmployeeId: null,
      action: 'session.revoked_all',
      entity: 'session',
      targetEmployeeId: employeeId,
      metadata: { reason, count: revoked.length },
    });
  }
  return revoked.length;
}
