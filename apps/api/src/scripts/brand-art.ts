import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createDb } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { loadEnv } from '../env.js';
import { storageOf } from '../lib/storage/index.js';
import {
  applyArtLoad,
  formatArtPlan,
  listArtRuns,
  loadOwner,
  parseArticles,
  planArtLoad,
  undoArtLoad,
  type ArtLoadFile,
} from '../modules/whatsapp/art-load.js';

/**
 * The brands' WhatsApp art from a folder (docs/whatsapp/arte-modelos.md). Run
 * by `/root/relatorios/artes-marcas/carregar-artes.sh`, which copies the
 * folder into the API container:
 *
 *   node dist/scripts/brand-art.js estado  --dir <pasta> [--artigos <arquivo.tsv>]
 *   node dist/scripts/brand-art.js simular --dir <pasta> [--artigos <arquivo.tsv>]
 *   node dist/scripts/brand-art.js aplicar --dir <pasta> [--artigos …] --lote artes-AAAAMMDDTHHMMSSZ --confirmado
 *   node dist/scripts/brand-art.js desfazer artes-AAAAMMDDTHHMMSSZ [--confirmado]
 *
 * Files: `<slug da marca>.png|jpg` (exceptions in FILE_SLUG_EXCEPTIONS) and
 * `wings.png|jpg` for the Wings art. Prints brand names and counts only.
 */

const BATCH = /^artes-\d{8}T\d{6}Z$/;

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? (process.argv[at + 1] ?? null) : null;
};

async function readFolder(dir: string): Promise<ArtLoadFile[]> {
  const files: ArtLoadFile[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    if (!(await stat(path)).isFile() || !/\.(png|jpe?g)$/i.test(name)) continue;
    files.push({ name, bytes: await readFile(path) });
  }
  return files;
}

async function main() {
  const mode = process.argv[2];
  if (!mode || !['estado', 'simular', 'aplicar', 'desfazer'].includes(mode)) {
    console.error('uso: brand-art.js estado|simular|aplicar --dir <pasta> | desfazer <lote>');
    process.exitCode = 2;
    return;
  }
  loadDotEnv();
  const env = loadEnv(process.env);
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    if (mode === 'desfazer') {
      const batch = process.argv[3] ?? '';
      if (!BATCH.test(batch)) {
        console.error('lote inválido (como artes-20261009T150000Z)');
        process.exitCode = 2;
        return;
      }
      const apply = process.argv.includes('--confirmado');
      const owner = await loadOwner(db);
      const undo = await undoArtLoad(db, batch, { apply, actorId: owner, now: new Date() });
      if (!undo.found) {
        console.error(`lote ${batch} não encontrado`);
        process.exitCode = 1;
        return;
      }
      console.warn(
        apply ? `desfeito: ${batch}` : `SIMULAÇÃO do desfazer de ${batch} (nada foi gravado)`,
      );
      for (const line of undo.lines) console.warn(`  ${line.name}: ${line.action}`);
      return;
    }
    const dir = arg('--dir');
    if (!dir) {
      console.error('falta --dir <pasta>');
      process.exitCode = 2;
      return;
    }
    const articlesPath = arg('--artigos');
    const articles = articlesPath
      ? parseArticles(await readFile(articlesPath, 'utf8'))
      : new Map<string, 'o' | 'a'>();
    const plan = await planArtLoad(db, { files: await readFolder(dir), articles });
    if (mode !== 'aplicar') {
      console.warn(formatArtPlan(plan, mode as 'estado' | 'simular'));
      if (mode === 'estado') {
        const runs = await listArtRuns(db);
        console.warn('== Lotes já aplicados');
        console.warn(runs.length ? runs.map((run) => `  ${run}`).join('\n') : '  nenhum');
      }
      return;
    }
    const batch = arg('--lote') ?? '';
    if (!BATCH.test(batch) || !process.argv.includes('--confirmado')) {
      console.error('aplicar pede --lote artes-AAAAMMDDTHHMMSSZ e --confirmado');
      process.exitCode = 2;
      return;
    }
    const refused = [...plan.brands, ...(plan.wings ? [plan.wings] : [])].filter(
      (line) => line.verdict === 'recusada',
    );
    if (refused.length > 0) {
      console.error(
        `há arte recusada (${refused.map((line) => line.name).join(', ')}): corrija ou tire o arquivo; nada foi gravado`,
      );
      process.exitCode = 1;
      return;
    }
    const storage = storageOf({ env });
    if (!storage) {
      console.error('o Drive não está configurado neste ambiente; nada foi gravado');
      process.exitCode = 1;
      return;
    }
    const owner = await loadOwner(db);
    if (!owner) {
      console.error('nenhum Admin Master ativo para ser o dono dos arquivos; nada foi gravado');
      process.exitCode = 1;
      return;
    }
    const result = await applyArtLoad(db, storage, plan, {
      batchId: batch,
      ownerId: owner,
      now: new Date(),
    });
    console.warn(`APLICADO: lote ${result.batchId}`);
    console.warn(`  artes gravadas: ${result.arts} · artigos gravados: ${result.articles}`);
    for (const skipped of result.skipped) console.warn(`  pulada: ${skipped}`);
  } finally {
    await pool.end();
  }
}

if (/brand-art\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'brand-art failed');
    process.exitCode = 1;
  });
}
