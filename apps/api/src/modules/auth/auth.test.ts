import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, SESSION_IDLE_MINUTES } from '@wings/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog, sessions, timeEntries } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { revokeAllSessions } from './service.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: randomBytes(48).toString('base64'),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
    }),
    db,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function loginAs(email: string, password: string) {
  return app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
}

function cookieFrom(response: Awaited<ReturnType<typeof loginAs>>): string {
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error('session cookie missing');
  return cookie.value;
}

describe('POST /auth/login', () => {
  it('signs in with correct credentials and returns the session user', async () => {
    const employee = await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
    const res = await loginAs(employee.email, employee.password);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({
      employeeId: employee.id,
      role: 'gerente_comercial',
      sector: 'comercial',
      tracksTime: true,
    });
    // Permissions are sent for UI hiding only; the funnel scope must be 'all'.
    expect(body.user.permissions['leads.read']).toBe('all');
    expect(body.user.permissions['settings.manage']).toBeUndefined();
  });

  it('sets an httpOnly, SameSite=Lax session cookie', async () => {
    const employee = await createEmployee(db);
    const res = await loginAs(employee.email, employee.password);
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);

    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax');
    expect(cookie?.path).toBe('/');
  });

  it('never stores the raw token: the cookie value is not the row id', async () => {
    const employee = await createEmployee(db);
    const token = cookieFrom(await loginAs(employee.email, employee.password));

    const stored = await db.query.sessions.findFirst({
      where: eq(sessions.employeeId, employee.id),
    });
    expect(stored).toBeDefined();
    expect(stored?.id).not.toBe(token);
  });

  it('rejects a wrong password and an unknown e-mail identically', async () => {
    const employee = await createEmployee(db);
    const wrongPassword = await loginAs(employee.email, 'senha-errada-123');
    const unknownEmail = await loginAs('ninguem@wingscompany.com.br', 'senha-de-teste-123');

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });

  it('rejects an account with no password set', async () => {
    const employee = await createEmployee(db, { password: null });
    const res = await loginAs(employee.email, 'qualquer-senha-123');
    expect(res.statusCode).toBe(401);
  });

  it('refuses a deactivated employee even with the right password', async () => {
    const employee = await createEmployee(db, { status: 'inactive' });
    const res = await loginAs(employee.email, employee.password);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('account_inactive');
  });

  it('locks the account after repeated failures', async () => {
    const employee = await createEmployee(db);
    for (let attempt = 0; attempt < 5; attempt++) {
      await loginAs(employee.email, 'senha-errada-123');
    }
    // Correct password now, but the account is locked.
    const res = await loginAs(employee.email, employee.password);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('account_locked');
    expect(res.json().retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts every wrong password of a parallel burst, and locks (security audit A6)', async () => {
    const employee = await createEmployee(db);
    const burst = await Promise.all(
      Array.from({ length: 20 }, () => loginAs(employee.email, 'senha-errada-123')),
    );
    // A request that reads the account after the 5th failure locked it is refused uncounted (CI
    // under load, 29/10): every wrong password checked is counted, none lost to the race.
    const checked = burst.filter((res) => res.json().error === 'invalid_credentials').length;
    expect(checked).toBeGreaterThanOrEqual(5);
    expect(burst.length - checked).toBe(
      burst.filter((res) => res.json().error === 'account_locked').length,
    );
    const credentials = await db.query.employeeCredentials.findFirst({
      where: eq(sql`employee_id`, employee.id),
    });
    expect(credentials?.failedAttempts).toBe(checked);
    const res = await loginAs(employee.email, employee.password);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('account_locked');
  });

  it('clears the failure counter after a successful login', async () => {
    const employee = await createEmployee(db);
    await loginAs(employee.email, 'senha-errada-123');
    await loginAs(employee.email, 'senha-errada-123');
    expect((await loginAs(employee.email, employee.password)).statusCode).toBe(200);

    const credentials = await db.query.employeeCredentials.findFirst({
      where: eq(sql`employee_id`, employee.id),
    });
    expect(credentials?.failedAttempts).toBe(0);
  });
});

describe('GET /auth/me', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a forged token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { [SESSION_COOKIE]: randomBytes(32).toString('base64url') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns the current user for a valid session', async () => {
    const employee = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
    const token = cookieFrom(await loginAs(employee.email, employee.password));

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.employeeId).toBe(employee.id);
  });
});

describe('POST /auth/logout', () => {
  it('ends the session', async () => {
    const employee = await createEmployee(db);
    const token = cookieFrom(await loginAs(employee.email, employee.password));

    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(out.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(after.statusCode).toBe(401);
  });

  it('succeeds without a session cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(200);
  });
});

describe('time clock integration', () => {
  it('creates a clock_in on login and a clock_out on logout', async () => {
    const employee = await createEmployee(db, { role: 'vendedor_formatacao' });
    const token = cookieFrom(await loginAs(employee.email, employee.password));

    const afterLogin = await db.query.timeEntries.findMany({
      where: eq(timeEntries.employeeId, employee.id),
    });
    expect(afterLogin).toHaveLength(1);
    expect(afterLogin[0]).toMatchObject({ kind: 'clock_in', source: 'login' });

    await app.inject({ method: 'POST', url: '/auth/logout', cookies: { [SESSION_COOKIE]: token } });

    const afterLogout = await db.query.timeEntries.findMany({
      where: eq(timeEntries.employeeId, employee.id),
    });
    expect(afterLogout).toHaveLength(2);
    expect(afterLogout.some((e) => e.kind === 'clock_out' && e.source === 'logout')).toBe(true);
  });

  it('exempts Admin Master and Diretoria', async () => {
    for (const role of ['admin_master', 'diretoria'] as const) {
      const employee = await createEmployee(db, { role, sector: 'diretoria' });
      const token = cookieFrom(await loginAs(employee.email, employee.password));
      await app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: { [SESSION_COOKIE]: token },
      });

      const entries = await db.query.timeEntries.findMany({
        where: eq(timeEntries.employeeId, employee.id),
      });
      expect(entries, `${role} must not be time-tracked`).toHaveLength(0);
    }
  });

  it('closes an idle session with a session_timeout entry at the last activity', async () => {
    const employee = await createEmployee(db);
    const token = cookieFrom(await loginAs(employee.email, employee.password));

    // Age the session past the idle window.
    const lastSeen = new Date(Date.now() - (SESSION_IDLE_MINUTES + 5) * 60_000);
    await db
      .update(sessions)
      .set({ lastSeenAt: lastSeen })
      .where(eq(sessions.employeeId, employee.id));

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(401);

    const entries = await db.query.timeEntries.findMany({
      where: and(eq(timeEntries.employeeId, employee.id), eq(timeEntries.kind, 'clock_out')),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('session_timeout');
    // The clock-out must be the last activity, not "now".
    expect(Math.abs((entries[0]?.occurredAt.getTime() ?? 0) - lastSeen.getTime())).toBeLessThan(
      2000,
    );
  });

  it('does not double-close a session', async () => {
    const employee = await createEmployee(db);
    const token = cookieFrom(await loginAs(employee.email, employee.password));
    const cookies = { [SESSION_COOKIE]: token };

    await app.inject({ method: 'POST', url: '/auth/logout', cookies });
    await app.inject({ method: 'POST', url: '/auth/logout', cookies });

    const entries = await db.query.timeEntries.findMany({
      where: and(eq(timeEntries.employeeId, employee.id), eq(timeEntries.kind, 'clock_out')),
    });
    expect(entries).toHaveLength(1);
  });
});

describe('session revocation', () => {
  it('ends active sessions immediately', async () => {
    const employee = await createEmployee(db);
    const token = cookieFrom(await loginAs(employee.email, employee.password));

    const revoked = await revokeAllSessions(db, employee.id, 'role_changed');
    expect(revoked).toBe(1);

    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('audit trail', () => {
  it('records logins, failures and logouts without personal data', async () => {
    const employee = await createEmployee(db);
    await loginAs(employee.email, 'senha-errada-123');
    const token = cookieFrom(await loginAs(employee.email, employee.password));
    await app.inject({ method: 'POST', url: '/auth/logout', cookies: { [SESSION_COOKIE]: token } });

    const entries = await db.query.auditLog.findMany({
      where: eq(auditLog.targetEmployeeId, employee.id),
    });
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('session.login_failed');
    expect(actions).toContain('session.login');
    expect(actions).toContain('session.logout');

    // audit_log.id is a bigint, so serialize with a BigInt-aware replacer.
    const serialized = JSON.stringify(entries, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialized).not.toContain(employee.email);
    expect(serialized).not.toContain('Funcionário de Teste');
  });
});

describe('audited employees cannot be erased by deletion', () => {
  it('refuses a hard delete and expects anonymisation instead', async () => {
    const employee = await createEmployee(db);
    await loginAs(employee.email, employee.password); // creates audit rows

    // Drizzle wraps driver errors, so the Postgres text sits on the cause.
    const error: unknown = await db
      .execute(sql`delete from employees where id = ${employee.id}`)
      .then(() => null)
      .catch((e: unknown) => e);
    const message = [
      error instanceof Error ? error.message : String(error),
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    ].join(' ');
    expect(message).toMatch(/violates foreign key constraint/i);

    // The LGPD path is anonymising the record, which must still work.
    await db.execute(sql`
      update employees
         set full_name = 'Anonimizado',
             email = ${'anon-' + employee.id + '@invalid.local'},
             phone = '00000000000',
             status = 'inactive',
             deactivated_at = now()
       where id = ${employee.id}
    `);

    const after = await db.execute<{ full_name: string }>(
      sql`select full_name from employees where id = ${employee.id}`,
    );
    expect(after.rows[0]?.full_name).toBe('Anonimizado');

    // The audit trail still points at the (now anonymous) employee.
    const trail = await db.query.auditLog.findMany({
      where: eq(auditLog.targetEmployeeId, employee.id),
    });
    expect(trail.length).toBeGreaterThan(0);
  });
});

describe('CSRF protection', () => {
  it('rejects an unsafe request from a foreign origin', async () => {
    const employee = await createEmployee(db);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'https://evil.example.com', host: 'staging.wingssystem.online' },
      payload: { email: employee.email, password: employee.password },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('bad_origin');
  });

  it('allows a same-origin request', async () => {
    const employee = await createEmployee(db);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: 'https://staging.wingssystem.online', host: 'staging.wingssystem.online' },
      payload: { email: employee.email, password: employee.password },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('frame protection', () => {
  it('lets only this system frame an answer, errors and unknown routes included', async () => {
    const employee = await createEmployee(db);
    const answers = [
      await app.inject({ method: 'GET', url: '/health' }),
      await app.inject({ method: 'GET', url: '/rota-que-nao-existe' }),
      await app.inject({ method: 'GET', url: '/auth/me' }),
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { origin: 'https://evil.example.com', host: 'staging.wingssystem.online' },
        payload: { email: employee.email, password: employee.password },
      }),
    ];
    expect(answers.map((res) => res.statusCode)).toEqual([200, 404, 401, 403]);
    for (const res of answers) {
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    }
  });
});
