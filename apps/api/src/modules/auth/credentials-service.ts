import {
  EMAIL_CHANGE_NOTICE_FAILURE_MESSAGE,
  INVITE_EXPIRY_DAYS,
  RESET_EXPIRY_MINUTES,
  passwordLooksPersonal,
  type CredentialTokenPurpose,
  type EmailChangeNoticeFailureCode,
  type EmailChangeOutcome,
} from '@wings/shared';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { credentialTokens, employeeCredentials } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { inviteMail, loginEmailChangedMail, resetMail, type Mailer } from '../../lib/mailer.js';
import { hashPassword } from '../../lib/password.js';
import { generateToken, hashToken } from '../../lib/tokens.js';
import { revokeAllSessions, type RequestContext } from './service.js';

/** Raw row shape; db.execute requires an index signature. */
type EmployeeContact = {
  id: string;
  full_name: string;
  email: string;
  status: 'active' | 'inactive' | 'on_leave';
} & Record<string, unknown>;

async function findContact(db: Database, where: 'id' | 'email', value: string) {
  const rows = await db.execute<EmployeeContact>(
    where === 'id'
      ? sql`select id, full_name, email, status from employees where id = ${value} limit 1`
      : sql`select id, full_name, email, status from employees where lower(email) = ${value.toLowerCase()} limit 1`,
  );
  return rows.rows[0] ?? null;
}

async function issueToken(
  db: Database,
  args: {
    employeeId: string;
    purpose: CredentialTokenPurpose;
    expiresAt: Date;
    createdBy?: string | null;
  },
): Promise<string> {
  // Previous unused tokens of the same purpose are burned, so only the newest
  // link works — a re-sent invite invalidates the old one.
  await db
    .update(credentialTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(credentialTokens.employeeId, args.employeeId),
        eq(credentialTokens.purpose, args.purpose),
        isNull(credentialTokens.usedAt),
      ),
    );

  const token = generateToken();
  await db.insert(credentialTokens).values({
    employeeId: args.employeeId,
    purpose: args.purpose,
    tokenHash: hashToken(token),
    expiresAt: args.expiresAt,
    createdBy: args.createdBy ?? null,
  });
  return token;
}

function buildLink(baseUrl: string, token: string, purpose: CredentialTokenPurpose): string {
  const path = purpose === 'invite' ? '/definir-senha' : '/redefinir-senha';
  const url = new URL(path, baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Sends the initial "set your password" invite. Called when an employee is
 * created, and again if the link needs re-sending. Admins never choose or see
 * anyone's password.
 */
export async function createInviteLink(
  db: Database,
  args: { employeeId: string; baseUrl: string; actorId?: string | null },
): Promise<{ link: string; email: string; name: string; expiresAt: Date } | null> {
  const employee = await findContact(db, 'id', args.employeeId);
  if (!employee || employee.status === 'inactive') return null;

  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 3600_000);
  const token = await issueToken(db, {
    employeeId: employee.id,
    purpose: 'invite',
    expiresAt,
    createdBy: args.actorId ?? null,
  });

  return {
    link: buildLink(args.baseUrl, token, 'invite'),
    email: employee.email,
    name: employee.full_name,
    expiresAt,
  };
}

export async function sendInvite(
  db: Database,
  mailer: Mailer,
  args: { employeeId: string; baseUrl: string; actorId: string; ctx?: RequestContext },
): Promise<{ sent: boolean }> {
  const invite = await createInviteLink(db, args);
  if (!invite) return { sent: false };
  const { link, email, name, expiresAt } = invite;

  await mailer.send(inviteMail({ to: email, name, link, days: INVITE_EXPIRY_DAYS }));

  await writeAudit(db, {
    actorEmployeeId: args.actorId,
    action: 'credentials.invite_sent',
    entity: 'employee',
    entityId: args.employeeId,
    targetEmployeeId: args.employeeId,
    ip: args.ctx?.ip,
    userAgent: args.ctx?.userAgent,
    metadata: { expiresAt: expiresAt.toISOString() },
  });

  return { sent: true };
}

/**
 * Burns every invite or reset link of this employee that still works. Called
 * when the login e-mail changes: a link mailed to the old address must not set
 * the password of an account that now answers to another one.
 */
export async function cancelPendingLinks(db: Database, employeeId: string): Promise<number> {
  const now = new Date();
  const burned = await db
    .update(credentialTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(credentialTokens.employeeId, employeeId),
        isNull(credentialTokens.usedAt),
        gt(credentialTokens.expiresAt, now),
      ),
    )
    .returning({ id: credentialTokens.id });
  return burned.length;
}

/**
 * Warns the previous login address that it changed. Never throws: the change is
 * already saved, and the operator is told plainly whether the warning went out.
 * The audit entry carries the outcome, never an address.
 */
export async function notifyLoginEmailChanged(
  db: Database,
  mailer: Mailer,
  args: {
    employeeId: string;
    name: string;
    previousEmail: string;
    actorId: string;
    ctx?: RequestContext;
    onSendError?: (error: unknown) => void;
  },
): Promise<EmailChangeOutcome['notice']> {
  let failure: EmailChangeNoticeFailureCode | null = null;
  if (!mailer.enabled) {
    failure = 'email_not_configured';
  } else {
    try {
      await mailer.send(
        loginEmailChangedMail({
          to: args.previousEmail,
          name: args.name,
          at: new Date(),
        }),
      );
    } catch (error) {
      args.onSendError?.(error);
      failure = 'send_failed';
    }
  }

  await writeAudit(db, {
    actorEmployeeId: args.actorId,
    action: 'credentials.email_change_notified',
    entity: 'employee',
    entityId: args.employeeId,
    targetEmployeeId: args.employeeId,
    ip: args.ctx?.ip,
    userAgent: args.ctx?.userAgent,
    metadata: failure ? { delivered: false, reason: failure } : { delivered: true },
  });

  return failure
    ? {
        sent: false,
        error: { code: failure, message: EMAIL_CHANGE_NOTICE_FAILURE_MESSAGE[failure] },
      }
    : { sent: true };
}

/**
 * Self-service password reset. Always reports success to the caller: whether
 * the address exists is not something an anonymous request may learn.
 */
export async function requestPasswordReset(
  db: Database,
  mailer: Mailer,
  args: { email: string; baseUrl: string; ctx?: RequestContext },
): Promise<void> {
  const employee = await findContact(db, 'email', args.email);

  if (!employee || employee.status === 'inactive') {
    await writeAudit(db, {
      action: 'credentials.reset_requested',
      entity: 'employee',
      ip: args.ctx?.ip,
      userAgent: args.ctx?.userAgent,
      metadata: { delivered: false, reason: employee ? 'inactive' : 'unknown_email' },
    });
    return;
  }

  const expiresAt = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60_000);
  const token = await issueToken(db, {
    employeeId: employee.id,
    purpose: 'reset',
    expiresAt,
  });

  // A failing SMTP must not answer differently for an existing address, nor carry the server's
  // words (which often quote the address) to the caller or the log (security audit A10).
  let failure: string | null = null;
  try {
    await mailer.send(
      resetMail({
        to: employee.email,
        name: employee.full_name,
        link: buildLink(args.baseUrl, token, 'reset'),
        minutes: RESET_EXPIRY_MINUTES,
      }),
    );
  } catch (error) {
    failure = error instanceof Error ? error.name : 'unknown';
  }

  await writeAudit(db, {
    actorEmployeeId: employee.id,
    action: 'credentials.reset_requested',
    entity: 'employee',
    entityId: employee.id,
    targetEmployeeId: employee.id,
    ip: args.ctx?.ip,
    userAgent: args.ctx?.userAgent,
    metadata: failure
      ? { delivered: false, reason: 'smtp_failed', error: failure }
      : { delivered: true, expiresAt: expiresAt.toISOString() },
  });
}

export type SetPasswordFailure = 'invalid_token' | 'expired_token' | 'weak_password';

export type SetPasswordResult =
  | { ok: true; purpose: CredentialTokenPurpose; employeeId: string }
  | { ok: false; reason: SetPasswordFailure };

/**
 * Consumes an invite or reset link and sets the password.
 *
 * The token is single-use and every existing session of that employee is
 * revoked, so a password change also kicks out whoever might be holding a
 * stolen session.
 */
export async function setPasswordWithToken(
  db: Database,
  args: { token: string; password: string; ctx?: RequestContext },
): Promise<SetPasswordResult> {
  const tokenHash = hashToken(args.token);
  const record = await db.query.credentialTokens.findFirst({
    where: eq(credentialTokens.tokenHash, tokenHash),
  });

  if (!record || record.usedAt) return { ok: false, reason: 'invalid_token' };
  if (record.expiresAt <= new Date()) return { ok: false, reason: 'expired_token' };

  const employee = await findContact(db, 'id', record.employeeId);
  if (!employee || employee.status === 'inactive') return { ok: false, reason: 'invalid_token' };
  if (passwordLooksPersonal(args.password, employee.email)) {
    return { ok: false, reason: 'weak_password' };
  }

  // Single-use: claim the token first, so two concurrent submissions cannot
  // both succeed.
  const claimed = await db
    .update(credentialTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(credentialTokens.id, record.id), isNull(credentialTokens.usedAt)))
    .returning({ id: credentialTokens.id });
  if (claimed.length === 0) return { ok: false, reason: 'invalid_token' };

  const passwordHash = await hashPassword(args.password);
  const now = new Date();
  await db
    .insert(employeeCredentials)
    .values({
      employeeId: employee.id,
      passwordHash,
      passwordSetAt: now,
      failedAttempts: 0,
      lockedUntil: null,
    })
    .onConflictDoUpdate({
      target: employeeCredentials.employeeId,
      set: {
        passwordHash,
        passwordSetAt: now,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: now,
      },
    });

  await revokeAllSessions(db, employee.id, 'password_changed');

  await writeAudit(db, {
    actorEmployeeId: employee.id,
    action: 'credentials.password_set',
    entity: 'employee',
    entityId: employee.id,
    targetEmployeeId: employee.id,
    ip: args.ctx?.ip,
    userAgent: args.ctx?.userAgent,
    metadata: { purpose: record.purpose },
  });

  return { ok: true, purpose: record.purpose, employeeId: employee.id };
}
