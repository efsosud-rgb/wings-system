import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { auditLog, clientProjects, clients, leadSourceRules } from '../../db/schema/index.js';
import { seed } from '../../db/seed.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  applyBrandContacts,
  brandKey,
  EXPANSION_BRANDS,
  formatBrandContactsReport,
  formatBrandReport,
  formatLegacyMoveReport,
  identifierKey,
  moveLegacyBrandsToExpansion,
  registerBrands,
} from './brands.js';
import { listProjects, openProjectForClient } from '../projects/service.js';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

describe('brand keys', () => {
  it('ignores accents, case and "do/dos/da/de"', () => {
    expect(brandKey('Casal dos Churros')).toBe(brandKey('Casal do Churros'));
    expect(brandKey('Açaí da Fila')).toBe('acai fila');
    expect(identifierKey('lp-calcadao-do-frango')).toBe(brandKey('Calçadão do Frango'));
    expect(identifierKey('lista-de-espera-familia-k')).toBe(brandKey('Família K'));
  });
});

describe('registerBrands', () => {
  it('simulates first, writing nothing', async () => {
    const before = await db.select().from(clients);
    const report = await registerBrands(db, { names: EXPANSION_BRANDS, apply: false });
    expect(report.created).toHaveLength(8);
    // Every seeded rule but those of brands not on this list (Wash Club, audit v2 pages).
    expect(
      report.links
        .filter((link) => link.state !== 'linked')
        .map((link) => link.identifier)
        .sort(),
    ).toEqual(
      [
        'wash-club',
        'so-criancas',
        'lion-hair',
        'lionhairoficial',
        'super-dogao-da-nana',
        'sarantopoulos',
      ].sort(),
    );
    expect(await db.select().from(clients)).toHaveLength(before.length);
    expect(formatBrandReport(report)).toContain('SIMULAÇÃO');
  });

  it('registers the missing brands with a number and no Formatação project, ties every seeded rule, and is safe to rerun', async () => {
    const [existing] = await db
      .insert(clients)
      .values({ name: 'Mister Russo', slug: 'mister-russo', number: 40 })
      .returning();
    // A rule a person already pointed elsewhere stays as it is.
    await db.insert(leadSourceRules).values({
      kind: 'landing_page',
      pattern: 'lp-sem-marca-conhecida',
      pipeline: 'expansao',
      brand: 'Marca Desconhecida',
    });
    const report = await registerBrands(db, { names: EXPANSION_BRANDS, apply: true });
    expect(report.created).toHaveLength(7);
    expect(report.existing).toEqual([{ wanted: 'Mister Russo', client: 'Mister Russo' }]);
    const byIdentifier = new Map(report.links.map((link) => [link.identifier, link]));
    expect(byIdentifier.get('casal-do-churros')).toMatchObject({
      state: 'linked',
      client: { name: 'Casal do Churros' },
    });
    expect(byIdentifier.get('lp-calcadao-do-frango')?.client?.name).toBe('Calçadão do Frango');
    expect(byIdentifier.get('lp-mister-russo')?.client).toEqual({
      number: 40,
      name: 'Mister Russo',
    });
    expect(byIdentifier.get('lp-sem-marca-conhecida')).toMatchObject({
      state: 'none',
      client: null,
    });

    const casal = await db.query.clients.findFirst({ where: eq(clients.name, 'Casal do Churros') });
    expect(casal?.number).toBeGreaterThan(40);
    // Expansão brands: no Formatação project (Eric, 30/09).
    expect(
      await db.query.clientProjects.findFirst({ where: eq(clientProjects.clientId, casal!.id) }),
    ).toBeUndefined();
    expect(casal?.relationship).toBe('expansao');
    const rule = await db.query.leadSourceRules.findFirst({
      where: eq(leadSourceRules.pattern, 'casal-do-churros'),
    });
    expect(rule?.clientId).toBe(casal!.id);
    expect(existing).toBeTruthy();
    expect(
      (await db.query.auditLog.findMany({ where: eq(auditLog.action, 'lead_source_rule.linked') }))
        .length,
    ).toBe(11);
    // Audit of 01/10: the form's own identifier, not only the balloon's.
    expect(byIdentifier.get('mister-russo')?.client?.name).toBe('Mister Russo');
    expect(byIdentifier.get('familia-k')?.client?.name).toBe('Família K');
    // Wash Club is not on this list: no client yet, so its rule waits.
    expect(byIdentifier.get('wash-club')).toMatchObject({ state: 'none', client: null });

    const again = await registerBrands(db, { names: EXPANSION_BRANDS, apply: true });
    expect(again.created).toHaveLength(0);
    expect(again.links.filter((link) => link.state === 'linked')).toHaveLength(0);
  });
});

describe('registerBrands with pages (Eric, 30/09)', () => {
  it('registers the new brands, makes the rule of each published page tied to its client, and a draft brand gets no rule', async () => {
    const { EXPANSION_BRANDS_2026_09_30 } = await import('./brands.js');
    const names = EXPANSION_BRANDS_2026_09_30.map((brand) => brand.name);
    const simulated = await registerBrands(db, {
      names,
      pages: EXPANSION_BRANDS_2026_09_30,
      apply: false,
    });
    expect(
      simulated.links.filter((link) => link.state === 'created').map((link) => link.identifier),
    ).toEqual(['cenoritas', 'malkuth', 'amarjon', 'iguari']);
    const applied = await registerBrands(db, {
      names,
      pages: EXPANSION_BRANDS_2026_09_30,
      apply: true,
    });
    expect(applied.created).toEqual(['Cenoritas', 'Malkuth', 'Amarjon', 'Iguari', 'Wash Club']);
    const rule = await db.query.leadSourceRules.findFirst({
      where: eq(leadSourceRules.pattern, 'iguari'),
    });
    const iguari = await db.query.clients.findFirst({ where: eq(clients.name, 'Iguari') });
    expect(rule).toMatchObject({
      clientId: iguari!.id,
      pipeline: 'expansao',
      url: 'https://franquia.wingscompany.com.br/iguari',
    });
    const again = await registerBrands(db, {
      names,
      pages: EXPANSION_BRANDS_2026_09_30,
      apply: true,
    });
    expect(again.created).toEqual([]);
    expect(again.links.filter((link) => link.state === 'created')).toEqual([]);
  });
});

describe('B5: the 8 old brands move to Expansão, their projects hidden (Eric, 01/10)', () => {
  it('simulates first; then sets Expansão (keeps "ambos"), hides the projects and deletes nothing', async () => {
    await registerBrands(db, { names: EXPANSION_BRANDS, apply: true });
    const byName = async (name: string) =>
      (await db.select().from(clients)).find((client) => brandKey(client.name) === brandKey(name))!;
    const churros = await byName('Casal do Churros');
    const ginteco = await byName('Ginteco');
    const familia = await byName('Família K');
    await db.update(clients).set({ relationship: null }).where(eq(clients.id, churros.id));
    await db.update(clients).set({ relationship: 'formatacao' }).where(eq(clients.id, ginteco.id));
    await db.update(clients).set({ relationship: 'ambos' }).where(eq(clients.id, familia.id));
    for (const client of [churros, ginteco, familia]) await openProjectForClient(db, client.id);
    const projectsBefore = (await db.select().from(clientProjects)).length;

    const simulated = await moveLegacyBrandsToExpansion(db, { apply: false });
    expect(simulated.moves).toHaveLength(8);
    expect(formatLegacyMoveReport(simulated)).toContain('SIMULAÇÃO');
    expect((await byName('Ginteco')).relationship).toBe('formatacao');
    expect((await db.select().from(clientProjects)).every((p) => p.hiddenAt === null)).toBe(true);

    const applied = await moveLegacyBrandsToExpansion(db, { apply: true });
    expect(applied.moves.filter((move) => move.project === 'hidden')).toHaveLength(3);
    expect((await byName('Casal do Churros')).relationship).toBe('expansao');
    expect((await byName('Ginteco')).relationship).toBe('expansao');
    expect((await byName('Família K')).relationship).toBe('ambos');
    expect((await db.select().from(clientProjects)).length).toBe(projectsBefore);

    const actor = {
      role: 'admin_master',
      sector: 'diretoria',
      employeeId: 'x',
    } as unknown as Parameters<typeof listProjects>[1];
    const board = await listProjects(db, actor);
    expect(board.some((project) => project.clientId === churros.id)).toBe(false);
    const withHidden = await listProjects(db, actor, { hidden: true });
    expect(withHidden.find((project) => project.clientId === churros.id)?.hidden).toBe(true);

    const again = await moveLegacyBrandsToExpansion(db, { apply: true });
    expect(again.moves.filter((move) => move.project === 'hidden')).toHaveLength(0);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'project.hidden'));
    expect(audit).toHaveLength(3);
  });
});

describe('seeded rules (audit of 01/10)', () => {
  it('ties a new seeded rule to its brand client when one exists, and never touches an existing rule', async () => {
    const wash =
      (await db.query.clients.findFirst({ where: eq(clients.name, 'Wash Club') })) ??
      (
        await db.insert(clients).values({ name: 'Wash Club', slug: 'wash-club-seed' }).returning()
      )[0]!;
    await db.delete(leadSourceRules).where(eq(leadSourceRules.pattern, 'wash-club'));
    await db
      .update(leadSourceRules)
      .set({ brand: 'Renomeada por alguém' })
      .where(eq(leadSourceRules.pattern, 'familia-k'));

    await seed(db);

    expect(
      await db.query.leadSourceRules.findFirst({ where: eq(leadSourceRules.pattern, 'wash-club') }),
    ).toMatchObject({
      pipeline: 'expansao',
      brand: 'Wash Club',
      clientId: wash.id,
      // No RD deal from it until Eric decides (01/10).
      rdDealIntake: false,
    });
    expect(
      (
        await db.query.leadSourceRules.findFirst({
          where: eq(leadSourceRules.pattern, 'familia-k'),
        })
      )?.brand,
    ).toBe('Renomeada por alguém');
  });
});

describe('T6: brand contacts (Eric, 01/10)', () => {
  it('simulates first; then writes Instagram and the own WhatsApp (or why none), once', async () => {
    const existing = await db.select().from(clients);
    let number = 900;
    for (const name of ['Cenoritas', 'Amarjon', 'Iguari']) {
      if (existing.some((client) => brandKey(client.name) === brandKey(name))) continue;
      await db.insert(clients).values({
        name,
        slug: `${name.toLowerCase()}-t6`,
        number: number++,
        social: { facebook: 'fb.com/x' },
      });
    }
    const named = async (name: string) =>
      (await db.select().from(clients)).find((client) => brandKey(client.name) === brandKey(name))!;

    const dry = await applyBrandContacts(db, { apply: false });
    expect(dry.changes.map((change) => change.client?.name)).toEqual([
      'Cenoritas',
      'Amarjon',
      'Iguari',
    ]);
    expect((await named('Cenoritas')).whatsapp).toBeNull();
    expect(formatBrandContactsReport(dry)).toMatch(/^SIMULAÇÃO/);

    const applied = await applyBrandContacts(db, { apply: true });
    expect(applied.changes[0]?.fields).toEqual(['instagram', 'whatsapp']);
    expect(await named('Cenoritas')).toMatchObject({
      whatsapp: '21972055989',
      whatsappNote: null,
      social: expect.objectContaining({ instagram: '@cenoritas.gourmet' }),
    });
    expect(await named('Amarjon')).toMatchObject({ whatsapp: '32988339012' });
    const iguari = await named('Iguari');
    expect(iguari.whatsapp).toBeNull();
    expect(iguari.whatsappNote).toMatch(/não tem WhatsApp próprio/);
    expect(iguari.social).toMatchObject({ instagram: '@iguaripasseioshopping' });

    const again = await applyBrandContacts(db, { apply: true });
    expect(again.changes.every((change) => change.fields.length === 0)).toBe(true);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'client.company_updated'));
    expect(audits).toHaveLength(3);
    expect(JSON.stringify(audits.map((row) => row.metadata))).not.toMatch(/\d{8}/);
  });
});
