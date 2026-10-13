import { randomBytes, randomInt } from 'node:crypto';
import { ROLES, ROLE_KEYS, type RoleKey, type SectorSlug } from '@wings/shared';
import { and, eq, like } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { employeeCredentials, employees, roles, sectors } from '../db/schema/index.js';
import { loadEnv } from '../env.js';
import { writeAudit } from '../lib/audit.js';
import { createCpfCrypto } from '../lib/cpf-crypto.js';
import { createInviteLink, setPasswordWithToken } from '../modules/auth/credentials-service.js';
import { revokeAllSessions } from '../modules/auth/service.js';

/**
 * Test accounts for checking access levels on STAGING (docs/niveis-de-acesso.md),
 * one per level except Admin Master (that test is Eric's own login).
 *
 *   node dist/scripts/test-accounts.js estado      what exists, by level (no e-mail, no password)
 *   node dist/scripts/test-accounts.js criar       creates what is missing; stdout gets
 *                                                  "nível<TAB>e-mail<TAB>senha" for the new ones
 *   node dist/scripts/test-accounts.js desativar   inactivates every test account and ends its sessions
 *
 * No invite and no e-mail is ever sent: the addresses end in `.invalid`, and the
 * password is chosen by the script through the invite link itself (issued and
 * used here, never mailed), so the usual audit entries are written. `criar`'s
 * stdout carries passwords: redirect it to a mode-600 file outside the
 * repository, never to a terminal or a log. Refuses to run outside staging.
 */

const DOMAIN = 'contas-teste.invalid';

const SECTOR_OF: Record<RoleKey, SectorSlug> = {
  admin_master: 'diretoria',
  diretoria: 'diretoria',
  rh_dp: 'diretoria',
  gerente_comercial: 'comercial',
  marketing: 'marketing',
  formatacao_juridico: 'formatacao-juridico',
  formatacao_financeiro: 'formatacao-financeiro',
  formatacao_processos_projetos: 'formatacao-processos-projetos',
  formatacao_contabil_tributario: 'formatacao-contabil-tributario',
  formatacao_logistica: 'formatacao-logistica',
  formatacao_ti: 'formatacao-ti',
  vendedor_expansao: 'comercial',
  vendedor_formatacao: 'comercial',
};

const LEVELS = ROLE_KEYS.filter((role) => role !== 'admin_master');

const emailOf = (role: RoleKey) => `teste.${role.replaceAll('_', '-')}@${DOMAIN}`;

/** A made-up CPF with valid check digits (never a real person's). */
function makeCpf(): string {
  const digits = Array.from({ length: 9 }, () => randomInt(0, 10));
  for (const position of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < position; i++) sum += (digits[i] as number) * (position + 1 - i);
    const remainder = (sum * 10) % 11;
    digits.push(remainder === 10 ? 0 : remainder);
  }
  return digits.join('');
}

async function main() {
  loadDotEnv();
  const env = loadEnv(process.env);
  const mode = process.argv[2];
  if (mode !== 'estado' && mode !== 'criar' && mode !== 'desativar') {
    console.error('uso: test-accounts estado|criar|desativar');
    process.exit(2);
  }
  if (!env.APP_BASE_URL.includes('staging') && env.NODE_ENV !== 'development') {
    console.error('recusado: contas de teste só no staging');
    process.exit(2);
  }

  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const existing = await db
      .select({
        id: employees.id,
        email: employees.email,
        status: employees.status,
        role: roles.key,
      })
      .from(employees)
      .innerJoin(roles, eq(roles.id, employees.roleId))
      .where(like(employees.email, `%@${DOMAIN}`));

    if (mode === 'estado') {
      for (const role of LEVELS) {
        const row = existing.find((account) => account.email === emailOf(role));
        console.error(`${ROLES[role].name}: ${row ? row.status : 'não existe'}`);
      }
      return;
    }

    if (mode === 'desativar') {
      for (const account of existing.filter((row) => row.status === 'active')) {
        await db
          .update(employees)
          .set({ status: 'inactive', deactivatedAt: new Date() })
          .where(and(eq(employees.id, account.id), eq(employees.status, 'active')));
        await revokeAllSessions(db, account.id, 'deactivated');
        await writeAudit(db, {
          action: 'employee.test_account_deactivated',
          entity: 'employee',
          entityId: account.id,
          targetEmployeeId: account.id,
        });
      }
      console.error(`desativadas: ${existing.filter((row) => row.status === 'active').length}`);
      return;
    }

    const cpfCrypto = createCpfCrypto(env.CPF_ENCRYPTION_KEY, env.CPF_INDEX_KEY);
    let created = 0;
    for (const role of LEVELS) {
      const found = existing.find((account) => account.email === emailOf(role));
      if (found) {
        // A run that stopped between the record and the password finishes here.
        const [credential] = await db
          .select({ id: employeeCredentials.employeeId })
          .from(employeeCredentials)
          .where(eq(employeeCredentials.employeeId, found.id));
        if (credential || found.status !== 'active') continue;
        await givePassword(found.id, role);
        continue;
      }
      const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, role));
      const [sectorRow] = await db
        .select({ id: sectors.id })
        .from(sectors)
        .where(eq(sectors.slug, SECTOR_OF[role]));
      if (!roleRow || !sectorRow) throw new Error(`nível ou setor ausente: ${role}`);

      const cpf = makeCpf();
      const today = new Date().toISOString().slice(0, 10);
      const [employee] = await db
        .insert(employees)
        .values({
          fullName: `Teste ${ROLES[role].name}`,
          cpfEncrypted: cpfCrypto.encrypt(cpf),
          cpfIndex: cpfCrypto.index(cpf),
          birthDate: '1990-01-01',
          phone: '00000000000',
          email: emailOf(role),
          cargo: 'Conta de teste de nível de acesso',
          sectorId: sectorRow.id,
          roleId: roleRow.id,
          admissionDate: today,
        })
        .returning({ id: employees.id });
      if (!employee) throw new Error(`não criou: ${role}`);
      await writeAudit(db, {
        action: 'employee.test_account_created',
        entity: 'employee',
        entityId: employee.id,
        targetEmployeeId: employee.id,
        metadata: { role },
      });

      await givePassword(employee.id, role);
    }
    console.error(`criadas: ${created}; já existiam: ${existing.length}`);

    async function givePassword(employeeId: string, role: RoleKey) {
      // The invite link is issued and used right here: nothing is mailed.
      const invite = await createInviteLink(db, { employeeId, baseUrl: env.APP_BASE_URL });
      const token = invite ? new URL(invite.link).searchParams.get('token') : null;
      if (!token) throw new Error(`convite não saiu: ${role}`);
      const password = randomBytes(18).toString('base64url');
      const result = await setPasswordWithToken(db, { token, password });
      if (!result.ok) throw new Error(`senha não gravada: ${role}`);

      process.stdout.write(`${ROLES[role].name}\t${emailOf(role)}\t${password}\n`);
      created += 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'falhou');
  process.exit(1);
});
