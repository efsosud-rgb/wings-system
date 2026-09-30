import { createDb } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { loadEnv } from '../env.js';
import { EXPANSION_BRANDS, formatBrandReport, registerBrands } from '../modules/leads/brands.js';

/**
 * Registers the Expansão brands as clients and ties their landing-page rules
 * to them (docs/crm/fase1-complemento-funil.md §2.1). Simulates by default;
 * `--apply` makes it real. Safe to run again. Prints brand names and landing
 * page identifiers only — nothing about any lead.
 *
 *   pnpm --filter @wings/api crm:brands [--apply]
 *   node dist/scripts/crm-brands.js [--apply]      # in the API container
 */
async function main() {
  loadDotEnv();
  const env = loadEnv(process.env);
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const report = await registerBrands(db, {
      names: EXPANSION_BRANDS,
      apply: process.argv.includes('--apply'),
    });
    console.warn(formatBrandReport(report));
  } finally {
    await pool.end();
  }
}

if (/crm-brands\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'crm-brands failed');
    process.exit(1);
  });
}
