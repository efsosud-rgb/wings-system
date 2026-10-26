import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDb, type Database } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { seed } from '../db/seed.js';

/**
 * Each integration test run gets its own throwaway database, migrated and
 * seeded from scratch. Tests can therefore insert freely — including
 * append-only rows that can never be deleted — without polluting anything.
 */
export interface TestDatabase {
  db: Database;
  url: string;
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
  if (!source) throw new Error('DATABASE_URL is required to run integration tests');

  const name = `wings_test_${randomBytes(6).toString('hex')}`;
  const { adminUrl: admin, baseUrl } = adminUrl(source);

  const adminClient = new pg.Client({ connectionString: admin });
  await adminClient.connect();
  await adminClient.query(`create database "${name}"`);
  await adminClient.end();

  const testUrl = new URL(baseUrl.toString());
  testUrl.pathname = `/${name}`;
  const url = testUrl.toString();

  const { db, pool } = createDb(url);
  // pool.end() resolves before its sockets finish closing; a forced drop would then kill them
  // mid-close, and the late 57P01 is thrown as an unhandled error into whatever test is running.
  let open = 0;
  let allClosed = () => {};
  pool.on('connect', () => (open += 1));
  pool.on('remove', () => {
    open -= 1;
    if (!open) allClosed();
  });
  await migrate(db, { migrationsFolder: resolve(import.meta.dirname, '../../migrations') });
  await seed(db);

  return {
    db,
    url,
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
