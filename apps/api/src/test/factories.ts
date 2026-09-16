import { randomBytes, randomInt } from 'node:crypto';
import type { RoleKey, SectorSlug } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { employeeCredentials, employees, roles, sectors } from '../db/schema/index.js';
import { createCpfCrypto } from '../lib/cpf-crypto.js';
import { hashPassword } from '../lib/password.js';

export const TEST_CPF_KEY = randomBytes(32).toString('base64');
export const TEST_INDEX_KEY = randomBytes(32).toString('base64');
const cpfCrypto = createCpfCrypto(TEST_CPF_KEY, TEST_INDEX_KEY);

/** Generates a syntactically valid CPF (correct check digits), for test data only. */
export function makeCpf(): string {
  const digits = Array.from({ length: 9 }, () => randomInt(0, 10));
  for (const position of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < position; i++) sum += (digits[i] as number) * (position + 1 - i);
    const remainder = (sum * 10) % 11;
    digits.push(remainder === 10 ? 0 : remainder);
  }
  return digits.join('');
}

export interface CreatedEmployee {
  id: string;
  email: string;
  password: string;
}

export async function createEmployee(
  db: Database,
  options: {
    role?: RoleKey;
    sector?: SectorSlug;
    status?: 'active' | 'inactive' | 'on_leave';
    isSectorManager?: boolean;
    password?: string | null;
  } = {},
): Promise<CreatedEmployee> {
  const roleKey = options.role ?? 'vendedor_expansao';
  const sectorSlug = options.sector ?? 'comercial';
  const password = options.password === undefined ? 'senha-de-teste-123' : options.password;

  const role = await db.query.roles.findFirst({ where: eq(roles.key, roleKey) });
  const sector = await db.query.sectors.findFirst({ where: eq(sectors.slug, sectorSlug) });
  if (!role || !sector) throw new Error(`missing reference data for ${roleKey}/${sectorSlug}`);

  const email = `teste-${randomBytes(5).toString('hex')}@wingscompany.com.br`;
  const cpf = makeCpf();
  const status = options.status ?? 'active';

  const [created] = await db
    .insert(employees)
    .values({
      fullName: 'Funcionário de Teste',
      cpfEncrypted: cpfCrypto.encrypt(cpf),
      cpfIndex: cpfCrypto.index(cpf),
      birthDate: '1990-05-10',
      phone: '11999998888',
      email,
      cargo: 'Cargo de Teste',
      sectorId: sector.id,
      roleId: role.id,
      admissionDate: '2026-01-15',
      status,
      deactivatedAt: status === 'inactive' ? new Date() : null,
      isSectorManager: options.isSectorManager ?? false,
    })
    .returning({ id: employees.id });

  if (!created) throw new Error('failed to create test employee');

  if (password !== null) {
    await db.insert(employeeCredentials).values({
      employeeId: created.id,
      passwordHash: await hashPassword(password),
      passwordSetAt: new Date(),
    });
  }

  return { id: created.id, email, password: password ?? '' };
}
