import { SESSION_COOKIE, WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leadTasks, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { boardCounters, DEFAULT_TRACKING_START } from './crm.js';
import { listLeads, upsertLead } from './service.js';

/**
 * "1º contato atrasado": the number at the top of Negociações and the list it opens are one rule
 * (`firstContactOverdueSql`), the same one that raises the notices (crm-alerts.test.ts).
 */

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

let phoneSeq = 0;
const arrive = (ownerEmployeeId: string, pipeline: 'expansao' | 'formatacao') => {
  phoneSeq += 1;
  return upsertLead(db, {
    source: 'meta_lead_ads',
    name: 'Cliente de Teste',
    phone: `5511944${String(phoneSeq).padStart(6, '0')}`,
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    pipeline,
    ownerEmployeeId,
    skipResearch: true,
    event: { kind: 'lead.received.meta_lead_ads' },
  });
};

const hourAgo = () => new Date(Date.now() - 3_600_000);
const setDue = (leadIds: string[], due: Date) =>
  db
    .update(leadTasks)
    .set({ dueAt: due })
    .where(and(inArray(leadTasks.leadId, leadIds), eq(leadTasks.kind, 'first_contact')));

describe('the 1º contato atrasado counter and its list', () => {
  it('counts and lists the Formatação deals still in "Sem contato" past their deadline, and only those', async () => {
    const [ana, bia] = await Promise.all([
      createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' }),
      createEmployee(db, { role: 'vendedor_formatacao', sector: 'comercial' }),
    ]);
    // Eight Meta Lead Ads deals of one campaign, handed out in turn.
    const born = [];
    for (let i = 0; i < 8; i += 1)
      born.push(await arrive(i % 2 === 0 ? ana.id : bia.id, 'formatacao'));
    const ids = born.map((b) => b.lead.id);
    expect(born.every((b) => b.lead.stage === 'Sem contato')).toBe(true);

    // Not late yet: the deadline is one business hour away.
    expect((await boardCounters(db, { pipeline: 'formatacao' })).firstContactOverdue).toBe(0);

    // Time passes with nobody making contact.
    await setDue(ids, hourAgo());
    expect(await boardCounters(db, { pipeline: 'formatacao' })).toMatchObject({
      firstContactOverdue: 8,
      since: DEFAULT_TRACKING_START.toISOString(),
    });
    // A seller's scope sees only theirs (the route passes the owner when the permission is `own`).
    expect(
      (await boardCounters(db, { pipeline: 'formatacao', ownerEmployeeId: ana.id }))
        .firstContactOverdue,
    ).toBe(4);
    // The other funnel is not mixed in.
    expect((await boardCounters(db, { pipeline: 'expansao' })).firstContactOverdue).toBe(0);

    // The list the counter opens is the same set.
    const listed = await listLeads(db, { pipeline: 'formatacao', firstContactOverdue: true });
    expect(listed.total).toBe(8);
    expect(new Set(listed.leads.map((l) => l.id))).toEqual(new Set(ids));
    expect(listed.leads.every((l) => l.stage === 'Sem contato')).toBe(true);
    const mine = await listLeads(db, {
      pipeline: 'formatacao',
      firstContactOverdue: true,
      ownerEmployeeId: bia.id,
    });
    expect(mine.total).toBe(4);

    // Contact registered (task closed), deal moved on, deal won: each leaves the count and the list.
    await db
      .update(leadTasks)
      .set({ doneAt: new Date() })
      .where(and(eq(leadTasks.leadId, ids[0]!), eq(leadTasks.kind, 'first_contact')));
    await db.update(leads).set({ stage: 'Tentando contato' }).where(eq(leads.id, ids[1]!));
    await db.update(leads).set({ won: true }).where(eq(leads.id, ids[2]!));
    expect((await boardCounters(db, { pipeline: 'formatacao' })).firstContactOverdue).toBe(5);
    expect((await listLeads(db, { pipeline: 'formatacao', firstContactOverdue: true })).total).toBe(
      5,
    );
  });

  it('leaves out a deal that entered before the start of use, and counts Expansão in "Novo Contato"', async () => {
    const seller = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const old = await arrive(seller.id, 'expansao');
    const fresh = await arrive(seller.id, 'expansao');
    // RD history: it entered, and its task was made, before 09/10: not counted.
    const before = new Date(DEFAULT_TRACKING_START.getTime() - 86_400_000);
    await db.update(leads).set({ enteredAt: before }).where(eq(leads.id, old.lead.id));
    await db.update(leadTasks).set({ createdAt: before }).where(eq(leadTasks.leadId, old.lead.id));
    await setDue([old.lead.id, fresh.lead.id], hourAgo());

    expect(fresh.lead.stage).toBe('Novo Contato');
    expect((await boardCounters(db, { pipeline: 'expansao' })).firstContactOverdue).toBe(1);
    const listed = await listLeads(db, { pipeline: 'expansao', firstContactOverdue: true });
    expect(listed.leads.map((l) => l.id)).toEqual([fresh.lead.id]);
  });

  it('serves the counter and the filtered list over HTTP', async () => {
    const board = await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: board.email, password: board.password },
    });
    const cookies = {
      [SESSION_COOKIE]: login.cookies.find((c) => c.name === SESSION_COOKIE)!.value,
    };
    const counters = await app.inject({
      method: 'GET',
      url: '/leads/board/counters?pipeline=formatacao',
      cookies,
    });
    expect(counters.statusCode).toBe(200);
    expect(counters.json<{ firstContactOverdue: number }>().firstContactOverdue).toBe(5);

    const list = await app.inject({
      method: 'GET',
      url: '/leads?pipeline=formatacao&firstContactOverdue=1',
      cookies,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ total: number }>().total).toBe(5);
    // Without the filter, the whole funnel.
    const all = await app.inject({ method: 'GET', url: '/leads?pipeline=formatacao', cookies });
    expect(all.json<{ total: number }>().total).toBeGreaterThanOrEqual(8);
  });
});
