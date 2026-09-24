import { createDb } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { loadEnv } from '../env.js';
import {
  migrateClientFolders,
  type ClientFolderMigrationReport,
} from '../modules/drive/client-folders-migration.js';

/**
 * Moves the Drive to the Clientes/<NN. Nome> tree (docs/drive.md). Simulates by
 * default: everything runs in a transaction that is rolled back, and the
 * report says what would happen. `--apply` makes it real. Safe to run again.
 *
 *   pnpm --filter @wings/api drive:migrate-client-folders            # simulate
 *   pnpm --filter @wings/api drive:migrate-client-folders --apply    # do it
 *   node dist/scripts/migrate-client-folders.js [--apply]            # in the API container
 *
 * The output names folders by path and files by id, never by file name.
 */
export function formatReport(report: ClientFolderMigrationReport): string {
  const lines = [
    report.applied ? 'APLICADO' : 'SIMULAÇÃO (nada foi gravado; rode com --apply para valer)',
    `modelo: ${report.templateChanged ? `${report.nodesRemoved} nós saem, ${report.nodesAdded} entram` : 'já estava no formato novo'}`,
    `pastas: ${report.foldersCreated} criadas, ${report.foldersRenamed} renomeadas; ${report.oldClientFolders} pastas de cliente antigas (nada é apagado)`,
    `clientes: ${report.clients.length}`,
    ...report.clients.map(
      (client) =>
        `  ${client.number ?? '—'} ${client.active ? '' : '(inativo) '}${client.folder ?? 'sem pasta nova'} [${client.id}]`,
    ),
    `arquivos movidos: ${report.moves.length}`,
    ...report.moves.map(
      (move) =>
        `  ${move.fileId}: ${move.from} -> ${move.to}${move.renamed ? ' (renomeado com "migrado")' : ''}${move.trashed ? ' (na lixeira)' : ''}`,
    ),
    `arquivos que ficam onde estão: ${report.left.length}`,
    ...report.left.map((item) => `  ${item.fileId}: ${item.from} (${item.reason})`),
    `pastas do layout antigo que ficam, como pastas comuns: ${report.oldFolders.length} (${report.oldFolders.filter((folder) => folder.empty).length} vazias)`,
    ...report.oldFolders.map((folder) => `  ${folder.path}${folder.empty ? ' (vazia)' : ' (ainda com arquivos)'}`),
    ...report.accessNotes.map((note) => `atenção: ${note}`),
  ];
  return lines.join('\n');
}

async function main() {
  loadDotEnv();
  const env = loadEnv(process.env);
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const report = await migrateClientFolders(db, { apply: process.argv.includes('--apply') });
    console.warn(formatReport(report));
  } finally {
    await pool.end();
  }
}

if (/migrate-client-folders\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'migration failed');
    process.exit(1);
  });
}
