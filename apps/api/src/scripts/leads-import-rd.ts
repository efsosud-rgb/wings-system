import { LEAD_PIPELINES, type LeadPipeline } from '@wings/shared';
import { createDb } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { loadEnv } from '../env.js';
import { auditLog } from '../db/schema/index.js';
import {
  importRdDeals,
  rdCrmReader,
  rdOwnerAllowlist,
  type RdImportResult,
} from '../modules/leads/rd-import.js';

/**
 * Brings RD CRM's Expansão and Formatação deals into the Funil (CRM phase 1,
 * docs/crm/fase1-complemento-funil.md §2.3). Reads RD only. Simulates by
 * default (reads RD and the Funil, writes nothing); `--apply` writes. Safe to
 * run again: a deal already in the Funil is updated, never duplicated.
 *
 *   pnpm --filter @wings/api leads:import-rd [--apply] [--since=2026-06-30] [--no-histories]
 *   node dist/scripts/leads-import-rd.js [--apply] ...        # in the API container
 *
 * A backlog of recent deals the hourly follow-up never saw (it only looks 3 days back):
 *   --window             list only deals created from --since until now (older open ones are not read)
 *   --only-missing       skip deals the Funil already has (nothing existing is touched)
 *   --rotate             new leads with no owner from RD go to the funnel's rotation, however old
 *                        (no first-contact task and no notice for those over 24 h)
 *   --pipeline=formatacao[,expansao]   only these funnels
 *
 * The output is counts, brand names and RD field shapes — never a person.
 */
export function formatImport(result: RdImportResult, ownerAllowlist = false): string {
  const brands = Object.entries(result.brands).sort((a, b) => b[1] - a[1]);
  return [
    result.applied ? 'APLICADO' : 'SIMULAÇÃO (nada foi gravado; rode com --apply para valer)',
    `negócios lidos no RD: ${result.dealsListed}`,
    `no escopo: Expansão ${result.inScope.expansao}, Formatação ${result.inScope.formatacao}`,
    `  nos funis de arquivo do RD (sem etapa; ganho ${result.archiveOutcome.won}, perdido ${result.archiveOutcome.lost}): ${result.inArchive}`,
    `fora do escopo (funil do RD sem funil no Wings): ${
      Object.entries(result.outOfScope)
        .map(([funnel, count]) => `${funnel} ${count}`)
        .join(', ') || 'nenhum'
    }`,
    `leads ${result.applied ? 'criados' : 'a criar'}: ${result.created}; ligados a um lead que já existia: ${result.merged}`,
    `outro negócio da mesma pessoa: ${result.otherDealOfSamePerson}; sem e-mail nem telefone: ${result.noContactData}; de teste (não entram): ${result.testDeals}`,
    `dono: ${result.owners.mapped} mantêm o dono do RD, ${result.owners.unmapped} entram sem dono${ownerAllowlist ? ' (só os donos de CRM_RD_OWNER_USER_IDS ficam)' : ''}`,
    `rodízio: ${result.rotation.assigned} com dono do rodízio, ${result.rotation.empty} sem dono (rodízio vazio)`,
    `usuários do RD: ${result.rdUsers.listed} (ligados agora por e-mail ${result.rdUsers.linkedByEmail}, por nome ${result.rdUsers.linkedByName})`,
    `histórico de etapas: ${result.histories.read} lido(s), ${result.histories.failed} falha(s), ${result.histories.withFirstContact} com 1º contato`,
    `marcas (Expansão):`,
    ...brands.map(([brand, count]) => `  ${brand}: ${count}`),
    `marcas sem cliente: ${result.unmatchedBrands.length === 0 ? 'nenhuma' : result.unmatchedBrands.join(', ')}`,
    `falhas: ${result.failed}`,
  ].join('\n');
}

async function main() {
  loadDotEnv();
  const env = loadEnv(process.env);
  if (!env.RD_CRM_API_TOKEN) throw new Error('RD_CRM_API_TOKEN is not set');
  const sinceArg = process.argv.find((arg) => arg.startsWith('--since='))?.slice(8) ?? '2026-06-30';
  const since = new Date(`${sinceArg}T00:00:00-03:00`);
  if (Number.isNaN(since.getTime())) throw new Error('--since must be YYYY-MM-DD');
  const apply = process.argv.includes('--apply');
  const rotate = process.argv.includes('--rotate');
  const pipelineArg = process.argv.find((arg) => arg.startsWith('--pipeline='))?.slice(11);
  const onlyPipelines = pipelineArg
    ? (pipelineArg.split(',').map((name) => name.trim()) as LeadPipeline[])
    : undefined;
  if (onlyPipelines?.some((name) => !LEAD_PIPELINES.includes(name)))
    throw new Error(`--pipeline must be a list of: ${LEAD_PIPELINES.join(', ')}`);
  // One id per applied run: new leads carry it, and `leads-import-rd-undo --batch=<id>` takes the run back.
  const batchId = apply
    ? `rd-crm-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}Z`
    : undefined;
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    if (batchId) console.warn(`lote: ${batchId}`);
    const result = await importRdDeals(db, rdCrmReader(env.RD_CRM_API_TOKEN), {
      apply,
      batchId,
      since,
      ...(process.argv.includes('--window') ? { window: { since, until: new Date() } } : {}),
      histories: !process.argv.includes('--no-histories'),
      onlyMissing: process.argv.includes('--only-missing'),
      distributeNew: rotate,
      rotateOld: rotate,
      ...(onlyPipelines ? { onlyPipelines } : {}),
      ownerRdUserIds: rdOwnerAllowlist(env.CRM_RD_OWNER_USER_IDS),
      log: (facts) => console.warn(JSON.stringify(facts)),
      onProgress: (done, total) => {
        if (done % 50 === 0) console.warn(`${done}/${total}`);
      },
    });
    console.warn(formatImport(result, Boolean(env.CRM_RD_OWNER_USER_IDS)));
    if (batchId) {
      await db.insert(auditLog).values({
        action: 'leads.import_rd',
        entity: 'lead_import_batch',
        entityId: batchId,
        metadata: {
          since: sinceArg,
          created: result.created,
          merged: result.merged,
          rotation: result.rotation,
          inScope: result.inScope,
          failed: result.failed,
        },
      });
      console.warn(
        `para desfazer só este lote: node dist/scripts/leads-import-rd-undo.js --batch=${batchId} [--apply]`,
      );
    }
  } finally {
    await pool.end();
  }
}

if (/leads-import-rd\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'leads-import-rd failed');
    process.exit(1);
  });
}
