import { SESSION_COOKIE, type MeetingListItem, type RoleKey } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { crmMeetings, employees, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

/** GET /meetings (Produtividade → Reuniões, Eric 19/10): the meetings of the deals in reach. */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const NOW = new Date('2026-10-19T15:00:00Z');

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
    now: () => NOW,
    mailer: { enabled: true, send: async () => {} },
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function person(role: RoleKey, fullName: string) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'diretoria' || role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  await db.update(employees).set({ fullName }).where(eq(employees.id, employee.id));
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

async function deal(ownerId: string | null) {
  const [row] = await db
    .insert(leads)
    .values({
      source: 'manual',
      name: 'Candidato Exemplo',
      email: 'candidato@exemplo.com.br',
      ownerEmployeeId: ownerId,
      pipeline: 'formatacao',
      stage: 'Diagnóstico',
    })
    .returning({ id: leads.id });
  return row!.id;
}

/** `at` is a UTC instant; every meeting lasts an hour. */
async function meeting(
  leadId: string,
  scheduledBy: string,
  title: string,
  at: string,
  status = 'agendada',
) {
  const startsAt = new Date(at);
  await db.insert(crmMeetings).values({
    leadId,
    ownerEmployeeId: scheduledBy,
    title,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
    status,
  });
}

async function list(cookies: Record<string, string> | undefined, query = '') {
  return app.inject({ method: 'GET', url: `/meetings${query}`, cookies });
}

const titlesOf = (res: { json: () => unknown }) =>
  (res.json() as { meetings: MeetingListItem[] }).meetings.map((m) => m.title);

let ana: Awaited<ReturnType<typeof person>>;
let bruno: Awaited<ReturnType<typeof person>>;
let admin: Awaited<ReturnType<typeof person>>;

describe('GET /meetings', () => {
  beforeAll(async () => {
    ana = await person('vendedor_expansao', 'Ana Vendedora');
    bruno = await person('vendedor_formatacao', 'Bruno Vendedor');
    admin = await person('admin_master', 'Admin Exemplo');
    const dealAna = await deal(ana.id);
    const dealBruno = await deal(bruno.id);
    // Ana scheduled it, then the deal went to Bruno: it is Bruno's now.
    const dealMoved = await deal(bruno.id);
    const dealLoose = await deal(null);

    // Ana's, upcoming: not yet started, started but not over (the clock), and one in progress.
    await meeting(dealAna, ana.id, 'Ana amanhã', '2026-10-20T17:00:00Z');
    await meeting(dealAna, ana.id, 'Ana em 1 h', '2026-10-19T16:00:00Z');
    await meeting(dealAna, ana.id, 'Ana agora', '2026-10-19T14:30:00Z', 'em_andamento');
    // Ana's, past: ended by the clock, closed, cancelled (though in the future), and one flagged
    // in progress whose time is over.
    await meeting(dealAna, ana.id, 'Ana ontem', '2026-10-18T17:00:00Z');
    await meeting(dealAna, ana.id, 'Ana encerrada', '2026-10-19T10:00:00Z', 'encerrada');
    await meeting(dealAna, ana.id, 'Ana cancelada', '2026-10-25T17:00:00Z', 'cancelada');
    await meeting(dealAna, ana.id, 'Ana esquecida', '2026-10-19T12:00:00Z', 'em_andamento');
    await meeting(dealBruno, bruno.id, 'Bruno amanhã', '2026-10-21T17:00:00Z');
    await meeting(dealBruno, bruno.id, 'Bruno anterior', '2026-10-01T17:00:00Z', 'encerrada');
    await meeting(dealMoved, ana.id, 'Reunião da Ana, negócio do Bruno', '2026-10-22T17:00:00Z');
    await meeting(dealLoose, admin.id, 'Sem dono', '2026-10-23T17:00:00Z');
  });

  it('gives a seller only the meetings of the deals they own, soonest first', async () => {
    const res = await list(ana.cookies, '?when=upcoming');
    expect(res.statusCode).toBe(200);
    // endsAt >= now: "Ana agora" (14:30-15:30) is still on.
    expect(titlesOf(res)).toEqual(['Ana agora', 'Ana em 1 h', 'Ana amanhã']);
    // Nothing of the lead itself, nor a storage key.
    expect(res.body).not.toContain('Candidato');
    expect(res.body).not.toContain('candidato@');
    expect(res.body).not.toContain('recordingKey');
  });

  it('keeps a meeting a seller scheduled out of their list once the deal belongs to someone else', async () => {
    const mine = await list(ana.cookies, '?when=upcoming');
    expect(titlesOf(mine)).not.toContain('Reunião da Ana, negócio do Bruno');
    const theirs = await list(bruno.cookies, '?when=upcoming');
    expect(titlesOf(theirs)).toEqual(['Bruno amanhã', 'Reunião da Ana, negócio do Bruno']);
    // The other seller's meetings never show up on either side.
    expect(titlesOf(theirs).some((t) => t.startsWith('Ana '))).toBe(false);
    expect(titlesOf(mine).some((t) => t.startsWith('Bruno'))).toBe(false);
  });

  it('splits the rest into past, latest first: ended, closed and cancelled alike', async () => {
    const res = await list(ana.cookies, '?when=past');
    expect(res.statusCode).toBe(200);
    expect(titlesOf(res)).toEqual(['Ana cancelada', 'Ana esquecida', 'Ana encerrada', 'Ana ontem']);
    expect(titlesOf(await list(bruno.cookies, '?when=past'))).toEqual(['Bruno anterior']);
  });

  it('puts every meeting in exactly one of the two lists', async () => {
    const all = (when: string) => list(admin.cookies, `?when=${when}`).then(titlesOf);
    const [upcoming, past] = [await all('upcoming'), await all('past')];
    expect(upcoming.filter((t) => past.includes(t))).toEqual([]);
    expect(upcoming.length + past.length).toBe(11);
  });

  it('answers upcoming when `when` is absent', async () => {
    expect(titlesOf(await list(ana.cookies))).toEqual(['Ana agora', 'Ana em 1 h', 'Ana amanhã']);
  });

  it('shows the Admin every deal’s meetings, with who owns the deal', async () => {
    const res = await list(admin.cookies, '?when=upcoming');
    const rows = res.json<{ meetings: MeetingListItem[] }>().meetings;
    expect(rows.map((m) => [m.title, m.dealOwnerName])).toEqual([
      ['Ana agora', 'Ana Vendedora'],
      ['Ana em 1 h', 'Ana Vendedora'],
      ['Ana amanhã', 'Ana Vendedora'],
      ['Bruno amanhã', 'Bruno Vendedor'],
      // The deal's owner, not whoever scheduled it.
      ['Reunião da Ana, negócio do Bruno', 'Bruno Vendedor'],
      ['Sem dono', null],
    ]);
    expect(rows[0]).toMatchObject({
      status: 'em_andamento',
      calendar: 'vendedor',
      recordingState: 'nenhuma',
    });
  });

  it('shows the managers every meeting too', async () => {
    for (const role of ['gerente_comercial', 'diretoria'] as const) {
      const viewer = await person(role, 'Gestor Exemplo');
      const res = await list(viewer.cookies, '?when=upcoming');
      expect(res.statusCode, role).toBe(200);
      expect(titlesOf(res), role).toHaveLength(6);
    }
  });

  it('refuses an unknown `when` with 400', async () => {
    for (const query of ['?when=soon', '?when=', '?when=UPCOMING', '?when=upcoming&when=past']) {
      const res = await list(ana.cookies, query);
      expect(res.statusCode, query).toBe(400);
    }
  });

  it('answers 401 without a session', async () => {
    expect((await list(undefined, '?when=upcoming')).statusCode).toBe(401);
  });

  it('answers 403 to a level without leads.read', async () => {
    for (const role of ['rh_dp', 'marketing', 'formatacao_juridico'] as const) {
      const viewer = await person(role, 'Sem Leads');
      expect((await list(viewer.cookies, '?when=upcoming')).statusCode, role).toBe(403);
    }
  });

  it('caps the list at 200 rows', async () => {
    const carla = await person('vendedor_expansao', 'Carla Vendedora');
    const dealCarla = await deal(carla.id);
    const startsAt = new Date('2026-11-01T12:00:00Z');
    await db.insert(crmMeetings).values(
      Array.from({ length: 205 }, (_, i) => ({
        leadId: dealCarla,
        ownerEmployeeId: carla.id,
        title: `Reunião ${i}`,
        startsAt: new Date(startsAt.getTime() + i * 3_600_000),
        endsAt: new Date(startsAt.getTime() + i * 3_600_000 + 1_800_000),
      })),
    );
    const res = await list(carla.cookies, '?when=upcoming');
    expect(titlesOf(res)).toHaveLength(200);
    expect(titlesOf(res)[0]).toBe('Reunião 0');
  });
});
