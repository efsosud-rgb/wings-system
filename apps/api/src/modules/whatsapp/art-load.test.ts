import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WINGS_CLIENT_ID } from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { auditLog, clients, driveFiles, driveFolders } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { storageOf, type ObjectStorage } from '../../lib/storage/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  createEmployee,
  fakeJpeg,
  fakePng,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import {
  applyArtLoad,
  formatArtPlan,
  loadOwner,
  parseArticles,
  planArtLoad,
  undoArtLoad,
} from './art-load.js';

/**
 * The load of the brands' art from a folder (carregar-artes.sh): files matched
 * by slug and checked like the screen, nothing written by `estado`/`simular`,
 * `aplicar` in a batch and `desfazer` putting back what each brand had.
 */

let harness: TestDatabase;
let db: Database;
let storage: ObjectStorage;
let dir: string;

let number = 80;
async function brand(name: string, slug: string, extra: Partial<typeof clients.$inferInsert> = {}) {
  const [row] = await db
    .insert(clients)
    .values({ name, slug, number: ++number, relationship: 'expansao', ...extra })
    .returning({ id: clients.id });
  return row!.id;
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  dir = await mkdtemp(join(tmpdir(), 'wings-art-load-'));
  storage = storageOf({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      MEDIA_DIR: dir,
    }),
  })!;
  await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
}, 60_000);

afterAll(async () => {
  await harness?.drop();
  await rm(dir, { recursive: true, force: true });
});

describe('carregar-artes', () => {
  it('plans, applies in a batch and undoes, file by file', async () => {
    const malkuth = await brand('Malkuth', 'malkuth');
    const casal = await brand('Casal do Churros', 'casal-do-churros', { article: 'o' });
    const coluna = await brand('Dr Coluna', 'dr-coluna');
    await brand('Só Crianças', 'so-criancas');
    const iguari = await brand('Iguari', 'iguari');

    const files = [
      { name: 'malkuth.png', bytes: fakePng(1125, 600, 3000) },
      { name: 'casal-do-churros.jpg', bytes: fakeJpeg(1125, 600, 3000) },
      { name: 'dr-coluna.png', bytes: fakePng(1080, 1080) },
      { name: 'iguarigourmet.png', bytes: fakePng(1125, 600, 3100) },
      { name: 'folha-de-contato.png', bytes: fakePng(2000, 2000) },
      { name: 'marca-nova.png', bytes: fakePng(1125, 600) },
      { name: 'wings.png', bytes: fakePng(1125, 600, 2500) },
    ];
    const articles = parseArticles(
      '# marca\tartigo\nmalkuth\ta\nCasal do Churros\to\nninguem\ta\n',
    );

    const plan = await planArtLoad(db, { files, articles });
    const verdict = (name: string) => plan.brands.find((b) => b.name === name);
    expect(verdict('Malkuth')).toMatchObject({ verdict: 'nova', newArticle: 'a' });
    expect(verdict('Casal do Churros')).toMatchObject({ verdict: 'nova', newArticle: null });
    expect(verdict('Dr Coluna')).toMatchObject({
      verdict: 'recusada',
      reason: 'A arte precisa ter 1125 × 600 pixels.',
    });
    expect(verdict('Iguari')).toMatchObject({ verdict: 'nova', file: 'iguarigourmet.png' });
    expect(verdict('Só Crianças')).toMatchObject({ verdict: 'sem arquivo' });
    expect(plan.wings).toMatchObject({ clientId: WINGS_CLIENT_ID, verdict: 'nova' });
    expect(plan.orphans).toEqual(['marca-nova.png']);
    expect(plan.unknownArticles).toEqual(['ninguem']);
    const text = formatArtPlan(plan, 'simular');
    expect(text).toContain('Dr Coluna: arte: RECUSADA (A arte precisa ter 1125 × 600 pixels.)');
    expect(text).toContain('Malkuth: arte: nova; artigo não informado → "a"');
    expect(formatArtPlan(plan, 'estado')).toContain(
      'marcas sem arte e sem arquivo: 1 (Só Crianças)',
    );
    // Planning wrote nothing.
    expect((await db.select().from(clients).where(eq(clients.id, malkuth)))[0]).toMatchObject({
      whatsappArtFileId: null,
      article: null,
    });

    const owner = await loadOwner(db);
    expect(owner).not.toBeNull();
    // The refused one stays out (the command refuses the whole load while one is refused).
    const clean = { ...plan, brands: plan.brands.filter((b) => b.verdict !== 'recusada') };
    const result = await applyArtLoad(db, storage, clean, {
      batchId: 'artes-20261009T150000Z',
      ownerId: owner!,
      now: new Date('2026-10-09T15:00:00Z'),
    });
    expect(result).toMatchObject({ arts: 4, articles: 1, skipped: [] });
    const [m] = await db.select().from(clients).where(eq(clients.id, malkuth));
    expect(m).toMatchObject({ article: 'a' });
    const [file] = await db
      .select()
      .from(driveFiles)
      .where(eq(driveFiles.id, m!.whatsappArtFileId!));
    const [folder] = await db
      .select()
      .from(driveFolders)
      .where(eq(driveFolders.id, file!.folderId));
    expect(folder).toMatchObject({ clientId: malkuth, slot: 'midia' });
    expect(await storage.get(file!.storageKey)).toEqual(files[0]!.bytes);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, malkuth));
    expect(audits.map((a) => a.action).sort()).toEqual([
      'client.whatsapp_art_set',
      'client.whatsapp_article_set',
    ]);
    expect(
      (await db.select().from(clients).where(eq(clients.id, WINGS_CLIENT_ID)))[0]!
        .whatsappArtFileId,
    ).not.toBeNull();

    // Run again: the same files are "igual", nothing to write.
    const again = await planArtLoad(db, { files, articles });
    expect(again.brands.find((b) => b.name === 'Malkuth')).toMatchObject({
      verdict: 'igual',
      newArticle: null,
    });

    // Someone changes Iguari's art after the batch: the undo leaves it alone.
    const [other] = await db
      .insert(driveFiles)
      .values({
        folderId: file!.folderId,
        name: 'outra.png',
        mimeType: 'image/png',
        byteSize: 10,
        storageKey: 'drive/2026-10/outra',
        ownerId: owner!,
      })
      .returning({ id: driveFiles.id });
    await db.update(clients).set({ whatsappArtFileId: other!.id }).where(eq(clients.id, iguari));

    const dry = await undoArtLoad(db, 'artes-20261009T150000Z', {
      apply: false,
      actorId: owner,
      now: new Date(),
    });
    expect(dry.lines.find((l) => l.name === 'Iguari')?.action).toBe('mudou depois');
    expect(dry.lines.find((l) => l.name === 'Malkuth')?.action).toBe('volta');
    expect(
      (await db.select().from(clients).where(eq(clients.id, malkuth)))[0]!.whatsappArtFileId,
    ).not.toBeNull();

    await undoArtLoad(db, 'artes-20261009T150000Z', {
      apply: true,
      actorId: owner,
      now: new Date(),
    });
    expect((await db.select().from(clients).where(eq(clients.id, malkuth)))[0]).toMatchObject({
      whatsappArtFileId: null,
      article: null,
    });
    expect((await db.select().from(clients).where(eq(clients.id, casal)))[0]).toMatchObject({
      whatsappArtFileId: null,
      article: 'o',
    });
    expect(
      (await db.select().from(clients).where(eq(clients.id, iguari)))[0]!.whatsappArtFileId,
    ).toBe(other!.id);
    expect(
      (await db.select().from(clients).where(eq(clients.id, coluna)))[0]!.whatsappArtFileId,
    ).toBeNull();
    // The batch's files stay in the Drive.
    expect(await storage.get(file!.storageKey)).not.toBeNull();
    const run = await db.execute<{ undone_at: Date | null }>(
      sql`select undone_at from ops.brand_art_runs where batch_id = 'artes-20261009T150000Z'`,
    );
    expect(run.rows[0]?.undone_at).not.toBeNull();
    expect(
      (
        await undoArtLoad(db, 'artes-20991231T000000Z', {
          apply: false,
          actorId: owner,
          now: new Date(),
        })
      ).found,
    ).toBe(false);
  });
});
