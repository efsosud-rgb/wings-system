import { isValidCpf } from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import { createInviteLink } from '../modules/auth/credentials-service.js';
import { createCpfCrypto } from '../lib/cpf-crypto.js';
import { hashPassword } from '../lib/password.js';
import { createDb } from './client.js';
import { loadDotEnv } from './load-env.js';
import { employeeCredentials, employees, roles, sectors } from './schema/index.js';

/**
 * Creates the first Admin Master, which has no invite flow to rely on.
 *
 * Preferred (the person sets their own password, nobody else ever knows it):
 *   node dist/db/bootstrap-admin.js --email a@b.com --name "Nome" \
 *     --cpf 000.000.000-00 --phone 11999999999 --birth-date 1980-05-20 --invite
 *
 * Or with a password chosen up front:
 *   ... --password 'senha-bem-longa'
 *
 * Refuses to touch an existing employee, so re-running is safe.
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  loadDotEnv();
  const email = arg('email');
  const fullName = arg('name');
  const cpf = arg('cpf');
  const password = arg('password');
  const useInvite = flag('invite');
  const phone = (arg('phone') ?? '').replace(/\D/g, '');
  const birthDate = arg('birth-date');
  const cargo = arg('cargo') ?? 'Administrador do Sistema';

  if (!email || !fullName || !cpf) {
    throw new Error(
      'usage: --email <e> --name <n> --cpf <c> [--phone <p>] [--birth-date YYYY-MM-DD] [--cargo <c>] (--invite | --password <p>)',
    );
  }
  if (!useInvite && !password) throw new Error('pass either --invite or --password');
  if (password && password.length < 12) throw new Error('password must be at least 12 characters');
  if (!isValidCpf(cpf)) throw new Error('CPF inválido');
  if (phone && phone.length !== 10 && phone.length !== 11) throw new Error('telefone inválido');
  if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    throw new Error('birth date must be YYYY-MM-DD');
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const encryptionKey = process.env.CPF_ENCRYPTION_KEY;
  const indexKey = process.env.CPF_INDEX_KEY;
  if (!encryptionKey || !indexKey) throw new Error('CPF_ENCRYPTION_KEY/CPF_INDEX_KEY are not set');
  const baseUrl = process.env.APP_BASE_URL;
  if (useInvite && !baseUrl) throw new Error('APP_BASE_URL is not set');

  const { db, pool } = createDb(databaseUrl);
  const cpfCrypto = createCpfCrypto(encryptionKey, indexKey);

  const existing = await db.execute<{ id: string }>(
    sql`select id from employees where lower(email) = ${email.toLowerCase()} limit 1`,
  );
  if (existing.rows[0]) {
    await pool.end();
    throw new Error(`employee already exists for ${email}`);
  }

  const role = await db.query.roles.findFirst({ where: eq(roles.key, 'admin_master') });
  const sector = await db.query.sectors.findFirst({ where: eq(sectors.slug, 'diretoria') });
  if (!role || !sector) {
    await pool.end();
    throw new Error('reference data missing — run db:seed first');
  }

  const [created] = await db
    .insert(employees)
    .values({
      fullName,
      cpfEncrypted: cpfCrypto.encrypt(cpf),
      cpfIndex: cpfCrypto.index(cpf),
      birthDate: birthDate ?? '1970-01-01',
      phone: phone || '00000000000',
      email: email.toLowerCase(),
      cargo,
      sectorId: sector.id,
      roleId: role.id,
      admissionDate: new Date().toISOString().slice(0, 10),
      status: 'active',
      isSectorManager: false,
    })
    .returning({ id: employees.id });

  if (!created) throw new Error('failed to create employee');

  if (password) {
    await db.insert(employeeCredentials).values({
      employeeId: created.id,
      passwordHash: await hashPassword(password),
      passwordSetAt: new Date(),
    });
    await pool.end();
    console.warn(`admin master created: ${created.id}`);
    return;
  }

  // Invite mode: no password is stored; the person sets their own.
  const invite = await createInviteLink(db, { employeeId: created.id, baseUrl: baseUrl as string });
  await pool.end();
  console.warn(`admin master created: ${created.id}`);
  console.warn('');
  console.warn(
    `Link de definição de senha (uso único, expira ${invite?.expiresAt.toISOString()}):`,
  );
  console.warn(invite?.link ?? '(falha ao gerar o link)');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
