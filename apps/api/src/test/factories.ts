import { randomBytes, randomInt } from 'node:crypto';
import type { RoleKey, SectorSlug } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { WINGS_TENANT_ID } from '../db/schema/ads.js';
import {
  employeeCredentials,
  employees,
  roles,
  sectors,
  whatsappSettings,
} from '../db/schema/index.js';
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

/**
 * The official WhatsApp number switch (Eric, 14/10) set straight in its row. While it is off a
 * seller cannot send or call (Eric, 19/10), so a test of sending as a seller turns it on first.
 */
export async function setOfficialLive(db: Database, live: boolean) {
  await db
    .insert(whatsappSettings)
    .values({ tenantId: WINGS_TENANT_ID, officialNumberLive: live })
    .onConflictDoUpdate({ target: whatsappSettings.tenantId, set: { officialNumberLive: live } });
}

/** A valid CNPJ, different each call (check digits computed). */
export function makeCnpj(): string {
  const base = Array.from({ length: 8 }, () => randomInt(0, 10)).concat([0, 0, 0, 1]);
  const digit = (numbers: number[]) => {
    const weights =
      numbers.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = numbers.reduce((total, n, i) => total + n * weights[i]!, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = digit(base);
  const second = digit([...base, first]);
  return [...base, first, second].join('');
}

/** The new register's body for POST /clients (Eric, 30/09), with a fresh CNPJ unless given. */
export function clientRegister(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    cnpj: makeCnpj(),
    company: {
      legalName: `${name} Ltda`,
      tradeName: name,
      cnaeMain: '5611-2/01',
      openedOn: '2020-01-10',
      city: 'São Paulo',
      state: 'SP',
    },
    contact: { name: 'Contato Teste', email: 'contato@example.com', whatsapp: '(11) 98888-0000' },
    relationship: 'formatacao',
    business: {
      segment: 'Alimentação',
      ownUnits: 2,
      revenueBand: null,
      franchisability: 'nao_avaliado',
      wingsFit: 'nao_avaliado',
      profileSource: 'Reunião com o sócio',
      profileDate: '2026-09-30',
    },
    ...overrides,
  };
}

/**
 * The first bytes of a PNG of this size (signature and IHDR), padded to
 * `byteSize`: enough for every check that reads the header, never decoded.
 */
export function fakePng(width: number, height: number, byteSize = 2048): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16); // bit depth
  ihdr.writeUInt8(6, 17); // RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const head = Buffer.concat([signature, ihdr]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, byteSize - head.length), 7)]);
}

/** The first bytes of a JPEG of this size (SOI, an APP0 and a baseline frame header), padded. */
export function fakeJpeg(width: number, height: number, byteSize = 2048): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9);
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, byteSize - head.length), 0)]);
}
