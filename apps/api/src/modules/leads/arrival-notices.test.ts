import { readFileSync } from 'node:fs';
import { WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  crmDistributionMembers,
  crmNotifications,
  leadTasks,
} from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { setDistribution } from './crm.js';
import { upsertLead } from './service.js';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const arrive = (input: {
  source?: 'meta_lead_ads' | 'rd_station' | 'site_form' | 'rd_crm';
  phone: string;
  pipeline?: 'formatacao' | 'consultoria';
  importBatchId?: string;
}) =>
  upsertLead(db, {
    source: input.source ?? 'site_form',
    name: 'Pessoa de Teste',
    phone: input.phone,
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    pipeline: input.pipeline ?? 'formatacao',
    skipResearch: true,
    importBatchId: input.importBatchId ?? null,
    event: { kind: 'lead.received.site_form' },
  });

const noticesOf = (leadId: string) =>
  db.select().from(crmNotifications).where(eq(crmNotifications.leadId, leadId));

describe('arrival notices', () => {
  it('tells the owner given by the rotation, with the first-contact deadline, once', async () => {
    const owner = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    await setDistribution(db, {
      pipeline: 'formatacao',
      members: [{ employeeId: owner.id, active: true }],
      actorEmployeeId: owner.id,
    });
    for (const source of ['meta_lead_ads', 'rd_station', 'site_form'] as const) {
      const born = await arrive({ source, phone: `55119000${source.length}001` });
      expect(born.lead.ownerEmployeeId).toBe(owner.id);
      const notices = await noticesOf(born.lead.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ recipientEmployeeId: owner.id, kind: 'new_lead' });
      expect(notices[0]?.message).toContain('1 hora útil');
      expect(notices[0]?.message).not.toContain('Pessoa');
    }
    const born = await arrive({ phone: '5511900009999' });
    const task = await db.query.leadTasks.findFirst({
      where: and(eq(leadTasks.leadId, born.lead.id), eq(leadTasks.kind, 'first_contact')),
    });
    expect(task).toBeTruthy();
    // The same person arriving again is a merge, not a new lead: no second notice.
    const again = await arrive({ phone: '5511900009999' });
    expect(again.created).toBe(false);
    expect(await noticesOf(born.lead.id)).toHaveLength(1);
  });

  it('with an empty rotation, Diretoria and the commercial managers are told at once; sellers are not', async () => {
    const board = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const manager = await createEmployee(db, {
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
    });
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const gone = await createEmployee(db, {
      role: 'diretoria',
      sector: 'diretoria',
      status: 'inactive',
    });
    const born = await arrive({ phone: '5511900008888', pipeline: 'consultoria' });
    expect(born.lead.ownerEmployeeId).toBeNull();
    const notices = await noticesOf(born.lead.id);
    const who = new Set(notices.map((n) => n.recipientEmployeeId));
    expect(who.has(board.id)).toBe(true);
    expect(who.has(manager.id)).toBe(true);
    expect(who.has(seller.id)).toBe(false);
    expect(who.has(gone.id)).toBe(false);
    expect(notices.every((n) => n.kind === 'lead_unassigned')).toBe(true);
    expect(notices.some((n) => n.message.includes('Pessoa'))).toBe(false);
    expect(await db.$count(leadTasks, eq(leadTasks.leadId, born.lead.id))).toBe(0);
  });

  it('an import and the RD mirror make no arrival notice', async () => {
    const imported = await arrive({
      phone: '5511900007001',
      importBatchId: crypto.randomUUID(),
    }).catch(() => null);
    const mirrored = await arrive({
      source: 'rd_crm',
      phone: '5511900007002',
      pipeline: 'consultoria',
    });
    expect(mirrored.created).toBe(true);
    expect(await noticesOf(mirrored.lead.id)).toHaveLength(0);
    if (imported) expect(await noticesOf(imported.lead.id)).toHaveLength(0);
  });
});

describe('migration 0069: the vendedor_formatacao people in the Formatação rotation', () => {
  const file = readFileSync(
    new URL('../../../migrations/0069_crm_rotation_formatacao_diretoria.sql', import.meta.url),
    'utf8',
  );
  const run = () => db.execute(sql.raw(file));
  const members = () =>
    db
      .select()
      .from(crmDistributionMembers)
      .where(eq(crmDistributionMembers.pipeline, 'formatacao'));
  const clear = () =>
    db.delete(crmDistributionMembers).where(eq(crmDistributionMembers.pipeline, 'formatacao'));

  it('does not fail when nobody has the role, and leaves the rotation empty', async () => {
    await clear();
    await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    await run();
    expect(await members()).toHaveLength(0);
  });

  it('adds the active vendedor_formatacao (not Diretoria, not other sellers, not inactive), once', async () => {
    await clear();
    const daniela = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    await createEmployee(db, {
      role: 'vendedor_formatacao',
      sector: 'comercial',
      status: 'inactive',
    });
    await createEmployee(db, { role: 'gerente_comercial', sector: 'comercial' });
    await run();
    expect((await members()).map((m) => m.employeeId)).toEqual([daniela.id]);
    expect((await members())[0]?.active).toBe(true);
    await run();
    expect(await members()).toHaveLength(1);
  });

  it('never touches a rotation that already has someone', async () => {
    const someone = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    await clear();
    await db
      .insert(crmDistributionMembers)
      .values({ pipeline: 'formatacao', employeeId: someone.id, active: false });
    await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    await run();
    const rows = await members();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ employeeId: someone.id, active: false });
  });
});
