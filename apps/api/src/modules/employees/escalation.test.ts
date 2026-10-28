import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type RoleKey, type SectorSlug } from '@wings/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { loadEnv } from '../../env.js';
import type { Mail, Mailer } from '../../lib/mailer.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, makeCpf, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

/**
 * Security audit of 2026-10-27 (A2, A3), straight at the API: a manager never creates an account
 * holding powers they lack, and never switches off (or back on) someone above them. Made-up
 * people and addresses only.
 */

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

type Session = { id: string; cookies: Record<string, string> };

async function signIn(role: RoleKey, sector: SectorSlug, isSectorManager = false) {
  const employee = await createEmployee(db, { role, sector, isSectorManager });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`login failed for ${role}`);
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } } satisfies Session;
}

const alias = () => `teste-${randomBytes(4).toString('hex')}@exemplo.invalid`;

const statusOf = async (id: string) =>
  (await db.execute<{ status: string }>(sql`select status from employees where id = ${id}`)).rows[0]
    ?.status;

/** Whoever holds the link mailed to `address` sets a password and signs in. */
async function takeOver(address: string): Promise<Session | null> {
  const mail = [...outbox].reverse().find((m) => m.to === address);
  const link = mail?.text.match(/https?:\/\/\S+/)?.[0];
  const token = link ? new URL(link).searchParams.get('token') : null;
  if (!token) return null;
  const password = 'cavalo-azul-correndo-na-chuva-77';
  const set = await app.inject({
    method: 'POST',
    url: '/auth/set-password',
    payload: { token, password },
  });
  if (set.statusCode !== 200) return null;
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: address, password },
  });
  const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  return cookie ? { id: '', cookies: { [SESSION_COOKIE]: cookie } } : null;
}

async function permissionsOf(session: Session): Promise<Record<string, string>> {
  const me = await app.inject({ method: 'GET', url: '/auth/me', cookies: session.cookies });
  return me.json<{ user: { permissions: Record<string, string> } }>().user.permissions;
}

const newEmployee = (overrides: Record<string, unknown>) => ({
  fullName: 'Pessoa Inventada',
  cpf: makeCpf(),
  birthDate: '1990-01-01',
  phone: '11900000000',
  email: alias(),
  cargo: 'Analista',
  sector: 'comercial',
  role: 'vendedor_expansao',
  admissionDate: '2026-10-01',
  status: 'active',
  isSectorManager: false,
  ...overrides,
});

describe('a lower level that holds powers the manager lacks (A2)', () => {
  it.each([
    { role: 'gerente_comercial', sector: 'comercial', flag: false, grants: 'marketing' },
    { role: 'gerente_comercial', sector: 'comercial', flag: false, grants: 'formatacao_juridico' },
    { role: 'marketing', sector: 'marketing', flag: true, grants: 'formatacao_juridico' },
  ] as { role: RoleKey; sector: SectorSlug; flag: boolean; grants: RoleKey }[])(
    '$role (manager flag: $flag) cannot create a $grants account and gain its powers',
    async ({ role, sector, flag, grants }) => {
      const manager = await signIn(role, sector, flag);
      const address = alias();
      const created = await app.inject({
        method: 'POST',
        url: '/employees',
        cookies: manager.cookies,
        payload: newEmployee({ sector, role: grants, email: address }),
      });
      expect(created.statusCode).toBe(403);
      const stolen = await takeOver(address);
      const mine = await permissionsOf(manager);
      const theirs = stolen ? await permissionsOf(stolen) : {};
      expect(Object.keys(theirs).filter((permission) => !(permission in mine))).toEqual([]);
    },
  );

  it('the Gerente Comercial still creates a seller, whose powers it already holds', async () => {
    const manager = await signIn('gerente_comercial', 'comercial');
    const created = await app.inject({
      method: 'POST',
      url: '/employees',
      cookies: manager.cookies,
      payload: newEmployee({ role: 'vendedor_expansao' }),
    });
    expect(created.statusCode).toBe(201);
  });

  it('nor turns a subordinate into such a level', async () => {
    const manager = await signIn('gerente_comercial', 'comercial');
    const seller = await signIn('vendedor_expansao', 'comercial');
    const res = await app.inject({
      method: 'PATCH',
      url: `/employees/${seller.id}`,
      cookies: manager.cookies,
      payload: { role: 'formatacao_juridico' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('switching off or back on someone above (A3)', () => {
  it('a seller with the manager flag cannot switch off the Gerente Comercial', async () => {
    const manager = await signIn('vendedor_expansao', 'comercial', true);
    const gerente = await signIn('gerente_comercial', 'comercial');
    const res = await app.inject({
      method: 'PATCH',
      url: `/employees/${gerente.id}`,
      cookies: manager.cookies,
      payload: { status: 'inactive' },
    });
    const me = await app.inject({ method: 'GET', url: '/auth/me', cookies: gerente.cookies });
    expect({
      status: res.statusCode,
      gerente: await statusOf(gerente.id),
      me: me.statusCode,
    }).toEqual({ status: 403, gerente: 'active', me: 200 });
  });

  it('nor switch an inactive Gerente Comercial back on', async () => {
    const manager = await signIn('vendedor_expansao', 'comercial', true);
    const gerente = await createEmployee(db, {
      role: 'gerente_comercial',
      sector: 'comercial',
      status: 'inactive',
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/employees/${gerente.id}`,
      cookies: manager.cookies,
      payload: { status: 'active' },
    });
    expect({ status: res.statusCode, gerente: await statusOf(gerente.id) }).toEqual({
      status: 403,
      gerente: 'inactive',
    });
  });

  it('a colleague of the same level is still theirs to switch off', async () => {
    const manager = await signIn('vendedor_expansao', 'comercial', true);
    const colleague = await signIn('vendedor_expansao', 'comercial');
    const res = await app.inject({
      method: 'PATCH',
      url: `/employees/${colleague.id}`,
      cookies: manager.cookies,
      payload: { status: 'inactive' },
    });
    expect({ status: res.statusCode, colleague: await statusOf(colleague.id) }).toEqual({
      status: 200,
      colleague: 'inactive',
    });
  });
});
