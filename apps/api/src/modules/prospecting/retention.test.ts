import {
  SESSION_COOKIE,
  type ProspectingSettings,
  type ProspectSearchResponse,
  type RoleKey,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog, prospectingSettings, prospects } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { fakePlace, fakePlacesApi } from './fake-places-api.js';
import { runProspectingRetention } from './retention.js';

/**
 * Prospecção's corrections of 29/10 (docs/crm/prospeccao.md): a reservation that expires, the
 * enrichment that is not kept forever, and a sweep that keeps the places that answered when one
 * fails. Google is scripted (fake-places-api); no test reaches the network. Made-up data only.
 */

const KEY = 'test-places-key-never-printed';
const DAY = 86_400_000;

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
type Session = { id: string; cookies: Record<string, string> };
let seller: Session;
let otherSeller: Session;
let gerente: Session;

const google = fakePlacesApi({
  key: KEY,
  searches: {
    'pizzarias em Icaraí': [[fakePlace(71), fakePlace(72)]],
    'pizzarias em Ingá': [[fakePlace(73)]],
  },
});
/** Places whose search times out; every other call goes to the scripted Google. */
let timingOut: string[] = [];

async function loginAs(role: RoleKey): Promise<Session> {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

const call = (session: Session, method: InjectOptions['method'], url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    cookies: session.cookies,
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  });

let seq = 0;
/** A saved prospect last updated `daysAgo` days before `now`. */
async function prospectAged(
  status: string,
  daysAgo: number,
  now: Date,
  extra: Partial<typeof prospects.$inferInsert> = {},
) {
  seq += 1;
  const at = new Date(now.getTime() - daysAgo * DAY);
  const [row] = await db
    .insert(prospects)
    .values({
      placeId: `ChIJretention${String(seq).padStart(4, '0')}xyz`,
      status,
      ownerEmployeeId: seller.id,
      notes: 'Ligar depois do almoço',
      createdBy: seller.id,
      createdAt: at,
      updatedAt: at,
      ...extra,
    })
    .returning();
  return row!;
}

const rowOf = async (id: string) =>
  (await db.select().from(prospects).where(eq(prospects.id, id)))[0]!;

const ENRICHMENT = {
  email: { value: 'contato@empresa-teste.example', source: 'site da empresa', at: '2026-01-01' },
};

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
      GOOGLE_PLACES_API_KEY: KEY,
    }),
    db,
    placesFetch: (async (input: unknown, init?: RequestInit) => {
      const query = typeof init?.body === 'string' ? String(JSON.parse(init.body).textQuery) : '';
      if (timingOut.some((place) => query.endsWith(` em ${place}`)))
        throw new DOMException('The operation timed out.', 'TimeoutError');
      return google.fetch(input as string, init);
    }) as typeof fetch,
  });
  seller = await loginAs('vendedor_formatacao');
  otherSeller = await loginAs('vendedor_formatacao');
  gerente = await loginAs('gerente_comercial');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(async () => {
  // Each test starts from the defaults and no prospect, so one test's rows never expire in another.
  await db.delete(prospectingSettings);
  await db.delete(prospects);
  timingOut = [];
});

describe('a reservation expires', () => {
  it('reservado after 30 days and contatado after 90 go back to free, row and notes kept', async () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const oldReserved = await prospectAged('reservado', 31, now);
    const freshReserved = await prospectAged('reservado', 29, now);
    const oldContacted = await prospectAged('contatado', 91, now);
    const freshContacted = await prospectAged('contatado', 89, now);
    const converted = await prospectAged('virou_lead', 400, now);
    const noContact = await prospectAged('nao_contatar', 400, now);

    expect(await runProspectingRetention(db, now)).toEqual({
      ran: true,
      expired: 2,
      enrichmentCleared: 0,
    });
    for (const id of [oldReserved.id, oldContacted.id]) {
      const row = await rowOf(id);
      expect(row.status).toBe('descartado');
      expect(row.reason).toBe('Reserva expirada em 29/10/2026');
      expect(row.notes).toBe('Ligar depois do almoço');
      expect(row.ownerEmployeeId).toBe(seller.id);
      expect(row.updatedAt.toISOString()).toBe(now.toISOString());
    }
    expect((await rowOf(freshReserved.id)).status).toBe('reservado');
    expect((await rowOf(freshContacted.id)).status).toBe('contatado');
    expect((await rowOf(converted.id)).status).toBe('virou_lead');
    expect((await rowOf(noContact.id)).status).toBe('nao_contatar');

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'prospect.reservation_expired'));
    expect(audits.map((a) => a.entityId).sort()).toEqual([oldReserved.id, oldContacted.id].sort());
    expect(audits.find((a) => a.entityId === oldContacted.id)?.metadata).toEqual({
      previousStatus: 'contatado',
      status: 'descartado',
      days: 90,
    });
    expect(audits.every((a) => a.actorEmployeeId === null)).toBe(true);

    // A second run finds nothing left to expire.
    expect(await runProspectingRetention(db, now)).toMatchObject({ expired: 0 });
  });

  it('an expired company is free: another seller sees it and reserves it', async () => {
    const now = new Date();
    const old = await prospectAged('reservado', 40, now);
    const before = await call(otherSeller, 'POST', '/prospecting/prospects', {
      placeId: old.placeId,
      action: 'reserve',
    });
    expect(before.statusCode).toBe(409);
    await runProspectingRetention(db, now);
    const after = await call(otherSeller, 'POST', '/prospecting/prospects', {
      placeId: old.placeId,
      action: 'reserve',
    });
    expect(after.statusCode).toBe(200);
    expect((await rowOf(old.id)).ownerEmployeeId).toBe(otherSeller.id);
  });

  it('follows the deadlines set in Ajustes, 7 to 365 days, by prospecting.configure, audited', async () => {
    const retention = { reservedDays: 10, contactedDays: 20, enrichmentDays: 60 };
    for (const bad of [
      { ...retention, reservedDays: 6 },
      { ...retention, contactedDays: 366 },
      { ...retention, enrichmentDays: 29 },
      { ...retention, enrichmentDays: 731 },
      { ...retention, reservedDays: 10.5 },
    ])
      expect((await call(gerente, 'PUT', '/prospecting/settings/retention', bad)).statusCode).toBe(
        400,
      );
    expect(
      (await call(seller, 'PUT', '/prospecting/settings/retention', retention)).statusCode,
    ).toBe(403);
    const saved = await call(gerente, 'PUT', '/prospecting/settings/retention', retention);
    expect(saved.statusCode).toBe(200);
    expect(saved.json<ProspectingSettings>().retention).toEqual(retention);
    // The other parts stay as they were.
    expect(saved.json<ProspectingSettings>().quota.perUserDaily).toBe(40);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'prospecting.retention_changed'),
          eq(auditLog.actorEmployeeId, gerente.id),
        ),
      );
    expect(audit?.metadata).toEqual({
      from: { reservedDays: 30, contactedDays: 90, enrichmentDays: 180 },
      to: retention,
    });

    const now = new Date();
    const elevenDays = await prospectAged('reservado', 11, now);
    const nineDays = await prospectAged('reservado', 9, now);
    const contacted = await prospectAged('contatado', 21, now);
    expect(await runProspectingRetention(db, now)).toMatchObject({ expired: 2 });
    expect((await rowOf(elevenDays.id)).status).toBe('descartado');
    expect((await rowOf(nineDays.id)).status).toBe('reservado');
    expect((await rowOf(contacted.id)).status).toBe('descartado');
  });

  it('a replica holding the lock makes the other skip the run, touching nothing', async () => {
    const now = new Date();
    const old = await prospectAged('reservado', 60, now);
    const other = new pg.Client({ connectionString: harness.url });
    await other.connect();
    try {
      await other.query('begin');
      await other.query(`select pg_advisory_xact_lock(hashtext('prospecting:retention'))`);
      expect(await runProspectingRetention(db, now)).toEqual({ ran: false });
      expect((await rowOf(old.id)).status).toBe('reservado');
      await other.query('rollback');
    } finally {
      await other.end();
    }
    expect(await runProspectingRetention(db, now)).toMatchObject({ ran: true, expired: 1 });
  });
});

describe("the company site's data is not kept forever", () => {
  it('clears the enrichment of a prospect that did not become a lead after 180 days, audited as a count', async () => {
    const now = new Date();
    const old = await prospectAged('descartado', 181, now, { enrichment: ENRICHMENT });
    const oldNoContact = await prospectAged('nao_contatar', 300, now, { enrichment: ENRICHMENT });
    const recent = await prospectAged('descartado', 179, now, { enrichment: ENRICHMENT });
    const converted = await prospectAged('virou_lead', 400, now, { enrichment: ENRICHMENT });

    expect(await runProspectingRetention(db, now)).toEqual({
      ran: true,
      expired: 0,
      enrichmentCleared: 2,
    });
    for (const id of [old.id, oldNoContact.id]) {
      const row = await rowOf(id);
      expect(row.enrichment).toEqual({});
      expect(row.status).not.toBe('reservado');
      expect(row.notes).toBe('Ligar depois do almoço');
    }
    expect((await rowOf(recent.id)).enrichment).toEqual(ENRICHMENT);
    expect((await rowOf(converted.id)).enrichment).toEqual(ENRICHMENT);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'prospecting.enrichment_cleared'));
    expect(audits).toHaveLength(1);
    // Only the count: no id, no e-mail, no link.
    expect(audits[0]?.entityId).toBeNull();
    expect(audits[0]?.metadata).toEqual({ count: 2, days: 180 });
  });

  it('follows the enrichment deadline set in Ajustes', async () => {
    const put = await call(gerente, 'PUT', '/prospecting/settings/retention', {
      reservedDays: 30,
      contactedDays: 90,
      enrichmentDays: 30,
    });
    expect(put.statusCode).toBe(200);
    const now = new Date();
    const month = await prospectAged('descartado', 31, now, { enrichment: ENRICHMENT });
    expect(await runProspectingRetention(db, now)).toMatchObject({ enrichmentCleared: 1 });
    expect((await rowOf(month.id)).enrichment).toEqual({});
  });
});

describe('a sweep where one place fails', () => {
  const sweep = (places: string[]) =>
    call(seller, 'POST', '/prospecting/search', {
      segment: 'pizzarias',
      places,
      confirmCalls: places.length,
    });

  it("keeps the other places' results, says which failed and why, and counts every call", async () => {
    const usedBefore = (await call(seller, 'GET', '/prospecting/usage')).json().today.used;
    timingOut = ['Ingá'];
    const res = await sweep(['Icaraí', 'Ingá']);
    expect(res.statusCode).toBe(200);
    const answer = res.json<ProspectSearchResponse>();
    expect(answer.items.map((i) => i.placeId).sort()).toEqual(
      [fakePlace(71).id, fakePlace(72).id].sort(),
    );
    expect(answer.failedPlaces).toEqual([{ place: 'Ingá', code: 'timeout' }]);
    expect(answer.callsSpent).toBe(2);
    expect(answer.usage.today.used).toBe(usedBefore + 2);
  });

  it('answers every place when none fails', async () => {
    const answer = (await sweep(['Icaraí', 'Ingá'])).json<ProspectSearchResponse>();
    expect(answer.items).toHaveLength(3);
    expect(answer.failedPlaces).toEqual([]);
  });

  it('with every place failing it is still the 502 in words, and the calls still count', async () => {
    const usedBefore = (await call(seller, 'GET', '/prospecting/usage')).json().today.used;
    timingOut = ['Icaraí', 'Ingá'];
    const res = await sweep(['Icaraí', 'Ingá']);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: 'places_timeout',
      message: 'O Google não respondeu agora. Tente de novo em instantes.',
    });
    const usage = (await call(seller, 'GET', '/prospecting/usage')).json();
    expect(usage.today.used).toBe(usedBefore + 2);
  });
});
