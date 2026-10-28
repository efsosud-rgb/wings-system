import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog, credentialTokens } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import type { Mail, Mailer } from '../../lib/mailer.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

const BASE_URL = 'https://staging.wingssystem.online';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let outbox: Mail[] = [];
/** When set, the SMTP server refuses the message, quoting the address as real servers do. */
let smtpRefuses = false;

const testMailer: Mailer = {
  enabled: true,
  send: async (mail) => {
    if (smtpRefuses) throw new Error(`550 5.1.1 <${mail.to}>: Recipient address rejected`);
    outbox.push(mail);
  },
};

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
      APP_BASE_URL: BASE_URL,
    }),
    db,
    mailer: testMailer,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(() => {
  outbox = [];
  smtpRefuses = false;
});

function tokenFromLastMail(): string {
  const mail = outbox.at(-1);
  if (!mail) throw new Error('no e-mail was sent');
  const match = mail.text.match(/https?:\/\/\S+/);
  if (!match) throw new Error('no link in e-mail');
  const token = new URL(match[0]).searchParams.get('token');
  if (!token) throw new Error('no token in link');
  return token;
}

async function loginAs(email: string, password: string) {
  return app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
}

async function sessionCookieFor(role: 'admin_master' | 'vendedor_expansao') {
  const actor = await createEmployee(db, {
    role,
    sector: role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  const res = await loginAs(actor.email, actor.password);
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error('login failed in test setup');
  return { actor, cookie: { [SESSION_COOKIE]: cookie.value } };
}

async function managerCookie(role: 'marketing', sector: 'marketing') {
  const actor = await createEmployee(db, { role, sector, isSectorManager: true });
  const res = await loginAs(actor.email, actor.password);
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error('login failed in test setup');
  return { [SESSION_COOKIE]: cookie.value };
}

describe('POST /auth/invite', () => {
  it('requires the employees.create permission', async () => {
    const target = await createEmployee(db, { password: null });
    const { cookie } = await sessionCookieFor('vendedor_expansao');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/invite',
      cookies: cookie,
      payload: { employeeId: target.id },
    });
    expect(res.statusCode).toBe(403);
    expect(outbox).toHaveLength(0);
  });

  it('does not let a sector manager invite someone outside their sector', async () => {
    const outsider = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const cookies = await managerCookie('marketing', 'marketing');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/invite',
      cookies,
      payload: { employeeId: outsider.id },
    });
    expect(res.statusCode).toBe(404);
    expect(outbox).toHaveLength(0);
    const tokens = await db
      .select()
      .from(credentialTokens)
      .where(eq(credentialTokens.employeeId, outsider.id));
    expect(tokens).toHaveLength(0);
  });

  it('lets a sector manager invite inside their own sector', async () => {
    const insider = await createEmployee(db, {
      role: 'marketing',
      sector: 'marketing',
      password: null,
    });
    const cookies = await managerCookie('marketing', 'marketing');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/invite',
      cookies,
      payload: { employeeId: insider.id },
    });
    expect(res.statusCode).toBe(200);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.to).toBe(insider.email);
  });

  it('requires authentication', async () => {
    const target = await createEmployee(db, { password: null });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/invite',
      payload: { employeeId: target.id },
    });
    expect(res.statusCode).toBe(401);
  });

  it('sends an invite that lets the employee set their first password', async () => {
    const target = await createEmployee(db, { password: null });
    const { cookie } = await sessionCookieFor('admin_master');

    const invite = await app.inject({
      method: 'POST',
      url: '/auth/invite',
      cookies: cookie,
      payload: { employeeId: target.id },
    });
    expect(invite.statusCode).toBe(200);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.to).toBe(target.email);
    expect(outbox[0]?.subject).toContain('Wings System');

    const token = tokenFromLastMail();
    const set = await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token, password: 'uma-senha-bem-longa-2026' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().purpose).toBe('invite');

    // The employee can now sign in with the password they chose.
    const login = await loginAs(target.email, 'uma-senha-bem-longa-2026');
    expect(login.statusCode).toBe(200);
  });

  it('invalidates the previous link when an invite is re-sent', async () => {
    const target = await createEmployee(db, { password: null });
    const { cookie } = await sessionCookieFor('admin_master');
    const payload = { employeeId: target.id };

    await app.inject({ method: 'POST', url: '/auth/invite', cookies: cookie, payload });
    const firstToken = tokenFromLastMail();
    await app.inject({ method: 'POST', url: '/auth/invite', cookies: cookie, payload });
    const secondToken = tokenFromLastMail();
    expect(secondToken).not.toBe(firstToken);

    const old = await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token: firstToken, password: 'outra-senha-bem-longa-1' },
    });
    expect(old.statusCode).toBe(410);
  });

  it('refuses to invite a deactivated employee', async () => {
    const target = await createEmployee(db, { status: 'inactive', password: null });
    const { cookie } = await sessionCookieFor('admin_master');

    const res = await app.inject({
      method: 'POST',
      url: '/auth/invite',
      cookies: cookie,
      payload: { employeeId: target.id },
    });
    expect(res.statusCode).toBe(404);
    expect(outbox).toHaveLength(0);
  });
});

describe('POST /auth/forgot-password', () => {
  it('answers 202 and sends nothing for an unknown address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'ninguem@wingscompany.com.br' },
    });
    expect(res.statusCode).toBe(202);
    expect(outbox).toHaveLength(0);
  });

  it('answers the same 202 for a real address, and sends the link', async () => {
    const employee = await createEmployee(db);
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'ninguem@wingscompany.com.br' },
    });
    const known = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: employee.email },
    });

    // Identical response: an anonymous caller cannot tell accounts apart.
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.json()).toEqual(unknown.json());
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.to).toBe(employee.email);
  });

  it('with the SMTP refusing, a real address still gets the same 202 and none of its words (audit A10)', async () => {
    const employee = await createEmployee(db);
    smtpRefuses = true;
    const ask = (email: string) =>
      app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const unknown = await ask('ninguem@wingscompany.com.br');
    const known = await ask(employee.email);
    expect(known.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    expect(known.body).not.toContain('550');
    const [audit] = await db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.targetEmployeeId, employee.id));
    expect(audit?.metadata).toEqual({ delivered: false, reason: 'smtp_failed', error: 'Error' });
    expect(JSON.stringify(audit)).not.toContain(employee.email);
  });

  it('sends nothing for a deactivated employee', async () => {
    const employee = await createEmployee(db, { status: 'inactive' });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: employee.email },
    });
    expect(res.statusCode).toBe(202);
    expect(outbox).toHaveLength(0);
  });
});

describe('POST /auth/set-password', () => {
  it('changes the password and lets the old one stop working', async () => {
    const employee = await createEmployee(db);
    await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: employee.email },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token: tokenFromLastMail(), password: 'senha-nova-muito-longa-9' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().purpose).toBe('reset');

    expect((await loginAs(employee.email, employee.password)).statusCode).toBe(401);
    expect((await loginAs(employee.email, 'senha-nova-muito-longa-9')).statusCode).toBe(200);
  });

  it('revokes existing sessions when the password changes', async () => {
    const employee = await createEmployee(db);
    const login = await loginAs(employee.email, employee.password);
    const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';
    expect(
      (await app.inject({ method: 'GET', url: '/auth/me', cookies: { [SESSION_COOKIE]: token } }))
        .statusCode,
    ).toBe(200);

    await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: employee.email },
    });
    await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token: tokenFromLastMail(), password: 'senha-nova-muito-longa-8' },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(after.statusCode).toBe(401);
  });

  it('is single-use', async () => {
    const employee = await createEmployee(db);
    await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: employee.email },
    });
    const token = tokenFromLastMail();

    const first = await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token, password: 'senha-nova-muito-longa-7' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token, password: 'senha-ainda-outra-longa-6' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(410);
  });

  it('rejects an expired link', async () => {
    const employee = await createEmployee(db);
    await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: employee.email },
    });
    const token = tokenFromLastMail();

    await db
      .update(credentialTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(credentialTokens.employeeId, employee.id));

    const res = await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token, password: 'senha-nova-muito-longa-5' },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('expired_token');
  });

  it('rejects an unknown token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token: randomBytes(32).toString('base64url'), password: 'senha-longa-valida-42' },
    });
    expect(res.statusCode).toBe(410);
  });

  it('rejects short and personal passwords', async () => {
    const employee = await createEmployee(db);
    await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: employee.email },
    });
    const token = tokenFromLastMail();

    const short = await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token, password: 'curta1' },
    });
    expect(short.statusCode).toBe(400);

    const personal = await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token, password: `${employee.email.split('@')[0]}-senha-longa` },
    });
    expect(personal.statusCode).toBe(400);
    expect(personal.json().error).toBe('weak_password');

    // A rejected attempt must not burn the token.
    const good = await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token, password: 'entao-uma-senha-boa-2026' },
    });
    expect(good.statusCode).toBe(200);
  });
});

describe('when SMTP is not configured', () => {
  it('answers 503 instead of silently dropping the e-mail', async () => {
    const offline = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: harness.url,
        SESSION_SECRET: randomBytes(48).toString('base64'),
        CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
        CPF_INDEX_KEY: TEST_INDEX_KEY,
        APP_BASE_URL: BASE_URL,
      }),
      db,
      mailer: {
        enabled: false,
        send: async () => {
          throw new Error('must not be called');
        },
      },
    });

    const employee = await createEmployee(db);
    const res = await offline.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: employee.email },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('email_not_configured');
    await offline.close();
  });
});

describe('tokens and audit trail', () => {
  it('stores only the hash of the token', async () => {
    const employee = await createEmployee(db);
    await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: employee.email },
    });
    const token = tokenFromLastMail();

    const stored = await db.query.credentialTokens.findFirst({
      where: eq(credentialTokens.employeeId, employee.id),
    });
    expect(stored).toBeDefined();
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('audits requests and password changes without personal data', async () => {
    const employee = await createEmployee(db);
    await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: employee.email },
    });
    await app.inject({
      method: 'POST',
      url: '/auth/set-password',
      payload: { token: tokenFromLastMail(), password: 'senha-nova-muito-longa-4' },
    });

    const entries = await db.query.auditLog.findMany({
      where: eq(auditLog.targetEmployeeId, employee.id),
    });
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('credentials.reset_requested');
    expect(actions).toContain('credentials.password_set');

    const serialized = JSON.stringify(entries, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialized).not.toContain(employee.email);
  });
});
