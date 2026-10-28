// Synthetic employees for the E2E run, written to the accounts file given as argument (mode 600).
// Passwords are set through the invite link itself, as scripts/test-accounts.ts does.
// Uses the built API (dist/), so `pnpm build` comes first. run.mjs is the only caller.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createDb } from '../dist/db/client.js';
import { employees, roles, sectors } from '../dist/db/schema/index.js';
import { loadEnv } from '../dist/env.js';
import { createCpfCrypto } from '../dist/lib/cpf-crypto.js';
import {
  createInviteLink,
  setPasswordWithToken,
} from '../dist/modules/auth/credentials-service.js';
import { makeCpf } from '../dist/test/factories.js';

const PEOPLE = [
  { key: 'admin', role: 'admin_master', sector: 'diretoria', login: true },
  { key: 'diretor', role: 'diretoria', sector: 'diretoria', login: true },
  { key: 'rh', role: 'rh_dp', sector: 'diretoria', login: true },
  { key: 'gerente', role: 'gerente_comercial', sector: 'comercial', login: true },
  { key: 'mktGestor', role: 'marketing', sector: 'marketing', manager: true, login: true },
  { key: 'mkt', role: 'marketing', sector: 'marketing', login: true },
  { key: 'vendA', role: 'vendedor_expansao', sector: 'comercial', login: true },
  { key: 'vendB', role: 'vendedor_expansao', sector: 'comercial', login: true },
  { key: 'vendGestor', role: 'vendedor_expansao', sector: 'comercial', manager: true, login: true },
  { key: 'vendF', role: 'vendedor_formatacao', sector: 'comercial', login: true },
  { key: 'alvoTI', role: 'formatacao_ti', sector: 'formatacao-ti', login: false },
  { key: 'alvoMkt', role: 'marketing', sector: 'marketing', login: false },
  { key: 'alvoCom', role: 'vendedor_expansao', sector: 'comercial', login: false },
];

const env = loadEnv();
// Writes accounts with known passwords: never against anything but the throwaway E2E database.
if (!new URL(env.DATABASE_URL).pathname.endsWith('_e2e')) {
  throw new Error('e2e seed runs only against a database whose name ends in _e2e');
}
const { db, pool } = createDb(env.DATABASE_URL);
const crypto = createCpfCrypto(env.CPF_ENCRYPTION_KEY, env.CPF_INDEX_KEY);
const out = {};
try {
  for (const person of PEOPLE) {
    const role = await db.query.roles.findFirst({ where: eq(roles.key, person.role) });
    const sector = await db.query.sectors.findFirst({ where: eq(sectors.slug, person.sector) });
    if (!role || !sector) throw new Error(`missing reference data ${person.role}/${person.sector}`);
    const cpf = makeCpf();
    const email = `e2e-${person.key.toLowerCase()}@e2e.invalid`;
    const [row] = await db
      .insert(employees)
      .values({
        fullName: `Pessoa Sintética ${person.key}`,
        cpfEncrypted: crypto.encrypt(cpf),
        cpfIndex: crypto.index(cpf),
        birthDate: '1990-01-01',
        phone: '11900000000',
        email,
        cargo: 'Cargo Sintético',
        sectorId: sector.id,
        roleId: role.id,
        admissionDate: '2026-01-01',
        status: 'active',
        isSectorManager: person.manager ?? false,
      })
      .returning({ id: employees.id });
    if (!row) throw new Error('insert failed');
    let password = null;
    if (person.login) {
      const invite = await createInviteLink(db, { employeeId: row.id, baseUrl: env.APP_BASE_URL });
      const token = invite ? new URL(invite.link).searchParams.get('token') : null;
      if (!token) throw new Error(`no invite for ${person.key}`);
      password = randomBytes(18).toString('base64url');
      const result = await setPasswordWithToken(db, { token, password });
      if (!result.ok) throw new Error(`password not set for ${person.key}`);
    }
    out[person.key] = { id: row.id, email, password };
  }
  writeFileSync(process.argv[2], JSON.stringify(out, null, 2), { mode: 0o600 });
  console.warn(`seeded ${Object.keys(out).length} synthetic employees`);
} finally {
  await pool.end();
}
