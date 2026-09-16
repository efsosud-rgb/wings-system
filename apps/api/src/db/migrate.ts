import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';
import { loadDotEnv } from './load-env.js';

/** Runs pending migrations. Executed on container start before the API serves traffic. */
async function main() {
  loadDotEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  const { db, pool } = createDb(databaseUrl);
  const migrationsFolder = resolve(import.meta.dirname, '../../migrations');
  await migrate(db, { migrationsFolder });
  await pool.end();
  console.warn('migrations applied');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
