import {
  addBusinessHours,
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type Board,
  type CrmStage,
  type Lead,
  type LeadTask,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leadEvents, leadStageHistory, leadTasks, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { LoadedLead } from './service.js';
import { upsertLead } from './service.js';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
    }),
    db,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

type Role = 'admin_master' | 'gerente_comercial' | 'vendedor_expansao' | 'vendedor_formatacao';
async function sessionFor(role: Role) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

let manager: Awaited<ReturnType<typeof sessionFor>>;
let sellerA: Awaited<ReturnType<typeof sessionFor>>;
let sellerB: Awaited<ReturnType<typeof sessionFor>>;
const stages: Record<string, CrmStage> = {};

/** A lead arriving from a site form of the Expansão funnel, with no owner: the rotation decides. */
const arrive = (phone: string, name: string) =>
  upsertLead(db, {
    source: 'site_form',
    name,
    phone,
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    pipeline: 'expansao',
    brand: 'Marca Teste',
    skipResearch: true,
    event: { kind: 'lead.received.site_form' },
  });

describe('stages (Administração → CRM)', () => {
  it('lets the manager build the funnel: create, rename, reorder, retire; a seller only reads', async () => {
    manager = await sessionFor('gerente_comercial');
    sellerA = await sessionFor('vendedor_expansao');
    sellerB = await sessionFor('vendedor_expansao');
    for (const name of ['Novo Contato', 'Tentando contato', 'Reunião agendada']) {
      const created = await app.inject({
        method: 'POST',
        url: '/crm/stages',
        cookies: manager.cookies,
        payload: { pipeline: 'expansao', name },
      });
      expect(created.statusCode).toBe(201);
      stages[name] = created.json<{ stage: CrmStage }>().stage;
    }
    expect(stages['Reunião agendada']?.position).toBe(3);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/crm/stages',
      cookies: manager.cookies,
      payload: { pipeline: 'expansao', name: 'Novo Contato' },
    });
    expect(duplicate.statusCode).toBe(409);
    const bySeller = await app.inject({
      method: 'POST',
      url: '/crm/stages',
      cookies: sellerA.cookies,
      payload: { pipeline: 'expansao', name: 'Minha etapa' },
    });
    expect(bySeller.statusCode).toBe(403);

    // Insert "Proposta" before "Reunião agendada", then move it last.
    const inserted = await app.inject({
      method: 'POST',
      url: '/crm/stages',
      cookies: manager.cookies,
      payload: { pipeline: 'expansao', name: 'Proposta', position: 3 },
    });
    stages.Proposta = inserted.json<{ stage: CrmStage }>().stage;
    let list = await app.inject({
      method: 'GET',
      url: '/crm/stages?pipeline=expansao',
      cookies: sellerA.cookies,
    });
    expect(list.json<{ stages: CrmStage[] }>().stages.map((s) => s.name)).toEqual([
      'Novo Contato',
      'Tentando contato',
      'Proposta',
      'Reunião agendada',
    ]);
    const reordered = await app.inject({
      method: 'PUT',
      url: '/crm/stages/order',
      cookies: manager.cookies,
      payload: {
        pipeline: 'expansao',
        ids: [
          stages['Novo Contato']?.id,
          stages['Tentando contato']?.id,
          stages['Reunião agendada']?.id,
          stages.Proposta?.id,
        ],
      },
    });
    expect(reordered.statusCode).toBe(200);
    const incomplete = await app.inject({
      method: 'PUT',
      url: '/crm/stages/order',
      cookies: manager.cookies,
      payload: { pipeline: 'expansao', ids: [stages['Novo Contato']?.id] },
    });
    expect(incomplete.statusCode).toBe(400);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/crm/stages/${stages.Proposta?.id}`,
      cookies: manager.cookies,
      payload: { name: 'Proposta enviada' },
    });
    expect(renamed.json<{ stage: CrmStage }>().stage).toMatchObject({
      name: 'Proposta enviada',
      position: 4,
    });
    const retired = await app.inject({
      method: 'PATCH',
      url: `/crm/stages/${stages.Proposta?.id}`,
      cookies: manager.cookies,
      payload: { active: false },
    });
    expect(retired.json<{ stage: CrmStage }>().stage.active).toBe(false);
    list = await app.inject({
      method: 'GET',
      url: '/crm/stages?pipeline=expansao',
      cookies: sellerA.cookies,
    });
    expect(list.json<{ stages: CrmStage[] }>().stages.filter((s) => s.active)).toHaveLength(3);
  });
});

describe('the rotation and the first-contact task', () => {
  it('takes sellers, the sales manager and Diretoria as owners and rotation members, never Admin Master', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' });
    const salesManager = await createEmployee(db, {
      role: 'gerente_comercial',
      sector: 'comercial',
    });
    const board = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const listed = await app.inject({
      method: 'GET',
      url: '/crm/sellers',
      cookies: manager.cookies,
    });
    expect(listed.statusCode).toBe(200);
    const ids = listed.json<{ sellers: { id: string }[] }>().sellers.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([seller.id, salesManager.id, board.id]));
    expect(ids).not.toContain(admin.id);

    const members = [seller.id, salesManager.id, board.id].map((employeeId) => ({
      employeeId,
      active: true,
    }));
    const set = await app.inject({
      method: 'PUT',
      url: '/crm/distribution',
      cookies: manager.cookies,
      payload: { pipeline: 'formatacao', members },
    });
    expect(set.statusCode).toBe(200);
    const refused = await app.inject({
      method: 'PUT',
      url: '/crm/distribution',
      cookies: manager.cookies,
      payload: {
        pipeline: 'formatacao',
        members: [...members, { employeeId: admin.id, active: true }],
      },
    });
    expect(refused.statusCode).toBe(400);
    // Leave the Formatação rotation as the other tests expect it: empty.
    await app.inject({
      method: 'PUT',
      url: '/crm/distribution',
      cookies: manager.cookies,
      payload: { pipeline: 'formatacao', members: [] },
    });
  });

  it('hands new leads to the active sellers in turn, each with a first-contact task; a paused one gets none', async () => {
    const set = await app.inject({
      method: 'PUT',
      url: '/crm/distribution',
      cookies: manager.cookies,
      payload: {
        pipeline: 'expansao',
        members: [
          { employeeId: sellerA.employeeId, active: true },
          { employeeId: sellerB.employeeId, active: true },
        ],
      },
    });
    expect(set.statusCode).toBe(200);
    const first = await arrive('5511911110001', 'Lead Um');
    const second = await arrive('5511911110002', 'Lead Dois');
    const third = await arrive('5511911110003', 'Lead Três');
    const owners = [first, second, third].map((r) => r.lead.ownerEmployeeId);
    expect(new Set(owners.slice(0, 2))).toEqual(new Set([sellerA.employeeId, sellerB.employeeId]));
    expect(owners[2]).toBe(owners[0]);
    // Born in the funnel's entry stage, run from here.
    expect(first.lead).toMatchObject({ stage: 'Novo Contato', stageOrder: 1, managedBy: 'wings' });
    const tasks = await db.select().from(leadTasks).where(eq(leadTasks.leadId, first.lead.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      kind: 'first_contact',
      auto: true,
      assigneeEmployeeId: first.lead.ownerEmployeeId,
    });
    // One working hour (Mon–Fri 9h–18h São Paulo): the same instant the shared helper gives.
    expect(tasks[0]!.dueAt).toEqual(addBusinessHours(tasks[0]!.createdAt, 1));
    expect(tasks[0]!.dueAt.getTime()).toBeGreaterThan(tasks[0]!.createdAt.getTime());

    // Pause B: the next two go to A.
    await app.inject({
      method: 'PUT',
      url: '/crm/distribution',
      cookies: manager.cookies,
      payload: {
        pipeline: 'expansao',
        members: [
          { employeeId: sellerA.employeeId, active: true },
          { employeeId: sellerB.employeeId, active: false },
        ],
      },
    });
    const fourth = await arrive('5511911110004', 'Lead Quatro');
    const fifth = await arrive('5511911110005', 'Lead Cinco');
    expect(fourth.lead.ownerEmployeeId).toBe(sellerA.employeeId);
    expect(fifth.lead.ownerEmployeeId).toBe(sellerA.employeeId);
    const shown = await app.inject({
      method: 'GET',
      url: '/crm/distribution',
      cookies: manager.cookies,
    });
    const expansao = shown
      .json<{
        distributions: {
          pipeline: string;
          members: { employeeId: string; active: boolean; openLeads: number }[];
        }[];
      }>()
      .distributions.find((d) => d.pipeline === 'expansao');
    expect(
      expansao?.members.find((m) => m.employeeId === sellerA.employeeId)?.openLeads,
    ).toBeGreaterThanOrEqual(3);
    // Only sales roles may be members.
    const admin = await sessionFor('admin_master');
    const refused = await app.inject({
      method: 'PUT',
      url: '/crm/distribution',
      cookies: manager.cookies,
      payload: { pipeline: 'expansao', members: [{ employeeId: admin.employeeId, active: true }] },
    });
    expect(refused.statusCode).toBe(400);
  });
});

describe('PATCH /leads/:id — stage, outcome and owner', () => {
  let ownLead: string;
  let otherLead: string;

  it('moves a seller’s own lead with an append-only history, and hides another seller’s lead', async () => {
    const mine = await db.query.leads.findFirst({
      where: eq(leads.ownerEmployeeId, sellerA.employeeId),
    });
    const theirs = await db.query.leads.findFirst({
      where: eq(leads.ownerEmployeeId, sellerB.employeeId),
    });
    ownLead = mine!.id;
    otherLead = theirs!.id;
    const moved = await app.inject({
      method: 'PATCH',
      url: `/leads/${ownLead}`,
      cookies: sellerA.cookies,
      payload: { stageId: stages['Tentando contato']?.id },
    });
    expect(moved.statusCode).toBe(200);
    const body = moved.json<LoadedLead>();
    expect(body.lead.work).toMatchObject({
      stage: 'Tentando contato',
      won: null,
      managedBy: 'wings',
    });
    expect(body.history[0]).toMatchObject({
      fromStage: 'Novo Contato',
      toStage: 'Tentando contato',
      source: 'wings',
    });
    expect(body.events.some((e) => e.kind === 'lead.stage_changed')).toBe(true);

    const hidden = await app.inject({
      method: 'PATCH',
      url: `/leads/${otherLead}`,
      cookies: sellerA.cookies,
      payload: { stageId: stages['Tentando contato']?.id },
    });
    expect(hidden.statusCode).toBe(404);
    const retiredStage = await app.inject({
      method: 'PATCH',
      url: `/leads/${ownLead}`,
      cookies: sellerA.cookies,
      payload: { stageId: stages.Proposta?.id },
    });
    expect(retiredStage.statusCode).toBe(400);
    expect(retiredStage.json<{ error: string }>().error).toBe('stage_inactive');
  });

  it('closes as lost with a reason, reopens, and wins; closing finishes the open tasks', async () => {
    const noReason = await app.inject({
      method: 'PATCH',
      url: `/leads/${ownLead}`,
      cookies: sellerA.cookies,
      payload: { won: false },
    });
    expect(noReason.statusCode).toBe(400);
    // An open task and a done one: closing the deal finishes the open one and leaves the other alone.
    const pending = await app.inject({
      method: 'POST',
      url: `/leads/${ownLead}/tasks`,
      cookies: sellerA.cookies,
      payload: { title: 'Ligar de novo', dueAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(pending.statusCode).toBe(201);
    const pendingId = pending.json<{ task: { id: string } }>().task.id;
    const [done] = await db
      .insert(leadTasks)
      .values({
        leadId: ownLead,
        title: 'Já feita',
        dueAt: new Date('2026-10-01T12:00:00Z'),
        doneAt: new Date('2026-10-01T13:00:00Z'),
        assigneeEmployeeId: sellerA.employeeId,
      })
      .returning({ id: leadTasks.id });
    const lost = await app.inject({
      method: 'PATCH',
      url: `/leads/${ownLead}`,
      cookies: sellerA.cookies,
      payload: { won: false, lostReason: 'Sem capital' },
    });
    expect(lost.json<LoadedLead>().lead.work).toMatchObject({
      won: false,
      lostReason: 'Sem capital',
    });
    const tasks = await db.select().from(leadTasks).where(eq(leadTasks.leadId, ownLead));
    const closed = tasks.find((t) => t.id === pendingId);
    expect(closed?.doneAt).not.toBeNull();
    expect(closed?.doneBy).toBe(sellerA.employeeId);
    expect(tasks.find((t) => t.id === done!.id)?.doneAt?.toISOString()).toBe(
      '2026-10-01T13:00:00.000Z',
    );
    expect(tasks.every((t) => t.doneAt !== null)).toBe(true);
    // One "task done" event per task the closing finished (the first-contact task among them), none
    // for the one already done.
    const closedEvents = await db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, ownLead), eq(leadEvents.kind, 'lead.task_done')));
    expect(closedEvents).toHaveLength(tasks.length - 1);
    expect(closedEvents.map((e) => e.detail)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: pendingId, closedWithDeal: true }),
      ]),
    );
    const reopened = await app.inject({
      method: 'PATCH',
      url: `/leads/${ownLead}`,
      cookies: sellerA.cookies,
      payload: { won: null },
    });
    expect(reopened.json<LoadedLead>().lead.work).toMatchObject({
      won: null,
      lostReason: null,
      closedAt: null,
    });
    const won = await app.inject({
      method: 'PATCH',
      url: `/leads/${ownLead}`,
      cookies: sellerA.cookies,
      payload: { won: true },
    });
    expect(won.json<LoadedLead>().lead.work.won).toBe(true);
    const history = await db
      .select()
      .from(leadStageHistory)
      .where(eq(leadStageHistory.leadId, ownLead));
    expect(history.map((h) => h.won)).toEqual([null, false, null, true]);
  });

  it('lets only leads.assign hand a lead to someone else; the first-contact task follows the owner', async () => {
    const bySeller = await app.inject({
      method: 'PATCH',
      url: `/leads/${otherLead}`,
      cookies: sellerB.cookies,
      payload: { ownerEmployeeId: sellerA.employeeId },
    });
    expect(bySeller.statusCode).toBe(403);
    const byManager = await app.inject({
      method: 'PATCH',
      url: `/leads/${otherLead}`,
      cookies: manager.cookies,
      payload: { ownerEmployeeId: sellerA.employeeId },
    });
    expect(byManager.statusCode).toBe(200);
    expect(byManager.json<LoadedLead>().lead.ownerEmployeeId).toBe(sellerA.employeeId);
    const open = (await db.select().from(leadTasks).where(eq(leadTasks.leadId, otherLead))).filter(
      (t) => !t.doneAt,
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.assigneeEmployeeId).toBe(sellerA.employeeId);
    // Now B cannot see it any more; A can.
    const gone = await app.inject({
      method: 'GET',
      url: `/leads/${otherLead}`,
      cookies: sellerB.cookies,
    });
    expect(gone.statusCode).toBe(404);
    const seen = await app.inject({
      method: 'GET',
      url: `/leads/${otherLead}`,
      cookies: sellerA.cookies,
    });
    expect(seen.statusCode).toBe(200);
  });
});

describe('notes and tasks', () => {
  it('keeps notes on the lead only, and tasks with done/overdue for the seller’s list', async () => {
    const lead = await db.query.leads.findFirst({
      where: eq(leads.ownerEmployeeId, sellerA.employeeId),
    });
    const note = await app.inject({
      method: 'POST',
      url: `/leads/${lead!.id}/notes`,
      cookies: sellerA.cookies,
      payload: { body: 'Ligou às 10h, pediu a COF por e-mail.' },
    });
    expect(note.statusCode).toBe(201);
    const detail = await app.inject({
      method: 'GET',
      url: `/leads/${lead!.id}`,
      cookies: sellerA.cookies,
    });
    const loaded = detail.json<LoadedLead>();
    expect(loaded.notes[0]?.body).toBe('Ligou às 10h, pediu a COF por e-mail.');
    // The note's text is not in the timeline event.
    expect(JSON.stringify(loaded.events)).not.toContain('COF');

    const due = new Date(Date.now() - 3_600_000).toISOString();
    const task = await app.inject({
      method: 'POST',
      url: `/leads/${lead!.id}/tasks`,
      cookies: sellerA.cookies,
      payload: { kind: 'call', title: 'Retornar ligação', dueAt: due },
    });
    expect(task.statusCode).toBe(201);
    const taskId = task.json<{ task: LeadTask }>().task.id;
    const overdue = await app.inject({
      method: 'GET',
      url: '/crm/tasks?status=overdue',
      cookies: sellerA.cookies,
    });
    expect(overdue.json<{ tasks: LeadTask[] }>().tasks.some((t) => t.id === taskId)).toBe(true);
    // Another seller's list does not have it.
    const others = await app.inject({
      method: 'GET',
      url: '/crm/tasks?status=all',
      cookies: sellerB.cookies,
    });
    expect(others.json<{ tasks: LeadTask[] }>().tasks.some((t) => t.id === taskId)).toBe(false);
    // The manager asks for everyone's.
    const everyone = await app.inject({
      method: 'GET',
      url: '/crm/tasks?status=all&everyone=true',
      cookies: manager.cookies,
    });
    expect(everyone.json<{ tasks: LeadTask[] }>().tasks.some((t) => t.id === taskId)).toBe(true);

    const done = await app.inject({
      method: 'PATCH',
      url: `/leads/${lead!.id}/tasks/${taskId}`,
      cookies: sellerA.cookies,
      payload: { done: true },
    });
    expect(done.json<{ task: LeadTask }>().task.doneAt).not.toBeNull();
    const open = await app.inject({ method: 'GET', url: '/crm/tasks', cookies: sellerA.cookies });
    expect(open.json<{ tasks: LeadTask[] }>().tasks.some((t) => t.id === taskId)).toBe(false);
  });
});

describe('the kanban', () => {
  it('groups open leads by stage, in the caller’s scope', async () => {
    const all = await app.inject({
      method: 'GET',
      url: '/leads/board?pipeline=expansao',
      cookies: manager.cookies,
    });
    expect(all.statusCode).toBe(200);
    const board = all.json<Board>();
    const names = board.columns.map((c) => c.stage?.name ?? '(sem etapa)');
    expect(names).toEqual(['Novo Contato', 'Tentando contato', 'Reunião agendada']);
    const total = board.columns.reduce((sum, c) => sum + c.total, 0);
    const openLeads = await db.select().from(leads).where(eq(leads.pipeline, 'expansao'));
    expect(total).toBe(openLeads.filter((l) => l.won === null).length);
    const mine = await app.inject({
      method: 'GET',
      url: '/leads/board?pipeline=expansao',
      cookies: sellerB.cookies,
    });
    const mineTotal = mine.json<Board>().columns.reduce((sum, c) => sum + c.total, 0);
    expect(mineTotal).toBe(
      openLeads.filter((l) => l.won === null && l.ownerEmployeeId === sellerB.employeeId).length,
    );
    const noPipeline = await app.inject({
      method: 'GET',
      url: '/leads/board',
      cookies: manager.cookies,
    });
    expect(noPipeline.statusCode).toBe(400);
    const lead = await app.inject({
      method: 'GET',
      url: `/leads/${board.columns[0]?.cards[0]?.id}`,
      cookies: manager.cookies,
    });
    expect(lead.json<{ lead: Lead }>().lead.work.stage).toBe('Novo Contato');
  });
});
