import { readFileSync } from 'node:fs';
import { WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import {
  crmDistributionMembers,
  crmNotifications,
  employees,
  leadTasks,
  roles,
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
    // The same person arriving again is a merge, not a new lead: no second arrival notice. Through
    // the site form the owner is told of the return instead (site-form-again.test.ts).
    const again = await arrive({ phone: '5511900009999' });
    expect(again.created).toBe(false);
    const kinds = (await noticesOf(born.lead.id)).map((notice) => notice.kind).sort();
    expect(kinds).toEqual(['lead_returned', 'new_lead']);
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

  it('Admin Master also hears of a lead with no owner, so the notice never has nobody to receive it', async () => {
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const born = await arrive({ phone: '5511900005555', pipeline: 'consultoria' });
    expect(born.lead.ownerEmployeeId).toBeNull();
    const notices = await noticesOf(born.lead.id);
    expect(
      notices.some((n) => n.recipientEmployeeId === admin.id && n.kind === 'lead_unassigned'),
    ).toBe(true);
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

describe('migration 0070: Formatação rotation = active vendedor_formatacao only', () => {
  const file = readFileSync(
    new URL('../../../migrations/0070_crm_rotation_formatacao_vendedoras.sql', import.meta.url),
    'utf8',
  );
  const run = () => db.execute(sql.raw(file));
  const members = (pipeline = 'formatacao') =>
    db.select().from(crmDistributionMembers).where(eq(crmDistributionMembers.pipeline, pipeline));
  const clear = (pipeline = 'formatacao') =>
    db.delete(crmDistributionMembers).where(eq(crmDistributionMembers.pipeline, pipeline));
  const put = (pipeline: string, employeeId: string, active = true) =>
    db.insert(crmDistributionMembers).values({ pipeline, employeeId, active });

  it('removes who has no vendedor_formatacao role (Thais as Diretoria), adds who has it, once', async () => {
    await clear();
    const thais = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const daniela = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    const paused = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    await createEmployee(db, {
      role: 'vendedor_formatacao',
      sector: 'comercial',
      status: 'inactive',
    });
    await put('formatacao', thais.id);
    await put('formatacao', paused.id, false);
    await run();
    const rows = await members();
    expect(rows.map((m) => m.employeeId).sort()).toEqual([daniela.id, paused.id].sort());
    expect(rows.find((m) => m.employeeId === paused.id)?.active).toBe(false);
    expect(rows.find((m) => m.employeeId === daniela.id)?.active).toBe(true);
    await run();
    expect(await members()).toHaveLength(2);
  });

  it('removes a deactivated seller too, and leaves Expansão and Consultoria untouched', async () => {
    await clear();
    await clear('expansao');
    await clear('consultoria');
    const gone = await createEmployee(db, {
      role: 'vendedor_formatacao',
      sector: 'comercial',
      status: 'inactive',
    });
    const fernando = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const boss = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    await put('formatacao', gone.id);
    await put('expansao', fernando.id);
    await put('consultoria', boss.id);
    await run();
    expect((await members()).map((m) => m.employeeId)).not.toContain(gone.id);
    expect((await members('expansao')).map((m) => m.employeeId)).toEqual([fernando.id]);
    expect((await members('consultoria')).map((m) => m.employeeId)).toEqual([boss.id]);
  });

  it('with nobody holding the role the rotation ends up empty without failing, and a new Formatação lead warns Diretoria', async () => {
    await clear();
    await db
      .update(employees)
      .set({ status: 'inactive', deactivatedAt: new Date() })
      .where(
        inArray(
          employees.roleId,
          db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'vendedor_formatacao')),
        ),
      );
    await run();
    expect(await members()).toHaveLength(0);
    const board = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const born = await arrive({ phone: '5511900006666', pipeline: 'formatacao' });
    expect(born.lead.ownerEmployeeId).toBeNull();
    const warned = await noticesOf(born.lead.id);
    expect(
      warned.some((n) => n.recipientEmployeeId === board.id && n.kind === 'lead_unassigned'),
    ).toBe(true);
  });
});
