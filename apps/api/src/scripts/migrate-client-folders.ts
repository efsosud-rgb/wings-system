import { createDb } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { loadEnv } from '../env.js';
import {
  ClientFolderMigrationBlocked,
  migrateClientFolders,
  type ClientFolderMigrationReport,
} from '../modules/drive/client-folders-migration.js';

/**
 * Moves the Drive to the Clientes/<NN. Nome> tree (docs/drive.md). Simulates by
 * default: everything runs in a transaction that is rolled back, and the
 * report says what would happen. `--apply` makes it real, and stops (exit 2,
 * nothing written) if an old folder still holds a file. Safe to run again.
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
    `pastas do layout antigo: ${report.oldFolders.length} (${report.oldFolders.filter((folder) => folder.empty).length} vazias)${report.blockedBy.length > 0 ? ' — alguma ainda tem arquivo: --apply PARA sem gravar nada' : `; ${report.applied ? '' : 'seriam '}apagadas ${report.foldersDeleted} pastas vazias`}`,
    ...report.oldFolders.map(
      (folder) => `  ${folder.path}${folder.empty ? ' (vazia)' : ' (AINDA COM ARQUIVOS)'}`,
    ),
    ...report.accessNotes.map((note) => `atenção: ${note}`),
  ];
  return lines.join('\n');
}

async function main() {
  loadDotEnv();
  const env = loadEnv(process.env);
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    try {
      const report = await migrateClientFolders(db, { apply: process.argv.includes('--apply') });
      console.warn(formatReport(report));
    } catch (error) {
      if (!(error instanceof ClientFolderMigrationBlocked)) throw error;
      console.warn(formatReport(error.report));
      console.error(error.message);
      process.exitCode = 2;
    }
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
