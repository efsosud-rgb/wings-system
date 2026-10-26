import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  salesRanges,
  type Productivity,
  type RoleKey,
  type SectorSlug,
} from '@wings/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { crmDistributionMembers, crmMeetings, leadTasks } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { addActivity } from './activities.js';
import { addNote, changeLead, createStage, entryStageOf, updateTask } from './crm.js';
import { loadProductivityDw, productivityOf } from './productivity.js';
import { salesDashboardOf } from './sales-dashboard.js';
import { listLeads, upsertLead } from './service.js';

/**
 * The Produtividade tab (docs/crm/produtividade.md): the CRM's own records loaded
 * into `dw` and read back per person. Made-up people and deals only.
 */
let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

type Login = { id: string; cookies: Record<string, string> };
async function login(role: RoleKey, sector: SectorSlug): Promise<Login> {
  const employee = await createEmployee(db, { role, sector });
  const answer = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = answer.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

let ana: Login; // vendedor_formatacao
let bia: Login; // vendedor_expansao
let manager: Login;
let director: Login;
let admin: Login;
let marketing: Login;
let reuniaoStage: { id: string };

async function deal(owner: Login, pipeline: 'formatacao' | 'expansao', n: number) {
  const made = await upsertLead(db, {
    source: 'manual',
    name: `Negócio ${n} Teste`,
    email: `negocio${n}@teste.invalid`,
    phone: `55219777700${n}`,
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    pipeline,
    event: { kind: 'lead.created_manually', actorEmployeeId: admin.id },
  });
  // The rotation may already have picked the owner; the change is a no-op then.
  await changeLead(db, {
    leadId: made.lead.id,
    ownerEmployeeId: owner.id,
    source: 'wings',
    actorEmployeeId: admin.id,
  });
  const task = await db.query.leadTasks.findFirst({
    where: and(eq(leadTasks.leadId, made.lead.id), eq(leadTasks.kind, 'first_contact')),
  });
  if (!task) throw new Error('first-contact task missing in setup');
  return { id: made.lead.id, task };
}

const get = (url: string, who?: Login) =>
  app.inject({ method: 'GET', url, ...(who ? { cookies: who.cookies } : {}) });

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
  admin = await login('admin_master', 'diretoria');
  director = await login('diretoria', 'diretoria');
  manager = await login('gerente_comercial', 'comercial');
  ana = await login('vendedor_formatacao', 'comercial');
  bia = await login('vendedor_expansao', 'comercial');
  marketing = await login('marketing', 'marketing');
  await db.insert(crmDistributionMembers).values([
    { pipeline: 'formatacao', employeeId: ana.id, active: true },
    { pipeline: 'expansao', employeeId: bia.id, active: true },
  ]);
  await entryStageOf(db, 'formatacao');
  await entryStageOf(db, 'expansao');
  const made = await createStage(db, {
    pipeline: 'formatacao',
    name: 'Reunião',
    actorEmployeeId: admin.id,
  });
  if (made === 'exists') throw new Error('stage exists in setup');
  reuniaoStage = made;

  // Ana: five deals this month. 1 contacted at once (task done, a call, a note, a meeting held);
  // 2 contacted Friday 17h50 → Monday 9h50 (one working hour, on time); 3 moved to Reunião by her
  // (the move is the contact); 4 won without contact; 6 still waiting past the hour.
  const d1 = await deal(ana, 'formatacao', 1);
  await updateTask(db, { taskId: d1.task.id, done: true, actorEmployeeId: ana.id });
  await addActivity(db, {
    leadId: d1.id,
    actorEmployeeId: ana.id,
    kind: 'call',
    outcome: 'answered',
    durationSeconds: 90,
  });
  await addNote(db, {
    leadId: d1.id,
    body: 'Ligamos e ficou de retornar.',
    authorEmployeeId: ana.id,
  });
  await db.insert(crmMeetings).values({
    leadId: d1.id,
    ownerEmployeeId: ana.id,
    title: 'Reunião de apresentação',
    startsAt: new Date(),
    endsAt: new Date(Date.now() + 3_600_000),
    status: 'encerrada',
  });
  const d2 = await deal(ana, 'formatacao', 2);
  await db
    .update(leadTasks)
    .set({
      createdAt: new Date('2026-10-09T20:50:00Z'),
      dueAt: new Date('2026-10-12T12:50:00Z'),
      doneAt: new Date('2026-10-12T12:50:00Z'),
      doneBy: ana.id,
    })
    .where(eq(leadTasks.id, d2.task.id));
  const d3 = await deal(ana, 'formatacao', 3);
  await changeLead(db, {
    leadId: d3.id,
    stageId: reuniaoStage.id,
    source: 'wings',
    actorEmployeeId: ana.id,
  });
  const d4 = await deal(ana, 'formatacao', 4);
  await changeLead(db, { leadId: d4.id, won: true, source: 'wings', actorEmployeeId: ana.id });
  const d6 = await deal(ana, 'formatacao', 6);
  await db
    .update(leadTasks)
    .set({ dueAt: new Date(Date.now() - 3 * 3_600_000) })
    .where(eq(leadTasks.id, d6.task.id));
  // Bia: one Expansão deal, lost with a reason.
  const d5 = await deal(bia, 'expansao', 5);
  await changeLead(db, {
    leadId: d5.id,
    won: false,
    lostReason: 'Sem orçamento',
    source: 'wings',
    actorEmployeeId: bia.id,
  });
}, 90_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

describe('Produtividade', () => {
  it('answers "—" (loadedAt null) before the first load, then loads the model from the CRM', async () => {
    const before = await get('/crm/productivity', admin);
    expect(before.statusCode).toBe(200);
    expect(before.json<Productivity>().loadedAt).toBeNull();

    const result = await loadProductivityDw(db);
    expect(result).toMatchObject({ ran: true, negotiations: 6 });
    expect(result.activities).toBeGreaterThanOrEqual(5);
    expect(result.moves).toBe(1);
    // Run again: the same rows, no duplicates, one user version each.
    expect((await loadProductivityDw(db)).negotiations).toBe(6);
    const versions = await db.execute<{ n: string }>(
      sql`select count(*) as n from dw.dim_usuario where usuario_id = ${ana.id}`,
    );
    expect(Number(versions.rows[0]?.n)).toBe(1);
  });

  it("keeps no personal data in dw: the user's name stays null and no fact has a name, e-mail or phone column", async () => {
    const names = await db.execute<{ n: string }>(
      sql`select count(*) as n from dw.dim_usuario where usuario_sk <> 0 and nome is not null`,
    );
    expect(Number(names.rows[0]?.n)).toBe(0);
    const columns = await db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns
          where table_schema = 'dw' and table_name in ('fato_negociacao', 'fato_atividade', 'fato_movimentacao_etapa', 'dim_lead', 'dim_usuario')`,
    );
    // dim_usuario.nome exists but stays null (checked above); nothing else names a person.
    for (const { column_name } of columns.rows.filter((c) => c.column_name !== 'nome'))
      expect(column_name).not.toMatch(/nome|name|email|phone|telefone|cpf/);
  });

  it('counts by result, per person, and the totals of the month match the CRM screens', async () => {
    const month = salesRanges('month', new Date()).current;
    const data = await productivityOf(db, {
      period: 'month',
      pipeline: 'todos',
      actor: {
        employeeId: manager.id,
        role: 'gerente_comercial',
        sector: 'comercial',
        isSectorManager: false,
      },
    });
    const ofAna = data.people.find((p) => p.employeeId === ana.id)!;
    expect(ofAna).toMatchObject({
      received: 5,
      firstContact: { inTime: 3, decided: 4, medianMinutes: 0 },
      activities: {
        ligacao: 1,
        nota: 1,
        // Deal 1's task done on the screen and deal 2's done on Monday morning.
        tarefa: 2,
        reuniao_agendada: 1,
        reuniao_realizada: 1,
        mensagem: 0,
        email: 0,
      },
      stageAdvances: 1,
      won: 1,
      lost: 0,
      whatsappMedianMinutes: null,
    });
    const ofBia = data.people.find((p) => p.employeeId === bia.id)!;
    expect(ofBia).toMatchObject({ received: 1, firstContact: { inTime: 0, decided: 0 }, lost: 1 });
    expect(data.team).toMatchObject({ people: 3, received: 6, won: 1, lost: 1 });
    expect(data.team.firstContact).toMatchObject({ inTime: 3, decided: 4 });
    expect(data.lostReasons).toEqual([{ reason: 'sem orçamento', count: 1 }]);
    expect(data.unavailable.whatsapp).toContain('WhatsApp ainda fora do sistema');
    expect(data.loadedAt).not.toBeNull();

    // The Friday → Monday case, written to the snapshot as 60 working minutes, on time.
    const d2 = await db.execute<{ minutos: number; no_prazo: boolean }>(
      sql`select n.minutos_uteis_ate_primeiro_contato as minutos, n.primeiro_contato_no_prazo as no_prazo
          from dw.fato_negociacao n join leads l on l.id = n.negociacao_id::uuid where l.email = 'negocio2@teste.invalid'`,
    );
    expect(d2.rows[0]).toEqual({ minutos: 60, no_prazo: true });

    // The CRM's own screens: the Negociações list by "Entrou em", the sales panel's won and lost.
    const list = await listLeads(db, {
      createdFrom: month.from,
      createdTo: month.to,
      ownerEmployeeId: ana.id,
    });
    expect(list.total).toBe(ofAna.received);
    const panel = await salesDashboardOf(db, {
      period: 'month',
      pipeline: 'todos',
      spendVisible: false,
    });
    expect(panel.results.current.won).toBe(data.team.won);
    expect(panel.results.current.lost).toBe(data.team.lost);
  });

  it('with one funnel: the stages in order with how many received deals reached each', async () => {
    const data = await productivityOf(db, {
      period: 'month',
      pipeline: 'formatacao',
      actor: {
        employeeId: admin.id,
        role: 'admin_master',
        sector: 'diretoria',
        isSectorManager: false,
      },
    });
    expect(data.stages.map((s) => [s.name, s.reached])).toEqual([
      ['Sem contato', 5],
      ['Reunião', 1],
    ]);
    expect(data.people.find((p) => p.employeeId === bia.id)?.received).toBe(0);
  });

  it('shows each level its own view: seller = own row + team totals; manager = the sector; Diretoria and Admin = everyone; others 403; anonymous 401', async () => {
    const own = await get('/crm/productivity', ana);
    expect(own.statusCode).toBe(200);
    const mine = own.json<Productivity>();
    expect(mine.scope).toBe('own');
    expect(mine.people.map((p) => p.employeeId)).toEqual([ana.id]);
    expect(mine.team).toMatchObject({ people: 3, received: 6 });

    const sector = (await get('/crm/productivity', manager)).json<Productivity>();
    expect(sector.scope).toBe('sector');
    expect(sector.people.map((p) => p.employeeId).sort()).toEqual(
      [ana.id, bia.id, manager.id].sort(),
    );

    const all = (await get('/crm/productivity', director)).json<Productivity>();
    expect(all.scope).toBe('all');
    expect(all.people.map((p) => p.employeeId).sort()).toEqual(
      [ana.id, bia.id, manager.id, director.id].sort(),
    );
    const everyone = (await get('/crm/productivity', admin)).json<Productivity>();
    expect(everyone.people.map((p) => p.employeeId).sort()).toEqual(
      [ana.id, bia.id, manager.id, director.id].sort(),
    );

    const one = (
      await get(`/crm/productivity?owner=${ana.id}&pipeline=expansao`, manager)
    ).json<Productivity>();
    expect(one.people.map((p) => p.employeeId)).toEqual([ana.id]);
    expect(one.people[0]?.received).toBe(0);

    for (const answer of [mine, sector, all]) {
      const text = JSON.stringify(answer);
      expect(text).not.toContain('@');
      expect(text).not.toContain('5521977770');
    }
    expect((await get('/crm/productivity', marketing)).statusCode).toBe(403);
    expect((await get('/crm/productivity')).statusCode).toBe(401);
    expect((await get('/crm/productivity?period=custom&from=2026-10-10', admin)).statusCode).toBe(
      400,
    );
  });
});
