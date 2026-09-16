import { isValidCpf, normalizeCpf } from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import { createCpfCrypto } from '../lib/cpf-crypto.js';
import { hashPassword } from '../lib/password.js';
import { createDb } from './client.js';
import { loadDotEnv } from './load-env.js';
import { employeeCredentials, employees, roles, sectors } from './schema/index.js';

/**
 * Creates the first Admin Master, which has no invite flow to rely on.
 *
 *   pnpm --filter @wings/api exec tsx src/db/bootstrap-admin.ts \
 *     --email admin@wingscompany.com.br --name "Nome Completo" --cpf 000.000.000-00 \
 *     --password 'senha-forte'
 *
 * Intended for a fresh environment. It refuses to overwrite an existing
 * employee, so re-running it is safe.
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  loadDotEnv();
  const email = arg('email');
  const fullName = arg('name');
  const cpf = arg('cpf');
  const password = arg('password');

  if (!email || !fullName || !cpf || !password) {
    throw new Error('usage: --email <e> --name <n> --cpf <c> --password <p>');
  }
  if (!isValidCpf(cpf)) throw new Error('CPF inválido');
  if (password.length < 12) throw new Error('password must be at least 12 characters');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const encryptionKey = process.env.CPF_ENCRYPTION_KEY;
  const indexKey = process.env.CPF_INDEX_KEY;
  if (!encryptionKey || !indexKey) throw new Error('CPF_ENCRYPTION_KEY/CPF_INDEX_KEY are not set');

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
      birthDate: '1970-01-01',
      phone: normalizeCpf('00000000000').slice(0, 11),
      email: email.toLowerCase(),
      cargo: 'Administrador do Sistema',
      sectorId: sector.id,
      roleId: role.id,
      admissionDate: new Date().toISOString().slice(0, 10),
      status: 'active',
      isSectorManager: false,
    })
    .returning({ id: employees.id });

  if (!created) throw new Error('failed to create employee');

  await db.insert(employeeCredentials).values({
    employeeId: created.id,
    passwordHash: await hashPassword(password),
    passwordSetAt: new Date(),
  });

  await pool.end();
  console.warn(`admin master created: ${created.id}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
