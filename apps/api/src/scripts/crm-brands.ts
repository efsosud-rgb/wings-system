import { createDb } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { loadEnv } from '../env.js';
import {
  applyBrandContacts,
  EXPANSION_BRANDS,
  EXPANSION_BRANDS_2026_09_30,
  formatBrandContactsReport,
  formatBrandReport,
  formatLegacyMoveReport,
  moveLegacyBrandsToExpansion,
  registerBrands,
} from '../modules/leads/brands.js';

/**
 * Registers the Expansão brands as clients and ties their landing-page rules
 * to them (docs/crm/fase1-complemento-funil.md §2.1). Simulates by default;
 * `--apply` makes it real. Safe to run again. Prints brand names and landing
 * page identifiers only — nothing about any lead.
 *
 * `--expansion-legacy` (B5, Eric 01/10): the 8 brands of the first run move
 * to Expansão and their projects are hidden from the board (not deleted).
 *
 *   pnpm --filter @wings/api crm:brands [--apply]
 *   node dist/scripts/crm-brands.js [--apply]      # in the API container
 *   node dist/scripts/crm-brands.js --expansion-legacy [--apply]
 *
 * `--contacts` (T6, Eric 01/10): Instagram and the brand's own WhatsApp (or
 * why it has none) for Cenoritas, Amarjon and Iguari.
 *
 *   node dist/scripts/crm-brands.js --contacts [--apply]
 */
async function main() {
  loadDotEnv();
  const env = loadEnv(process.env);
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    if (process.argv.includes('--contacts')) {
      const report = await applyBrandContacts(db, { apply: process.argv.includes('--apply') });
      console.warn(formatBrandContactsReport(report));
      return;
    }
    if (process.argv.includes('--expansion-legacy')) {
      const report = await moveLegacyBrandsToExpansion(db, {
        apply: process.argv.includes('--apply'),
      });
      console.warn(formatLegacyMoveReport(report));
      return;
    }
    // --set=2026-09-30: the brands Eric listed that day, with the pages read live (rules made for them).
    const set = process.argv.find((arg) => arg.startsWith('--set='))?.slice(6);
    const pages = set === '2026-09-30' ? EXPANSION_BRANDS_2026_09_30 : [];
    const names = set === '2026-09-30' ? pages.map((brand) => brand.name) : EXPANSION_BRANDS;
    const report = await registerBrands(db, {
      names,
      pages,
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
