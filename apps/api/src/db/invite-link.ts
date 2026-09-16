import { sql } from 'drizzle-orm';
import { createDb } from './client.js';
import { loadDotEnv } from './load-env.js';
import { createInviteLink } from '../modules/auth/credentials-service.js';

/**
 * Prints a one-time invite link for an existing employee, without sending
 * e-mail. For bootstrapping and for the window before SMTP is configured.
 *
 *   node dist/db/invite-link.js --email pessoa@wingscompany.com.br
 *
 * The link is a credential: it sets a password on first use. Treat the output
 * like a password — it expires and can only be used once.
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  loadDotEnv();
  const email = arg('email');
  if (!email) throw new Error('usage: --email <address>');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) throw new Error('APP_BASE_URL is not set');

  const { db, pool } = createDb(databaseUrl);
  const found = await db.execute<{ id: string }>(
    sql`select id from employees where lower(email) = ${email.toLowerCase()} limit 1`,
  );
  const employee = found.rows[0];
  if (!employee) {
    await pool.end();
    throw new Error(`no employee with e-mail ${email}`);
  }

  const invite = await createInviteLink(db, { employeeId: employee.id, baseUrl });
  await pool.end();
  if (!invite) throw new Error('employee is inactive');

  console.warn(
    `Link de definição de senha (uso único, expira em ${invite.expiresAt.toISOString()}):`,
  );
  console.warn(invite.link);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
