import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { auditLog, clientProjects, clients, leadSourceRules } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  brandKey,
  EXPANSION_BRANDS,
  formatBrandReport,
  identifierKey,
  registerBrands,
} from './brands.js';

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
    expect(report.links.every((link) => link.state === 'linked')).toBe(true);
    expect(await db.select().from(clients)).toHaveLength(before.length);
    expect(formatBrandReport(report)).toContain('SIMULAÇÃO');
  });

  it('registers the missing brands with number and project, ties every seeded rule, and is safe to rerun', async () => {
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
    expect(
      await db.query.clientProjects.findFirst({ where: eq(clientProjects.clientId, casal!.id) }),
    ).toBeTruthy();
    const rule = await db.query.leadSourceRules.findFirst({
      where: eq(leadSourceRules.pattern, 'casal-do-churros'),
    });
    expect(rule?.clientId).toBe(casal!.id);
    expect(existing).toBeTruthy();
    expect(
      (await db.query.auditLog.findMany({ where: eq(auditLog.action, 'lead_source_rule.linked') }))
        .length,
    ).toBe(9);

    const again = await registerBrands(db, { names: EXPANSION_BRANDS, apply: true });
    expect(again.created).toHaveLength(0);
    expect(again.links.filter((link) => link.state === 'linked')).toHaveLength(0);
  });
});
