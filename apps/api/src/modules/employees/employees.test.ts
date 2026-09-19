import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type EmployeeView } from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import type { Mail, Mailer } from '../../lib/mailer.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, makeCpf, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let outbox: Mail[] = [];

const mailer: Mailer = {
  enabled: true,
  send: async (mail) => {
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
      APP_BASE_URL: 'https://staging.wingssystem.online',
    }),
    db,
    mailer,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(() => {
  outbox = [];
});

type EmployeeOptions = NonNullable<Parameters<typeof createEmployee>[1]>;

async function sessionFor(options: EmployeeOptions) {
  const employee = await createEmployee(db, options);
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`login failed for ${String(options.role)}`);
  return { employee, cookies: { [SESSION_COOKIE]: token } };
}

function newEmployeePayload(overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Maria Souza',
    cpf: makeCpf(),
    birthDate: '1992-03-14',
    phone: '11988887777',
    email: `nova-${randomBytes(4).toString('hex')}@wingscompany.com.br`,
    cargo: 'Analista',
    sector: 'comercial',
    role: 'vendedor_expansao',
    admissionDate: '2026-02-01',
    status: 'active',
    isSectorManager: false,
    ...overrides,
  };
}

describe('GET /employees — scoping', () => {
  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/employees' })).statusCode).toBe(401);
  });

  it('shows every sector to Admin Master', async () => {
    await createEmployee(db, { role: 'formatacao_ti', sector: 'formatacao-ti' });
    await createEmployee(db, { role: 'marketing', sector: 'marketing' });
    const { cookies } = await sessionFor({ role: 'admin_master', sector: 'diretoria' });

    const res = await app.inject({ method: 'GET', url: '/employees?pageSize=100', cookies });
    const sectors = new Set(res.json().employees.map((e: EmployeeView) => e.sector));
    expect(res.statusCode).toBe(200);
    expect(sectors.has('formatacao-ti')).toBe(true);
    expect(sectors.has('marketing')).toBe(true);
  });

  it('never shows TI employees to Diretoria', async () => {
    const ti = await createEmployee(db, { role: 'formatacao_ti', sector: 'formatacao-ti' });
    const { cookies } = await sessionFor({ role: 'diretoria', sector: 'diretoria' });

    const res = await app.inject({ method: 'GET', url: '/employees?pageSize=100', cookies });
    const ids = res.json().employees.map((e: EmployeeView) => e.id);
    expect(ids).not.toContain(ti.id);
    expect(res.json().employees.some((e: EmployeeView) => e.sector === 'formatacao-ti')).toBe(
      false,
    );
  });

  it('reports a TI record as not found to Diretoria, not as forbidden', async () => {
    const ti = await createEmployee(db, { role: 'formatacao_ti', sector: 'formatacao-ti' });
    const { cookies } = await sessionFor({ role: 'diretoria', sector: 'diretoria' });

    const res = await app.inject({ method: 'GET', url: `/employees/${ti.id}`, cookies });
    // 404 rather than 403: existence itself must not leak.
    expect(res.statusCode).toBe(404);
  });

  it('limits a sector manager to their own sector', async () => {
    const outsider = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const insider = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
    const { cookies } = await sessionFor({
      role: 'marketing',
      sector: 'marketing',
      isSectorManager: true,
    });

    const res = await app.inject({ method: 'GET', url: '/employees?pageSize=100', cookies });
    const ids = res.json().employees.map((e: EmployeeView) => e.id);
    expect(ids).toContain(insider.id);
    expect(ids).not.toContain(outsider.id);
  });

  it('covers sub-sectors for a manager of Formatação', async () => {
    const sub = await createEmployee(db, {
      role: 'formatacao_logistica',
      sector: 'formatacao-logistica',
    });
    const { cookies } = await sessionFor({
      role: 'formatacao_financeiro',
      sector: 'formatacao',
      isSectorManager: true,
    });

    const res = await app.inject({ method: 'GET', url: '/employees?pageSize=100', cookies });
    expect(res.json().employees.map((e: EmployeeView) => e.id)).toContain(sub.id);
  });

  it('always masks the CPF in listings', async () => {
    const { cookies } = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const res = await app.inject({ method: 'GET', url: '/employees?pageSize=100', cookies });
    const body = res.json();
    expect(body.employees.length).toBeGreaterThan(0);
    for (const employee of body.employees as EmployeeView[]) {
      expect(employee.cpfMasked).toMatch(/^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
      expect(employee).not.toHaveProperty('cpf');
      expect(JSON.stringify(employee)).not.toContain('cpfEncrypted');
    }
  });

  it('filters and paginates', async () => {
    const { cookies } = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const page = await app.inject({ method: 'GET', url: '/employees?page=1&pageSize=2', cookies });
    expect(page.json().employees.length).toBeLessThanOrEqual(2);
    expect(page.json().total).toBeGreaterThan(0);

    const filtered = await app.inject({
      method: 'GET',
      url: '/employees?sector=marketing&pageSize=100',
      cookies,
    });
    expect(
      (filtered.json().employees as EmployeeView[]).every((e) => e.sector === 'marketing'),
    ).toBe(true);
  });
});

describe('POST /employees', () => {
  it('creates an employee and sends the invite automatically', async () => {
    const { cookies } = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const payload = newEmployeePayload();

    const res = await app.inject({ method: 'POST', url: '/employees', cookies, payload });
    expect(res.statusCode).toBe(201);
    expect(res.json().inviteSent).toBe(true);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.to).toBe(payload.email);
    expect(res.json().employee.cpfMasked).toMatch(/^\*\*\*\./);
    expect(res.json().employee.createdByName).toBeTruthy();
  });

  it('says clearly when SMTP is not configured, instead of implying success', async () => {
    const offline = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: harness.url,
        SESSION_SECRET: randomBytes(48).toString('base64'),
        CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
        CPF_INDEX_KEY: TEST_INDEX_KEY,
        APP_BASE_URL: 'https://staging.wingssystem.online',
      }),
      db,
      mailer: {
        enabled: false,
        send: async () => {
          throw new Error('must not be called');
        },
      },
    });

    const actor = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const login = await offline.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: actor.email, password: actor.password },
    });
    const cookies = {
      [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '',
    };

    const res = await offline.inject({
      method: 'POST',
      url: '/employees',
      cookies,
      payload: newEmployeePayload(),
    });

    // The employee is still created — but the operator is told the truth.
    expect(res.statusCode).toBe(201);
    expect(res.json().invite).toMatchObject({
      sent: false,
      error: { code: 'email_not_configured' },
    });
    expect(res.json().invite.error.message).toContain('NÃO foi enviado');
    expect(res.json().employee.id).toBeTruthy();
    await offline.close();
  });

  it('reports a mail server failure without losing the registration', async () => {
    const flaky = await buildApp({
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: harness.url,
        SESSION_SECRET: randomBytes(48).toString('base64'),
        CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
        CPF_INDEX_KEY: TEST_INDEX_KEY,
        APP_BASE_URL: 'https://staging.wingssystem.online',
      }),
      db,
      mailer: {
        enabled: true,
        send: async () => {
          throw new Error('smtp connection refused');
        },
      },
    });

    const actor = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const login = await flaky.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: actor.email, password: actor.password },
    });
    const cookies = {
      [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '',
    };

    const payload = newEmployeePayload();
    const res = await flaky.inject({ method: 'POST', url: '/employees', cookies, payload });

    expect(res.statusCode).toBe(201);
    expect(res.json().invite.error.code).toBe('send_failed');

    // The employee really exists and can be invited again later.
    const found = await app.inject({
      method: 'GET',
      url: `/employees?search=${encodeURIComponent(payload.email)}`,
      cookies: (await sessionFor({ role: 'admin_master', sector: 'diretoria' })).cookies,
    });
    expect(found.json().total).toBe(1);
    await flaky.close();
  });

  it('does not invite an employee created as inactive, and says so', async () => {
    const { cookies } = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const res = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies,
      payload: newEmployeePayload({ status: 'inactive' }),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().invite).toMatchObject({ sent: false, error: { code: 'employee_inactive' } });
    expect(outbox).toHaveLength(0);
  });

  it('rejects an invalid CPF before touching the database', async () => {
    const { cookies } = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const res = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies,
      payload: newEmployeePayload({ cpf: '111.111.111-11' }),
    });
    expect(res.statusCode).toBe(400);
    expect(outbox).toHaveLength(0);
  });

  it('refuses a duplicate CPF and a duplicate e-mail', async () => {
    const { cookies } = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const first = newEmployeePayload();
    await app.inject({ method: 'POST', url: '/employees', cookies, payload: first });

    const sameCpf = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies,
      payload: newEmployeePayload({ cpf: first.cpf }),
    });
    expect(sameCpf.statusCode).toBe(409);
    expect(sameCpf.json().error).toBe('cpf_taken');

    const sameEmail = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies,
      payload: newEmployeePayload({ email: first.email.toUpperCase() }),
    });
    expect(sameEmail.statusCode).toBe(409);
    expect(sameEmail.json().error).toBe('email_taken');
  });

  it('stops a sector manager from creating outside their sector', async () => {
    const { cookies } = await sessionFor({
      role: 'marketing',
      sector: 'marketing',
      isSectorManager: true,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies,
      payload: newEmployeePayload({ sector: 'comercial' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('stops a manager from granting a role at or above their own rank', async () => {
    const { cookies } = await sessionFor({
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
    });

    const higher = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies,
      payload: newEmployeePayload({ role: 'admin_master', sector: 'comercial' }),
    });
    expect(higher.statusCode).toBe(403);
    expect(higher.json().error).toBe('role_not_allowed');

    const equal = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies,
      payload: newEmployeePayload({ role: 'gerente_comercial', sector: 'comercial' }),
    });
    expect(equal.statusCode).toBe(403);
  });

  it('lets only Admin Master set the sector-manager flag', async () => {
    const manager = await sessionFor({
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
    });
    const denied = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies: manager.cookies,
      payload: newEmployeePayload({ isSectorManager: true }),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('manager_flag_forbidden');

    const admin = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const allowed = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies: admin.cookies,
      payload: newEmployeePayload({ isSectorManager: true }),
    });
    expect(allowed.statusCode).toBe(201);
    expect(allowed.json().employee.isSectorManager).toBe(true);
  });

  it('refuses creation for a plain employee', async () => {
    const { cookies } = await sessionFor({ role: 'vendedor_expansao', sector: 'comercial' });
    const res = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies,
      payload: newEmployeePayload(),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /employees/:id', () => {
  it('updates fields and records only the field names in the audit log', async () => {
    const { cookies } = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const target = await createEmployee(db, { role: 'marketing', sector: 'marketing' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/employees/${target.id}`,
      cookies,
      payload: { cargo: 'Coordenadora de Marketing', phone: '11977776666' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().employee.cargo).toBe('Coordenadora de Marketing');

    const entries = await db.query.auditLog.findMany({
      where: eq(auditLog.targetEmployeeId, target.id),
    });
    const update = entries.find((e) => e.action === 'employee.updated');
    const changed = (update?.metadata as { changed: string[] }).changed;
    // Exactly the two fields sent — a PATCH must not touch anything else.
    expect(changed.toSorted()).toEqual(['cargo', 'phone']);
    expect(JSON.stringify(update?.metadata)).not.toContain('11977776666');
  });

  it('does not silently reactivate a deactivated employee on an unrelated edit', async () => {
    const { cookies } = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const target = await createEmployee(db, { role: 'marketing', sector: 'marketing' });

    await app.inject({
      method: 'PATCH',
      url: `/employees/${target.id}`,
      cookies,
      payload: { status: 'inactive' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/employees/${target.id}`,
      cookies,
      payload: { cargo: 'Outro cargo' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().employee.status).toBe('inactive');
  });

  it('ends sessions when an employee is deactivated', async () => {
    const admin = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const victim = await sessionFor({ role: 'marketing', sector: 'marketing' });

    await app.inject({
      method: 'PATCH',
      url: `/employees/${victim.employee.id}`,
      cookies: admin.cookies,
      payload: { status: 'inactive' },
    });

    const after = await app.inject({ method: 'GET', url: '/auth/me', cookies: victim.cookies });
    expect(after.statusCode).toBe(401);
  });

  it('ends sessions when a role changes', async () => {
    const admin = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const target = await sessionFor({ role: 'vendedor_expansao', sector: 'comercial' });

    await app.inject({
      method: 'PATCH',
      url: `/employees/${target.employee.id}`,
      cookies: admin.cookies,
      payload: { role: 'vendedor_formatacao' },
    });

    expect(
      (await app.inject({ method: 'GET', url: '/auth/me', cookies: target.cookies })).statusCode,
    ).toBe(401);
  });

  it('blocks a sector manager changing their own role', async () => {
    const manager = await sessionFor({ role: 'gerente_comercial', sector: 'comercial' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/employees/${manager.employee.id}`,
      cookies: manager.cookies,
      payload: { role: 'vendedor_expansao' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('stops a manager moving an employee out of their sector', async () => {
    const manager = await sessionFor({
      role: 'marketing',
      sector: 'marketing',
      isSectorManager: true,
    });
    const target = await createEmployee(db, { role: 'marketing', sector: 'marketing' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/employees/${target.id}`,
      cookies: manager.cookies,
      payload: { sector: 'comercial' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('hides a TI employee from Diretoria on update too', async () => {
    const ti = await createEmployee(db, { role: 'formatacao_ti', sector: 'formatacao-ti' });
    const { cookies } = await sessionFor({ role: 'diretoria', sector: 'diretoria' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/employees/${ti.id}`,
      cookies,
      payload: { cargo: 'Qualquer' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /employees/:id — access levels', () => {
  const patch = (id: string, cookies: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/employees/${id}`, cookies, payload });

  const roleOf = async (id: string, cookies: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: `/employees/${id}`, cookies })).json().employee.role;

  /** Leaves `keepId` as the only Admin Master who can log in. */
  async function makeLastAdminMaster(keepId: string) {
    await db.execute(sql`
      update employees set status = 'inactive', deactivated_at = now()
       where id <> ${keepId}
         and role_id = (select id from roles where key = 'admin_master')
    `);
  }

  it('lets RH/DP change a seller and audits who, whom, from what and to what', async () => {
    const rh = await sessionFor({ role: 'rh_dp', sector: 'diretoria' });
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });

    const res = await patch(seller.id, rh.cookies, { role: 'gerente_comercial' });
    expect(res.statusCode).toBe(200);
    expect(res.json().employee.role).toBe('gerente_comercial');

    const entries = await db.select().from(auditLog).where(eq(auditLog.entityId, seller.id));
    const change = entries.find((entry) => entry.action === 'employee.role_changed');
    expect(change?.actorEmployeeId).toBe(rh.employee.id);
    expect(change?.targetEmployeeId).toBe(seller.id);
    expect(change?.metadata).toEqual({
      previousRole: 'vendedor_expansao',
      newRole: 'gerente_comercial',
    });
  });

  it('stops RH/DP granting or removing Diretoria, which Diretoria itself may do', async () => {
    const rh = await sessionFor({ role: 'rh_dp', sector: 'diretoria' });
    const diretor = await sessionFor({ role: 'diretoria', sector: 'diretoria' });
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const director = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });

    const grant = await patch(seller.id, rh.cookies, { role: 'diretoria' });
    expect(grant.statusCode).toBe(403);
    expect(grant.json().error).toBe('role_not_allowed');
    expect((await patch(director.id, rh.cookies, { role: 'marketing' })).statusCode).toBe(403);
    expect(await roleOf(director.id, rh.cookies)).toBe('diretoria');
    // Creating someone straight into Diretoria is the same grant.
    const created = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies: rh.cookies,
      payload: newEmployeePayload({ role: 'diretoria', sector: 'diretoria' }),
    });
    expect(created.statusCode).toBe(403);
    // RH/DP still edits the rest of a director's record.
    expect((await patch(director.id, rh.cookies, { cargo: 'Diretora' })).statusCode).toBe(200);

    expect((await patch(seller.id, diretor.cookies, { role: 'diretoria' })).statusCode).toBe(200);
    expect((await patch(director.id, diretor.cookies, { role: 'marketing' })).statusCode).toBe(200);
  });

  it('stops Diretoria granting Admin Master', async () => {
    const diretor = await sessionFor({ role: 'diretoria', sector: 'diretoria' });
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });

    const res = await patch(seller.id, diretor.cookies, { role: 'admin_master' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('role_not_allowed');
    expect(await roleOf(seller.id, diretor.cookies)).toBe('vendedor_expansao');
  });

  it('stops Diretoria changing their own level', async () => {
    const diretor = await sessionFor({ role: 'diretoria', sector: 'diretoria' });
    const res = await patch(diretor.employee.id, diretor.cookies, { role: 'rh_dp' });
    expect(res.statusCode).toBe(403);
  });

  it('lets Diretoria change a level but nothing else on the record', async () => {
    const diretor = await sessionFor({ role: 'diretoria', sector: 'diretoria' });
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });

    expect((await patch(seller.id, diretor.cookies, { role: 'marketing' })).statusCode).toBe(200);
    expect(
      (await patch(seller.id, diretor.cookies, { role: 'rh_dp', cargo: 'Outro' })).statusCode,
    ).toBe(403);
    expect((await patch(seller.id, diretor.cookies, { cargo: 'Outro' })).statusCode).toBe(403);
  });

  it('stops anyone but an Admin Master touching an Admin Master record', async () => {
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const rh = await sessionFor({ role: 'rh_dp', sector: 'diretoria' });
    const diretor = await sessionFor({ role: 'diretoria', sector: 'diretoria' });

    for (const payload of [{ role: 'diretoria' }, { email: 'tomada@wingscompany.com.br' }]) {
      const res = await patch(admin.id, rh.cookies, payload);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('admin_master_record');
    }
    expect((await patch(admin.id, diretor.cookies, { role: 'diretoria' })).statusCode).toBe(403);
  });

  it('saves without changing the level, whoever is saving', async () => {
    const diretor = await sessionFor({ role: 'diretoria', sector: 'diretoria' });
    const manager = await sessionFor({ role: 'gerente_comercial', sector: 'comercial' });

    // The form sends the current level back; that is not a change.
    expect(
      (
        await patch(manager.employee.id, manager.cookies, {
          role: 'gerente_comercial',
          cargo: 'Gerente',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await patch(diretor.employee.id, diretor.cookies, { role: 'diretoria' })).statusCode,
    ).toBe(200);
    // Nothing changed, so nobody was logged out and nothing was audited as a change.
    expect(
      (await app.inject({ method: 'GET', url: '/auth/me', cookies: manager.cookies })).statusCode,
    ).toBe(200);
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, manager.employee.id));
    expect(entries.some((entry) => entry.action === 'employee.role_changed')).toBe(false);
  });

  it('lets an Admin Master change their own level while another one remains', async () => {
    await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const admin = await sessionFor({ role: 'admin_master', sector: 'diretoria' });

    const res = await patch(admin.employee.id, admin.cookies, { role: 'diretoria' });
    expect(res.statusCode).toBe(200);
  });

  it('never demotes or deactivates the last Admin Master', async () => {
    const admin = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    await makeLastAdminMaster(admin.employee.id);

    const view = await app.inject({
      method: 'GET',
      url: `/employees/${admin.employee.id}`,
      cookies: admin.cookies,
    });
    expect(view.json().employee.isLastActiveAdminMaster).toBe(true);

    const demote = await patch(admin.employee.id, admin.cookies, { role: 'diretoria' });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error).toBe('last_admin_master');

    const deactivate = await patch(admin.employee.id, admin.cookies, { status: 'inactive' });
    expect(deactivate.statusCode).toBe(409);

    // Still an Admin Master, still logged in, and an unrelated edit still works.
    expect((await patch(admin.employee.id, admin.cookies, { cargo: 'Diretor' })).statusCode).toBe(
      200,
    );
    expect(await roleOf(admin.employee.id, admin.cookies)).toBe('admin_master');

    // With a second one in place the lock lifts.
    const second = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    expect((await patch(second.id, admin.cookies, { role: 'admin_master' })).statusCode).toBe(200);
    expect((await patch(admin.employee.id, admin.cookies, { role: 'diretoria' })).statusCode).toBe(
      200,
    );
  });
});

describe('POST /employees/:id/reveal-cpf', () => {
  it('returns the full CPF for a permitted viewer and audits it', async () => {
    const { cookies } = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const payload = newEmployeePayload();
    const created = await app.inject({ method: 'POST', url: '/employees', cookies, payload });
    const id = created.json().employee.id;

    const res = await app.inject({ method: 'POST', url: `/employees/${id}/reveal-cpf`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().cpf).toBe(payload.cpf);

    const entries = await db.query.auditLog.findMany({ where: eq(auditLog.targetEmployeeId, id) });
    const reveal = entries.find((e) => e.action === 'employee.cpf_revealed');
    expect(reveal).toBeDefined();
    // The audit row records the act, never the number.
    expect(JSON.stringify(reveal?.metadata)).not.toContain(payload.cpf);
  });

  it('refuses a viewer without the pii.view permission', async () => {
    const admin = await sessionFor({ role: 'admin_master', sector: 'diretoria' });
    const created = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies: admin.cookies,
      payload: newEmployeePayload({ sector: 'marketing', role: 'marketing' }),
    });
    const id = created.json().employee.id;

    const manager = await sessionFor({
      role: 'marketing',
      sector: 'marketing',
      isSectorManager: true,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/employees/${id}/reveal-cpf`,
      cookies: manager.cookies,
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses Diretoria on a TI record', async () => {
    const ti = await createEmployee(db, { role: 'formatacao_ti', sector: 'formatacao-ti' });
    const { cookies } = await sessionFor({ role: 'diretoria', sector: 'diretoria' });
    const res = await app.inject({
      method: 'POST',
      url: `/employees/${ti.id}/reveal-cpf`,
      cookies,
    });
    expect(res.statusCode).toBe(404);
  });
});
