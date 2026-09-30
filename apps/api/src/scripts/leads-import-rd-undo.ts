import { createDb } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { loadEnv } from '../env.js';
import { undoRdImportBatch } from '../modules/leads/rd-import.js';

/**
 * Takes one `leads-import-rd --apply` run back (docs/crm/fase1-operacao.md):
 * removes the leads it created and puts back the ones it changed. Simulates by
 * default; `--apply` does it, in one transaction, with an audit entry.
 *
 *   node dist/scripts/leads-import-rd-undo.js --batch=rd-crm-20260930T2100Z [--apply]
 */
async function main() {
  loadDotEnv();
  const env = loadEnv(process.env);
  const batchId = process.argv.find((arg) => arg.startsWith('--batch='))?.slice(8);
  if (!batchId || !/^rd-crm-[0-9A-Za-z-]+$/.test(batchId))
    throw new Error('--batch=rd-crm-... is required');
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const result = await undoRdImportBatch(db, {
      batchId,
      apply: process.argv.includes('--apply'),
    });
    console.warn(
      [
        result.applied ? 'APLICADO' : 'SIMULAÇÃO (nada foi gravado; rode com --apply para valer)',
        `lote: ${result.batchId}`,
        `leads criados pelo lote ${result.applied ? 'removidos' : 'a remover'}: ${result.created}`,
        `leads que já existiam ${result.applied ? 'restaurados' : 'a restaurar'}: ${result.restored}`,
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

if (/leads-import-rd-undo\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'leads-import-rd-undo failed');
    process.exit(1);
  });
}
