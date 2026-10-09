import { createHash } from 'node:crypto';
import { WA_ART_REFUSALS, WINGS_CLIENT_ID, type BrandArticle } from '@wings/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clients, driveFiles, employees, roles } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import { mediaFolderFor } from '../drive/folders.js';
import { newStorageKey } from '../drive/service.js';
import { inspectArt } from './art.js';

/**
 * Loading the brands' WhatsApp art from a folder (docs/whatsapp/arte-modelos.md,
 * `carregar-artes.sh`): each file matched to a brand by its slug, checked
 * exactly as the screen checks it, written to the brand's Mídia folder in the
 * Drive and set as its art. `estado` and `simular` write nothing; `aplicar`
 * keeps, per batch, what each brand had (schema `ops`), so `desfazer` puts it
 * back. Files are never deleted. Prints brand names and counts only.
 */

/** Not brands: the contact sheet the arts were checked on. */
export const IGNORED_FILES = new Set(['folha-de-contato']);

/** A file named otherwise than the brand's slug (`<arquivo>` → slug). Checked in `estado`. */
export const FILE_SLUG_EXCEPTIONS: Readonly<Record<string, string>> = {
  iguarigourmet: 'iguari',
  pensoulavou: 'pensou-lavou',
};

export const WINGS_ART_FILE = 'wings';

export interface ArtLoadFile {
  /** The file's name, e.g. `malkuth.png`. */
  name: string;
  bytes: Buffer;
}

export type ArtVerdict = 'nova' | 'troca' | 'igual' | 'recusada' | 'sem arquivo';

export interface ArtLoadLine {
  clientId: string;
  slug: string;
  name: string;
  file: string | null;
  verdict: ArtVerdict;
  reason: string | null;
  hasArt: boolean;
  article: BrandArticle | null;
  /** The article the load would set, when the TSV gives one that differs. */
  newArticle: BrandArticle | null;
  bytes: Buffer | null;
  mimeType: 'image/png' | 'image/jpeg' | null;
}

export interface ArtLoadPlan {
  brands: ArtLoadLine[];
  /** The Wings art, when the folder has `wings.png`/`wings.jpg`. */
  wings: ArtLoadLine | null;
  /** Files no brand matches. */
  orphans: string[];
  /** TSV lines naming no brand. */
  unknownArticles: string[];
}

const stem = (file: string) => file.replace(/\.(png|jpe?g)$/i, '').toLowerCase();
const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** `slug<TAB>o|a` (or the brand's name), one per line; `#` starts a comment. */
export function parseArticles(text: string): Map<string, BrandArticle> {
  const out = new Map<string, BrandArticle>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [key, value] = line.split(/\t|\s{2,}|;/).map((part) => part.trim());
    const article = value?.toLowerCase();
    if (key && (article === 'o' || article === 'a')) out.set(key.toLowerCase(), article);
  }
  return out;
}

export async function planArtLoad(
  db: Database,
  input: { files: ArtLoadFile[]; articles: Map<string, BrandArticle> },
): Promise<ArtLoadPlan> {
  const rows = await db
    .select({
      id: clients.id,
      slug: clients.slug,
      name: clients.name,
      relationship: clients.relationship,
      active: clients.active,
      article: clients.article,
      artFileId: clients.whatsappArtFileId,
      checksum: driveFiles.checksum,
      trashedAt: driveFiles.trashedAt,
    })
    .from(clients)
    .leftJoin(driveFiles, eq(driveFiles.id, clients.whatsappArtFileId))
    .orderBy(asc(clients.name));
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const usable = input.files.filter((f) => /\.(png|jpe?g)$/i.test(f.name));
  const fileOf = new Map<string, ArtLoadFile>();
  const orphans: string[] = [];
  let wingsFile: ArtLoadFile | null = null;
  for (const file of usable) {
    const key = stem(file.name);
    if (IGNORED_FILES.has(key)) continue;
    if (key === WINGS_ART_FILE) {
      wingsFile = file;
      continue;
    }
    const slug = FILE_SLUG_EXCEPTIONS[key] ?? key;
    const brand = bySlug.get(slug);
    if (brand && brand.id !== WINGS_CLIENT_ID) fileOf.set(slug, file);
    else orphans.push(file.name);
  }

  const articleFor = (row: { slug: string; name: string }) =>
    input.articles.get(row.slug) ?? input.articles.get(row.name.toLowerCase()) ?? null;
  const known = new Set<string>();
  const lineOf = (row: (typeof rows)[number], file: ArtLoadFile | null): ArtLoadLine => {
    known.add(row.slug);
    known.add(row.name.toLowerCase());
    const hasArt = row.artFileId !== null && row.trashedAt === null;
    const article: BrandArticle | null =
      row.article === 'o' || row.article === 'a' ? row.article : null;
    const wanted = row.id === WINGS_CLIENT_ID ? null : articleFor(row);
    const base = {
      clientId: row.id,
      slug: row.slug,
      name: row.name,
      file: file?.name ?? null,
      hasArt,
      article,
      newArticle: wanted && wanted !== article ? wanted : null,
      bytes: null,
      mimeType: null,
    };
    if (!file) return { ...base, verdict: 'sem arquivo', reason: null };
    const declared = /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg';
    const refused = inspectArt(file.bytes, declared);
    if (refused) return { ...base, verdict: 'recusada', reason: WA_ART_REFUSALS[refused] };
    const same = hasArt && row.checksum === sha256(file.bytes);
    return {
      ...base,
      verdict: same ? 'igual' : hasArt ? 'troca' : 'nova',
      reason: null,
      bytes: same ? null : file.bytes,
      mimeType: declared,
    };
  };

  const brands = rows
    .filter(
      (row) =>
        row.id !== WINGS_CLIENT_ID &&
        (fileOf.has(row.slug) ||
          (row.active && (row.relationship === 'expansao' || row.relationship === 'ambos'))),
    )
    .map((row) => lineOf(row, fileOf.get(row.slug) ?? null));
  const wingsRow = rows.find((row) => row.id === WINGS_CLIENT_ID);
  const wings = wingsRow && wingsFile ? lineOf(wingsRow, wingsFile) : null;
  const unknownArticles = [...input.articles.keys()].filter((key) => !known.has(key));
  return { brands, wings, orphans: orphans.sort(), unknownArticles };
}

// --- the batch, in schema ops -------------------------------------------------------------------

export async function ensureOpsTables(db: Database) {
  await db.execute(sql`create schema if not exists ops`);
  await db.execute(sql`
    create table if not exists ops.brand_art_runs (
      batch_id text primary key,
      started_at timestamptz not null,
      applied_at timestamptz,
      undone_at timestamptz,
      summary jsonb not null default '{}'::jsonb
    )`);
  await db.execute(sql`
    create table if not exists ops.brand_art_changes (
      batch_id text not null references ops.brand_art_runs (batch_id),
      client_id uuid not null,
      previous_file_id uuid,
      previous_set_at timestamptz,
      previous_article text,
      new_file_id uuid,
      new_article text,
      undone_at timestamptz,
      primary key (batch_id, client_id)
    )`);
}

/** Whether a batch was ever applied here; the read-only modes never create the tables. */
async function opsTablesExist(db: Database): Promise<boolean> {
  const found = await db.execute<{ runs: string | null }>(
    sql`select to_regclass('ops.brand_art_changes')::text as runs`,
  );
  return Boolean(found.rows[0]?.runs);
}

/** The oldest active Admin Master: the owner of the files and the author in the audit. */
export async function loadOwner(db: Database): Promise<string | null> {
  const [row] = await db
    .select({ id: employees.id })
    .from(employees)
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .where(and(eq(roles.key, 'admin_master'), eq(employees.status, 'active')))
    .orderBy(asc(employees.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export interface ArtLoadResult {
  batchId: string;
  arts: number;
  articles: number;
  skipped: string[];
}

export async function applyArtLoad(
  db: Database,
  storage: ObjectStorage,
  plan: ArtLoadPlan,
  options: { batchId: string; ownerId: string; now: Date },
): Promise<ArtLoadResult> {
  const { batchId, ownerId, now } = options;
  await ensureOpsTables(db);
  await db.execute(
    sql`insert into ops.brand_art_runs (batch_id, started_at) values (${batchId}, ${now})`,
  );
  const result: ArtLoadResult = { batchId, arts: 0, articles: 0, skipped: [] };
  const lines = [...plan.brands, ...(plan.wings ? [plan.wings] : [])];
  for (const line of lines) {
    const art = (line.verdict === 'nova' || line.verdict === 'troca') && line.bytes;
    if (!art && !line.newArticle) continue;
    const folder = art ? await mediaFolderFor(db, line.clientId) : null;
    if (art && !folder) {
      result.skipped.push(`${line.name}: sem a pasta Mídia no Drive`);
      continue;
    }
    let storageKey: string | null = null;
    if (art && line.bytes && line.mimeType) {
      storageKey = newStorageKey(now);
      await storage.put(storageKey, line.bytes, line.mimeType);
    }
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          fileId: clients.whatsappArtFileId,
          setAt: clients.whatsappArtSetAt,
          article: clients.article,
        })
        .from(clients)
        .where(eq(clients.id, line.clientId))
        .for('update');
      let newFileId: string | null = current?.fileId ?? null;
      if (storageKey && folder && line.bytes && line.mimeType) {
        const [made] = await tx
          .insert(driveFiles)
          .values({
            folderId: folder.id,
            name: `Arte do WhatsApp ${now.toISOString().slice(0, 10)} (carga ${batchId.slice(-16)}).${
              line.mimeType === 'image/png' ? 'png' : 'jpg'
            }`,
            mimeType: line.mimeType,
            byteSize: line.bytes.length,
            storageKey,
            ownerId,
            clientId: folder.clientId,
            checksum: sha256(line.bytes),
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: driveFiles.id });
        newFileId = made!.id;
      }
      await tx
        .update(clients)
        .set({
          ...(storageKey ? { whatsappArtFileId: newFileId, whatsappArtSetAt: now } : {}),
          ...(line.newArticle ? { article: line.newArticle } : {}),
        })
        .where(eq(clients.id, line.clientId));
      await tx.execute(sql`
        insert into ops.brand_art_changes
          (batch_id, client_id, previous_file_id, previous_set_at, previous_article, new_file_id, new_article)
        values (${batchId}, ${line.clientId}, ${current?.fileId ?? null}, ${current?.setAt ?? null},
                ${current?.article ?? null}, ${newFileId}, ${line.newArticle ?? current?.article ?? null})`);
      if (storageKey)
        await writeAudit(tx, {
          actorEmployeeId: ownerId,
          action: 'client.whatsapp_art_set',
          entity: 'client',
          entityId: line.clientId,
          ip: null,
          metadata: { fileId: newFileId, previousFileId: current?.fileId ?? null, batch: batchId },
        });
      if (line.newArticle)
        await writeAudit(tx, {
          actorEmployeeId: ownerId,
          action: 'client.whatsapp_article_set',
          entity: 'client',
          entityId: line.clientId,
          ip: null,
          metadata: { article: line.newArticle, batch: batchId },
        });
    });
    if (storageKey) result.arts++;
    if (line.newArticle) result.articles++;
  }
  await db.execute(sql`
    update ops.brand_art_runs
    set applied_at = ${new Date()}, summary = ${JSON.stringify(result)}::jsonb
    where batch_id = ${batchId}`);
  return result;
}

export interface ArtUndoLine {
  name: string;
  action: 'volta' | 'mudou depois' | 'já desfeito';
}

/**
 * Puts back what each brand of the batch had, unless the brand changed after
 * the batch (then it is left as it is, and said). Nothing is deleted: the
 * batch's files stay in the Drive.
 */
export async function undoArtLoad(
  db: Database,
  batchId: string,
  options: { apply: boolean; actorId: string | null; now: Date },
): Promise<{ found: boolean; lines: ArtUndoLine[] }> {
  if (!(await opsTablesExist(db))) return { found: false, lines: [] };
  const run = await db.execute<{ undone_at: Date | null }>(
    sql`select undone_at from ops.brand_art_runs where batch_id = ${batchId}`,
  );
  if (run.rows.length === 0) return { found: false, lines: [] };
  const changes = await db.execute<{
    client_id: string;
    previous_file_id: string | null;
    previous_set_at: Date | null;
    previous_article: string | null;
    new_file_id: string | null;
    new_article: string | null;
    undone_at: Date | null;
  }>(sql`select * from ops.brand_art_changes where batch_id = ${batchId} order by client_id`);
  const ids = changes.rows.map((c) => c.client_id);
  const now = ids.length
    ? await db
        .select({
          id: clients.id,
          name: clients.name,
          fileId: clients.whatsappArtFileId,
          article: clients.article,
        })
        .from(clients)
        .where(inArray(clients.id, ids))
    : [];
  const byId = new Map(now.map((c) => [c.id, c]));
  const lines: ArtUndoLine[] = [];
  for (const change of changes.rows) {
    const client = byId.get(change.client_id);
    if (!client) continue;
    if (change.undone_at) {
      lines.push({ name: client.name, action: 'já desfeito' });
      continue;
    }
    const untouched = client.fileId === change.new_file_id && client.article === change.new_article;
    lines.push({ name: client.name, action: untouched ? 'volta' : 'mudou depois' });
    if (!options.apply || !untouched) continue;
    await db.transaction(async (tx) => {
      // The previous art comes back only while its file is still there (not purged).
      const [previous] = change.previous_file_id
        ? await tx
            .select({ id: driveFiles.id })
            .from(driveFiles)
            .where(and(eq(driveFiles.id, change.previous_file_id), isNull(driveFiles.trashedAt)))
        : [];
      await tx
        .update(clients)
        .set({
          whatsappArtFileId: previous?.id ?? null,
          whatsappArtSetAt: previous ? change.previous_set_at : null,
          article: change.previous_article,
        })
        .where(eq(clients.id, change.client_id));
      await tx.execute(sql`
        update ops.brand_art_changes set undone_at = ${options.now}
        where batch_id = ${batchId} and client_id = ${change.client_id}`);
      if (options.actorId)
        await writeAudit(tx, {
          actorEmployeeId: options.actorId,
          action: 'client.whatsapp_art_set',
          entity: 'client',
          entityId: change.client_id,
          ip: null,
          metadata: {
            fileId: previous?.id ?? null,
            previousFileId: change.new_file_id,
            undoneBatch: batchId,
          },
        });
    });
  }
  if (options.apply)
    await db.execute(
      sql`update ops.brand_art_runs set undone_at = ${options.now} where batch_id = ${batchId}`,
    );
  return { found: true, lines };
}

/** The batches applied in this database, oldest first. */
export async function listArtRuns(db: Database): Promise<string[]> {
  if (!(await opsTablesExist(db))) return [];
  const runs = await db.execute<{
    batch_id: string;
    applied_at: Date | null;
    undone_at: Date | null;
    summary: { arts?: number; articles?: number };
  }>(
    sql`select batch_id, applied_at, undone_at, summary from ops.brand_art_runs order by started_at`,
  );
  return runs.rows.map(
    (run) =>
      `${run.batch_id} · ${run.undone_at ? 'DESFEITO' : run.applied_at ? 'valendo' : 'INTERROMPIDO'} · artes ${
        run.summary.arts ?? 0
      }, artigos ${run.summary.articles ?? 0}`,
  );
}

// --- what the person reads -------------------------------------------------------------------

const ARTICLE_TEXT = (article: BrandArticle | null) => (article ? `"${article}"` : 'não informado');

export function formatArtPlan(plan: ArtLoadPlan, mode: 'estado' | 'simular'): string {
  const out: string[] = [];
  const count = (verdict: ArtVerdict) => plan.brands.filter((b) => b.verdict === verdict).length;
  if (mode === 'estado') {
    out.push('== Marcas (Expansão) e a arte de cada uma');
    for (const b of plan.brands)
      out.push(
        `  ${b.name} [${b.slug}]: ${b.hasArt ? 'com arte' : 'SEM arte'}; artigo ${ARTICLE_TEXT(
          b.article,
        )}; arquivo ${b.file ?? '—'}`,
      );
  } else {
    out.push('== O que mudaria (nada foi gravado)');
    for (const b of plan.brands) {
      if (b.verdict === 'sem arquivo' && !b.newArticle) continue;
      const art =
        b.verdict === 'recusada'
          ? `arte: RECUSADA (${b.reason})`
          : b.verdict === 'sem arquivo'
            ? 'arte: sem arquivo'
            : `arte: ${b.verdict}`;
      const article = b.newArticle ? `; artigo ${ARTICLE_TEXT(b.article)} → "${b.newArticle}"` : '';
      out.push(`  ${b.name}: ${art}${article}`);
    }
  }
  out.push('== Arte da Wings (Formatação)');
  out.push(
    plan.wings
      ? `  arquivo ${plan.wings.file}: ${plan.wings.verdict}${plan.wings.reason ? ` (${plan.wings.reason})` : ''}`
      : '  nenhum arquivo wings.png/wings.jpg na pasta',
  );
  out.push('== Arquivos sem marca');
  out.push(plan.orphans.length ? plan.orphans.map((f) => `  ${f}`).join('\n') : '  nenhum');
  if (plan.unknownArticles.length) {
    out.push('== Artigos de marcas que não existem no cadastro');
    out.push(plan.unknownArticles.map((k) => `  ${k}`).join('\n'));
  }
  const missing = plan.brands.filter((b) => !b.hasArt && b.verdict === 'sem arquivo');
  out.push('== O que falta');
  out.push(
    `  marcas sem arte e sem arquivo: ${missing.length}${
      missing.length ? ` (${missing.map((b) => b.name).join(', ')})` : ''
    }`,
  );
  out.push(`  marcas sem artigo: ${plan.brands.filter((b) => !b.article && !b.newArticle).length}`);
  out.push(
    `contagens: nova ${count('nova')} · troca ${count('troca')} · igual ${count('igual')} · recusada ${count(
      'recusada',
    )} · sem arquivo ${count('sem arquivo')} · artigos a gravar ${
      [...plan.brands].filter((b) => b.newArticle).length
    }`,
  );
  return out.join('\n');
}
