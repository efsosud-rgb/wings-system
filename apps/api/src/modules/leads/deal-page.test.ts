import { SESSION_COOKIE, WINGS_CLIENT_ID, type RoleKey } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leadEvents } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { LoadedLead } from './service.js';
import { upsertLead } from './service.js';

/**
 * The deal's page (ficha do cliente): what the head edits in place goes
 * through `PATCH /leads/:id/deal`, like the value and the forecast.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let seller: { employeeId: string; cookies: Record<string, string> };
let other: { employeeId: string; cookies: Record<string, string> };

const loginAs = async (role: RoleKey) => {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
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
    }),
    db,
  });
  seller = await loginAs('vendedor_expansao');
  other = await loginAs('vendedor_expansao');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

const arrive = (name: string, phone: string) =>
  upsertLead(db, {
    source: 'site_form',
    name,
    phone,
    email: null,
    clientId: WINGS_CLIENT_ID,
    clientMapped: false,
    pipeline: 'expansao',
    ownerEmployeeId: seller.employeeId,
    distribute: false,
    skipResearch: true,
    company: null,
    event: { kind: 'lead.received.site_form' },
  });

describe('PATCH /leads/:id/deal with name', () => {
  it('renames the deal, writes one event with the old and new names, and the same name changes nothing', async () => {
    const lead = await arrive('Nome digitado errado', '21999990201');
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.lead.id}/deal`,
      cookies: seller.cookies,
      payload: { name: '  Padaria Sol  ' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<LoadedLead>().lead.name).toBe('Padaria Sol');

    const again = await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.lead.id}/deal`,
      cookies: seller.cookies,
      payload: { name: 'Padaria Sol' },
    });
    expect(again.statusCode).toBe(200);

    const events = await db
      .select({ kind: leadEvents.kind, detail: leadEvents.detail })
      .from(leadEvents)
      .where(eq(leadEvents.leadId, lead.lead.id));
    expect(events.filter((e) => e.kind === 'lead.renamed')).toEqual([
      { kind: 'lead.renamed', detail: { from: 'Nome digitado errado', to: 'Padaria Sol' } },
    ]);
  });

  it('refuses a name shorter than two characters', async () => {
    const lead = await arrive('Curto', '21999990202');
    const short = await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.lead.id}/deal`,
      cookies: seller.cookies,
      payload: { name: 'A' },
    });
    expect(short.statusCode).toBe(400);
  });

  it("a seller cannot rename another seller's deal", async () => {
    const lead = await arrive('De outro', '21999990203');
    const denied = await app.inject({
      method: 'PATCH',
      url: `/leads/${lead.lead.id}/deal`,
      cookies: other.cookies,
      payload: { name: 'Tentativa' },
    });
    expect([403, 404]).toContain(denied.statusCode);
  });
});
