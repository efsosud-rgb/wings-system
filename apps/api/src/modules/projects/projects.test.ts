import {
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type ClientProject,
  type ProjectStatusChange,
  type RoleKey,
  type SectorSlug,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  auditLog,
  clientProjectStatusHistory,
  clientProjects,
  clients,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  clientRegister,
  createEmployee,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';

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

const SECTOR_OF: Partial<Record<RoleKey, SectorSlug>> = {
  admin_master: 'diretoria',
  diretoria: 'diretoria',
  rh_dp: 'diretoria',
  marketing: 'marketing',
  gerente_comercial: 'comercial',
  vendedor_expansao: 'comercial',
  formatacao_juridico: 'formatacao-juridico',
  formatacao_financeiro: 'formatacao-financeiro',
  formatacao_processos_projetos: 'formatacao-processos-projetos',
  formatacao_logistica: 'formatacao-logistica',
  formatacao_ti: 'formatacao-ti',
};

async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, { role, sector: SECTOR_OF[role] ?? 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

type Session = Awaited<ReturnType<typeof sessionFor>>;

async function registerClient(session: Session, name: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/clients',
    cookies: session.cookies,
    payload: clientRegister(name),
  });
  expect(created.statusCode).toBe(201);
  return created.json<{ client: { id: string; number: number } }>().client;
}

const getProject = async (session: Session, clientId: string) => {
  const answer = await app.inject({
    method: 'GET',
    url: `/projects/${clientId}`,
    cookies: session.cookies,
  });
  expect(answer.statusCode).toBe(200);
  return answer.json<{ project: ClientProject; history: ProjectStatusChange[] }>();
};

type Payload = Record<string, unknown>;

const setStage = (session: Session, clientId: string, slot: string, payload: Payload) =>
  app.inject({
    method: 'PATCH',
    url: `/projects/${clientId}/stages/${slot}`,
    cookies: session.cookies,
    payload,
  });

const setStatus = (session: Session, clientId: string, payload: Payload) =>
  app.inject({
    method: 'PATCH',
    url: `/projects/${clientId}/status`,
    cookies: session.cookies,
    payload,
  });

describe('a client project is born with the client', () => {
  it('opens Em Andamento at 01 with eight stages not started, and Wings Company has none', async () => {
    const admin = await sessionFor('admin_master');
    const client = await registerClient(admin, 'Padaria Aurora');

    const { project, history } = await getProject(admin, client.id);
    expect(project).toMatchObject({
      clientId: client.id,
      clientName: 'Padaria Aurora',
      clientNumber: client.number,
      clientActive: true,
      status: 'em_andamento',
      currentStage: '01',
      canManage: true,
    });
    expect(project.stages.map((stage) => [stage.slot, stage.progress, stage.department])).toEqual([
      ['01', 'nao_iniciada', 'imersao'],
      ['02', 'nao_iniciada', 'imersao'],
      ['03', 'nao_iniciada', 'imersao'],
      ['04', 'nao_iniciada', 'financeiro'],
      ['05', 'nao_iniciada', 'projetos'],
      ['06', 'nao_iniciada', 'juridico'],
      ['07', 'nao_iniciada', 'comercial'],
      ['08', 'nao_iniciada', 'marketing'],
    ]);
    expect(history).toEqual([]);

    const wings = await app.inject({
      method: 'GET',
      url: `/projects/${WINGS_CLIENT_ID}`,
      cookies: admin.cookies,
    });
    expect(wings.statusCode).toBe(404);
    const rows = await db
      .select()
      .from(clientProjects)
      .where(eq(clientProjects.clientId, WINGS_CLIENT_ID));
    expect(rows).toHaveLength(0);
  });

  it('is on the board for every reader, by client number, and the inactive leave it unless asked', async () => {
    const admin = await sessionFor('admin_master');
    const ti = await sessionFor('formatacao_ti');
    const kept = await registerClient(admin, 'Quadro Ativo');
    const gone = await registerClient(admin, 'Quadro Inativo');
    await app.inject({
      method: 'PATCH',
      url: `/clients/${gone.id}`,
      cookies: admin.cookies,
      payload: { active: false },
    });

    const board = await app.inject({ method: 'GET', url: '/projects', cookies: ti.cookies });
    expect(board.statusCode).toBe(200);
    const projects = board.json<{ projects: ClientProject[] }>().projects;
    const ids = projects.map((project) => project.clientId);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(gone.id);
    const numbers = projects.map((project) => project.clientNumber ?? 0);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    // TI reads only: nothing on the board is clickable for it.
    const row = projects.find((project) => project.clientId === kept.id)!;
    expect(row.canManage).toBe(false);
    expect(row.stages.every((stage) => stage.canEdit === false)).toBe(true);

    const withInactive = await app.inject({
      method: 'GET',
      url: '/projects?inactive=true',
      cookies: ti.cookies,
    });
    const all = withInactive.json<{ projects: ClientProject[] }>().projects;
    expect(all.find((project) => project.clientId === gone.id)).toMatchObject({
      clientActive: false,
      status: 'em_andamento',
    });

    const filtered = await app.inject({
      method: 'GET',
      url: '/projects?status=parado',
      cookies: ti.cookies,
    });
    expect(
      filtered.json<{ projects: ClientProject[] }>().projects.every((p) => p.status === 'parado'),
    ).toBe(true);
    expect(
      (await app.inject({ method: 'GET', url: '/projects?status=x', cookies: ti.cookies }))
        .statusCode,
    ).toBe(400);
  });
});

describe('the status', () => {
  it('needs a reason for Parado and Cancelado, is refused when unchanged, and lands in the history and the audit', async () => {
    const processos = await sessionFor('formatacao_processos_projetos');
    const admin = await sessionFor('admin_master');
    const client = await registerClient(admin, 'Status Cliente');

    const noReason = await setStatus(processos, client.id, { status: 'parado' });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().message).toMatch(/motivo/i);

    const paused = await setStatus(processos, client.id, {
      status: 'parado',
      reason: 'Aguardando o contrato assinado',
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json<{ project: ClientProject }>().project.status).toBe('parado');

    const again = await setStatus(processos, client.id, { status: 'parado', reason: 'De novo' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('same_status');

    const resumed = await setStatus(processos, client.id, { status: 'em_andamento' });
    expect(resumed.statusCode).toBe(200);

    const { history } = await getProject(processos, client.id);
    expect(history.map((change) => [change.fromStatus, change.toStatus, change.reason])).toEqual([
      ['parado', 'em_andamento', null],
      ['em_andamento', 'parado', 'Aguardando o contrato assinado'],
    ]);
    expect(history[0]?.changedByName).toBe('Funcionário de Teste');

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'project.status_changed'),
          eq(auditLog.actorEmployeeId, processos.employeeId),
        ),
      );
    expect(audits.map((entry) => entry.metadata)).toEqual([
      expect.objectContaining({ from: 'em_andamento', to: 'parado', withReason: true }),
      expect.objectContaining({ from: 'parado', to: 'em_andamento', withReason: false }),
    ]);
    // The reason itself stays in the history, never in the audit metadata.
    expect(JSON.stringify(audits.map((entry) => entry.metadata))).not.toContain(
      'contrato assinado',
    );
  });

  it('the history table refuses a Parado or Cancelado row without a reason, whoever writes it', async () => {
    const admin = await sessionFor('admin_master');
    const client = await registerClient(admin, 'Constraint Cliente');
    const [project] = await db
      .select()
      .from(clientProjects)
      .where(eq(clientProjects.clientId, client.id));
    await expect(
      db.insert(clientProjectStatusHistory).values({
        projectId: project!.id,
        fromStatus: 'em_andamento',
        toStatus: 'cancelado',
        reason: '   ',
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ constraint: 'client_project_status_history_reason_check' }),
    });
    await expect(
      db.insert(clientProjectStatusHistory).values({
        projectId: project!.id,
        fromStatus: 'em_andamento',
        toStatus: 'finalizado',
        reason: null,
      }),
    ).resolves.toBeDefined();
  });

  it('is set only by Admin Master, Diretoria and Processos e Projetos', async () => {
    const admin = await sessionFor('admin_master');
    const client = await registerClient(admin, 'Quem Muda Status');
    for (const role of ['marketing', 'formatacao_juridico', 'gerente_comercial'] as const) {
      const session = await sessionFor(role);
      const answer = await setStatus(session, client.id, { status: 'finalizado' });
      expect(answer.statusCode, role).toBe(403);
    }
    for (const role of ['formatacao_ti', 'rh_dp'] as const) {
      const session = await sessionFor(role);
      const answer = await setStatus(session, client.id, { status: 'finalizado' });
      expect(answer.statusCode, role).toBe(403);
      expect(answer.json().reason).toBe('no_permission');
    }
    const diretoria = await sessionFor('diretoria');
    expect((await setStatus(diretoria, client.id, { status: 'finalizado' })).statusCode).toBe(200);
  });
});

describe('the stages', () => {
  it('a department sets its own stage, is refused on another, and Processos e Projetos sets any', async () => {
    const admin = await sessionFor('admin_master');
    const client = await registerClient(admin, 'Etapas Cliente');
    const juridico = await sessionFor('formatacao_juridico');
    const financeiro = await sessionFor('formatacao_financeiro');
    const marketing = await sessionFor('marketing');
    const vendedor = await sessionFor('vendedor_expansao');
    const processos = await sessionFor('formatacao_processos_projetos');
    const logistica = await sessionFor('formatacao_logistica');

    expect(
      (await setStage(juridico, client.id, '06', { progress: 'em_andamento' })).statusCode,
    ).toBe(200);
    const onFour = await setStage(juridico, client.id, '04', { progress: 'em_andamento' });
    expect(onFour.statusCode).toBe(403);
    expect(onFour.json().error).toBe('stage_forbidden');
    expect(
      (await setStage(financeiro, client.id, '04', { progress: 'em_andamento' })).statusCode,
    ).toBe(200);
    expect(
      (await setStage(marketing, client.id, '08', { progress: 'em_andamento' })).statusCode,
    ).toBe(200);
    expect(
      (await setStage(marketing, client.id, '01', { progress: 'em_andamento' })).statusCode,
    ).toBe(403);
    expect(
      (await setStage(vendedor, client.id, '07', { progress: 'em_andamento' })).statusCode,
    ).toBe(200);
    expect(
      (await setStage(processos, client.id, '01', { progress: 'em_andamento' })).statusCode,
    ).toBe(200);
    expect(
      (await setStage(processos, client.id, '05', { progress: 'em_andamento' })).statusCode,
    ).toBe(200);
    const readOnly = await setStage(logistica, client.id, '05', { progress: 'em_andamento' });
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().reason).toBe('no_permission');
    expect(
      (await setStage(processos, client.id, '09', { progress: 'em_andamento' })).statusCode,
    ).toBe(404);

    const { project } = await getProject(juridico, client.id);
    expect(project.canManage).toBe(false);
    expect(project.stages.map((stage) => stage.canEdit)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    const six = project.stages.find((stage) => stage.slot === '06')!;
    expect(six).toMatchObject({ progress: 'em_andamento', updatedByName: 'Funcionário de Teste' });
    expect(six.startedAt).not.toBeNull();
    expect(six.completedAt).toBeNull();
  });

  it('a blocked stage says why; concluding the current stage advances the client; audited each time', async () => {
    const admin = await sessionFor('admin_master');
    const client = await registerClient(admin, 'Avanço Cliente');

    const blocked = await setStage(admin, client.id, '01', { progress: 'bloqueada' });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().message).toMatch(/bloqueia/);
    const withNote = await setStage(admin, client.id, '01', {
      progress: 'bloqueada',
      note: 'Falta o cartão CNPJ',
    });
    expect(withNote.statusCode).toBe(200);
    expect(withNote.json<{ project: ClientProject }>().project.stages[0]).toMatchObject({
      progress: 'bloqueada',
      note: 'Falta o cartão CNPJ',
    });

    // 02 is already done, so concluding 01 jumps the client to 03.
    expect((await setStage(admin, client.id, '02', { progress: 'concluida' })).statusCode).toBe(
      200,
    );
    const done = await setStage(admin, client.id, '01', { progress: 'concluida' });
    expect(done.statusCode).toBe(200);
    const advanced = done.json<{ project: ClientProject }>().project;
    expect(advanced.currentStage).toBe('03');
    expect(advanced.stages[0]).toMatchObject({ progress: 'concluida', note: null });
    expect(advanced.stages[0]?.completedAt).not.toBeNull();

    // Reopening a concluded stage clears its completion; concluding a stage
    // that is not the current one moves nothing.
    expect((await setStage(admin, client.id, '02', { progress: 'em_andamento' })).statusCode).toBe(
      200,
    );
    const eight = await setStage(admin, client.id, '08', { progress: 'concluida' });
    expect(eight.json<{ project: ClientProject }>().project.currentStage).toBe('03');
    const { project } = await getProject(admin, client.id);
    expect(project.stages[1]?.completedAt).toBeNull();

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, project.id));
    const actions = audits.map((entry) => entry.action);
    expect(actions.filter((action) => action === 'project.stage_changed')).toHaveLength(5);
    expect(
      audits.find((entry) => entry.action === 'project.current_stage_changed')?.metadata,
    ).toEqual(expect.objectContaining({ from: '01', to: '03', auto: true }));
    expect(JSON.stringify(audits.map((entry) => entry.metadata))).not.toContain('cartão CNPJ');
  });

  it('the current stage is chosen by hand, and a closed project freezes its stages until reopened', async () => {
    const admin = await sessionFor('admin_master');
    const juridico = await sessionFor('formatacao_juridico');
    const client = await registerClient(admin, 'Fechado Cliente');

    const moved = await app.inject({
      method: 'PATCH',
      url: `/projects/${client.id}/current-stage`,
      cookies: admin.cookies,
      payload: { stage: '06' },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<{ project: ClientProject }>().project.currentStage).toBe('06');
    const byJuridico = await app.inject({
      method: 'PATCH',
      url: `/projects/${client.id}/current-stage`,
      cookies: juridico.cookies,
      payload: { stage: '07' },
    });
    expect(byJuridico.statusCode).toBe(403);

    expect((await setStatus(admin, client.id, { status: 'finalizado' })).statusCode).toBe(200);
    const frozen = await setStage(juridico, client.id, '06', { progress: 'concluida' });
    expect(frozen.statusCode).toBe(409);
    expect(frozen.json().error).toBe('project_closed');
    const frozenMove = await app.inject({
      method: 'PATCH',
      url: `/projects/${client.id}/current-stage`,
      cookies: admin.cookies,
      payload: { stage: '07' },
    });
    expect(frozenMove.statusCode).toBe(409);
    // Another department's refusal stays "not yours", even on a closed project.
    expect((await setStage(juridico, client.id, '04', { progress: 'concluida' })).statusCode).toBe(
      403,
    );

    expect((await setStatus(admin, client.id, { status: 'em_andamento' })).statusCode).toBe(200);
    expect((await setStage(juridico, client.id, '06', { progress: 'concluida' })).statusCode).toBe(
      200,
    );
    const { project } = await getProject(admin, client.id);
    expect(project.currentStage).toBe('07');
  });

  it('a client registered before the module still gets a project on the next registration sync', async () => {
    // A client inserted straight into the table, as the backfill of 0032 finds them.
    const [orphan] = await db
      .insert(clients)
      .values({ name: 'Cliente Antigo', slug: 'cliente-antigo', number: 9001 })
      .returning();
    const admin = await sessionFor('admin_master');
    const missing = await app.inject({
      method: 'GET',
      url: `/projects/${orphan!.id}`,
      cookies: admin.cookies,
    });
    expect(missing.statusCode).toBe(404);
    const { openProjectForClient } = await import('./service.js');
    await openProjectForClient(db, orphan!.id);
    await openProjectForClient(db, orphan!.id);
    const { project } = await getProject(admin, orphan!.id);
    expect(project.stages).toHaveLength(8);
  });
});
