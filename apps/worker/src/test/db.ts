import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Loads the repo-root .env for local test runs, same as
 * `apps/api/src/db/load-env.ts`. In CI the variable is set directly. */
function loadDotEnv(): void {
  const envPath = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

/**
 * A throwaway database per test run, migrated with `apps/api`'s own
 * migrations — read by relative path, not imported, so this package never
 * depends on `@wings/api`. `apps/api` owns the `jobs` table's schema; this
 * only needs it to exist to test the queue's SQL against it. No seed: the
 * queue does not touch reference data.
 */
export interface TestDatabase {
  pool: pg.Pool;
  drop: () => Promise<void>;
}

function adminUrl(url: string): { adminUrl: string; baseUrl: URL } {
  const parsed = new URL(url);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  return { adminUrl: admin.toString(), baseUrl: parsed };
}

export async function createTestDatabase(): Promise<TestDatabase> {
  loadDotEnv();
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required to run these tests');

  const name = `wings_worker_test_${randomBytes(6).toString('hex')}`;
  const { adminUrl: admin, baseUrl } = adminUrl(source);

  const adminClient = new pg.Client({ connectionString: admin });
  await adminClient.connect();
  await adminClient.query(`create database "${name}"`);
  await adminClient.end();

  const testUrl = new URL(baseUrl.toString());
  testUrl.pathname = `/${name}`;

  const pool = new pg.Pool({ connectionString: testUrl.toString() });
  // pool.end() resolves before its sockets finish closing; a forced drop would then kill them
  // mid-close, and the late 57P01 is thrown as an unhandled error into whatever test is running.
  let open = 0;
  let allClosed = () => {};
  pool.on('connect', () => (open += 1));
  pool.on('remove', () => {
    open -= 1;
    if (!open) allClosed();
  });
  await migrate(drizzle(pool), {
    migrationsFolder: resolve(import.meta.dirname, '../../../api/migrations'),
  });

  return {
    pool,
    drop: async () => {
      const closed = new Promise<void>((resolve) => (allClosed = resolve));
      await pool.end();
      if (open) await closed;
      const cleanup = new pg.Client({ connectionString: admin });
      await cleanup.connect();
      await cleanup.query(`drop database if exists "${name}" with (force)`);
      await cleanup.end();
    },
  };
}
