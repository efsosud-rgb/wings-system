import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { grantedScope, type WaBulkImport } from '@wings/shared';
import { eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { leads } from '../db/schema/index.js';
import { loadDotEnv } from '../db/load-env.js';
import { loadEnv } from '../env.js';
import { storageOf } from '../lib/storage/index.js';
import { activeActorByEmail } from '../modules/auth/service.js';
import { leadFilesAccessOf } from '../modules/drive/access.js';
import type { DriveDeps } from '../modules/drive/service.js';
import { storeLeadFile } from '../modules/leads/files.js';
import {
  addBulkItem,
  applyBulkItem,
  bulkOf,
  bulkReport,
  createBulk,
  discardBulk,
  startBulk,
  undoBulk,
  updateBulkItem,
} from '../modules/whatsapp/import-bulk.js';
import { conversationsOf, type BundleConversation } from '../modules/whatsapp/import-bundle.js';

/**
 * "Importar em lote" from a folder on the server (docs/whatsapp/importar-conversa.md), for exports
 * that came through the Drive. The same steps and rules as the screen:
 *
 *   simular:   node dist/scripts/whatsapp-import-bulk.js --por=<e-mail> --pasta=<pasta>
 *                [--mapa=<nome;telefone.csv>] [--pares=<posicao;negociacao|pular.csv>]
 *              creates the lote's preview only (nothing goes to a deal) and prints its id.
 *   aplicar:   ... --por=<e-mail> --lote=<id> --pasta=<a mesma pasta> --nome-wings="<nome>" --aplicar
 *   desfazer:  ... --por=<e-mail> --lote=<id> [--item=<id>] --desfazer
 *   descartar: ... --por=<e-mail> --lote=<id> --descartar   (a preview never confirmed: its texts go)
 *
 * `--por` is an active Admin Master (`whatsapp.import_bulk`): imports, files and audit entries are
 * theirs. The output is ids and counts only, never a file, contact or deal name.
 */

const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Every conversation in the folder (and its sub-folders), in name order so the positions repeat. */
function conversationsIn(folder: string): BundleConversation[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(folder);
  return files.flatMap((path, index) => {
    try {
      return conversationsOf(path.split('/').pop()!, new Uint8Array(readFileSync(path)));
    } catch {
      // By position only: a file name names the person.
      console.warn(`arquivo ${index + 1} ignorado: não abriu como .txt ou .zip`);
      return [];
    }
  });
}

/** `posicao;<id da negociação>` or `posicao;pular`, one per line. */
export function pairsOf(csv: string): Map<number, string> {
  const pairs = new Map<number, string>();
  for (const line of csv.split(/\r?\n/)) {
    const match =
      /^\s*(\d+)\s*[;,\t]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|pular)\s*$/i.exec(
        line,
      );
    if (match) pairs.set(Number(match[1]), match[2]!.toLowerCase());
  }
  return pairs;
}

function print(bulk: WaBulkImport, heading: string) {
  const by = (state: string) => bulk.items.filter((item) => item.state === state).length;
  console.warn(
    [
      heading,
      `lote: ${bulk.id} (${bulk.state})`,
      `conversas: ${bulk.items.length}; pareadas: ${bulk.items.filter((i) => i.leadId).length}; ` +
        `gravadas: ${by('gravada')}; sem novas: ${by('sem_novas')}; puladas: ${by('pulada')}; ` +
        `falharam: ${by('falhou')}; desfeitas: ${by('desfeita')}`,
      '',
      bulkReport(bulk),
    ].join('\n'),
  );
}

async function simulate(db: Database, actorId: string, folder: string) {
  const mapPath = arg('mapa');
  const bulkId = await createBulk(db, {
    source: 'cli',
    createdBy: actorId,
    ...(mapPath ? { nameMap: readFileSync(mapPath, 'utf8') } : {}),
  });
  for (const conversation of conversationsIn(folder))
    await addBulkItem(db, bulkId, {
      fileName: conversation.fileName,
      byteSize: conversation.bytes.length,
      text: conversation.text,
    });
  const pairsPath = arg('pares');
  if (pairsPath) {
    const items = (await bulkOf(db, bulkId)).items;
    for (const [position, target] of pairsOf(readFileSync(pairsPath, 'utf8'))) {
      const item = items.find((i) => i.position === position);
      if (!item) continue;
      await updateBulkItem(
        db,
        bulkId,
        item.id,
        target === 'pular' ? { skip: true } : { leadId: target },
      );
    }
  }
  print(
    await bulkOf(db, bulkId),
    'SIMULAÇÃO: só a prévia do lote foi gravada, nada foi para as negociações. Para gravar, rode com --lote, --pasta, --nome-wings e --aplicar.',
  );
}

async function apply(
  deps: DriveDeps,
  actor: Parameters<typeof leadFilesAccessOf>[0],
  bulkId: string,
) {
  const { db } = deps;
  const folder = arg('pasta');
  const ourName = arg('nome-wings');
  if (!folder || !ourName) throw new Error('--pasta e --nome-wings são obrigatórios para aplicar');
  let bulk = await bulkOf(db, bulkId);
  if (bulk.state === 'previa') await startBulk(db, bulkId, ourName);
  bulk = await bulkOf(db, bulkId);
  const conversations = conversationsIn(folder);
  const access = leadFilesAccessOf(actor);
  for (const item of bulk.items.filter((i) => i.state === 'pendente' && i.leadId)) {
    // The same file as in the preview: same name and size.
    const conversation = conversations.find(
      (c) => c.fileName === item.fileName && c.bytes.length === item.byteSize,
    );
    if (!conversation) {
      console.warn(`item ${item.id}: arquivo não encontrado na pasta, ficou pendente`);
      continue;
    }
    const lead = await db.query.leads.findFirst({ where: eq(leads.id, item.leadId!) });
    if (!lead) continue;
    const kept = await storeLeadFile(deps, access, lead, {
      name: conversation.fileName,
      mimeType: /\.zip$/i.test(conversation.fileName) ? 'application/zip' : 'text/plain',
      bytes: Buffer.from(conversation.bytes),
    });
    await applyBulkItem(db, bulkId, item.id, {
      fileId: kept.fileId,
      actorEmployeeId: actor.employeeId,
      ip: null,
    });
  }
  print(await bulkOf(db, bulkId), 'APLICADO');
}

async function main() {
  loadDotEnv();
  const env = loadEnv(process.env);
  const email = arg('por');
  if (!email) throw new Error('--por=<e-mail do Admin Master> é obrigatório');
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const actor = await activeActorByEmail(db, email);
    if (!actor || grantedScope(actor, 'whatsapp.import_bulk') === null)
      throw new Error('--por precisa ser um Admin Master ativo');
    const bulkId = arg('lote');
    if (!bulkId) {
      const folder = arg('pasta');
      if (!folder) throw new Error('--pasta=<pasta com as conversas> é obrigatório para simular');
      return await simulate(db, actor.employeeId, folder);
    }
    if (flag('descartar')) {
      await discardBulk(db, bulkId);
      return console.warn(`DESCARTADO: a prévia do lote ${bulkId} saiu do banco`);
    }
    if (flag('desfazer')) {
      const itemId = arg('item');
      const undone = await undoBulk(db, bulkId, {
        ...(itemId ? { itemId } : {}),
        actorEmployeeId: actor.employeeId,
        ip: null,
      });
      return print(
        await bulkOf(db, bulkId),
        `DESFEITO: ${undone.undone} conversa(s), ${undone.removed} mensagem(ns) removida(s)`,
      );
    }
    if (flag('aplicar')) {
      const deps: DriveDeps = {
        db,
        storage: storageOf({ env }),
        maxFileBytes: env.DRIVE_MAX_FILE_BYTES,
        now: () => new Date(),
      };
      return await apply(deps, actor, bulkId);
    }
    print(await bulkOf(db, bulkId), 'LOTE (nada mudou: use --aplicar ou --desfazer)');
  } finally {
    await pool.end();
  }
}

if (/whatsapp-import-bulk\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'whatsapp-import-bulk failed');
    process.exit(1);
  });
}
