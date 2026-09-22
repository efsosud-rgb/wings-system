import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

/**
 * Waits for the `jobs` table to exist. On a first deploy the API container
 * runs its migration before serving; this worker starts at the same time and
 * would otherwise crash-loop on that race, so it retries a few times first.
 */
export async function waitForJobsTable(
  pool: Pool,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 15;
  const delayMs = options.delayMs ?? 2000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.query('select 1 from jobs limit 0');
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `the "jobs" table is not reachable after ${attempts} attempts (has the API run its migration?): ${String(lastError)}`,
  );
}
