import {
  isCloseForecastOverdue,
  SESSION_COOKIE,
  WINGS_CLIENT_ID,
  type Board,
  type LeadListItem,
} from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { leadEvents, leads } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { LoadedLead } from './service.js';
import { upsertLead } from './service.js';

/**
 * Previsão de fechamento (migration 0068): a calendar date on the lead, set
 * and cleared by the seller on the deal's page, read by the Painel de vendas
 * for the period's forecast and the next deals expected to close.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
let seller: { employeeId: string; cookies: Record<string, string> };

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
  const employee = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  seller = { employeeId: employee.id, cookies: { [SESSION_COOKIE]: token } };
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

describe('migration 0068: leads.expected_close_at', () => {
  it('is a date column that accepts null, has no default and leaves existing deals empty', async () => {
    const { rows } = await db.execute<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      select data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public' and table_name = 'leads' and column_name = 'expected_close_at'
    `);
    expect(rows).toEqual([{ data_type: 'date', is_nullable: 'YES', column_default: null }]);

    const lead = await arrive('Sem previsão', '21999990101');
    const [row] = await db
      .select({ expectedCloseAt: leads.expectedCloseAt })
      .from(leads)
      .where(eq(leads.id, lead.lead.id));
    expect(row?.expectedCloseAt).toBeNull();
    expect(lead.lead.expectedCloseAt).toBeNull();
  });
});

describe('PATCH /leads/:id/deal with expectedCloseAt', () => {
  let leadId: string;

  beforeAll(async () => {
    const lead = await arrive('Com previsão', '21999990102');
    leadId = lead.lead.id;
  });

  it('sets the forecast as AAAA-MM-DD, shows it on the lead, the list and the board, and writes one event', async () => {
    const changed = await app.inject({
      method: 'PATCH',
      url: `/leads/${leadId}/deal`,
      cookies: seller.cookies,
      payload: { expectedCloseAt: '2026-11-20' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<LoadedLead>().lead.expectedCloseAt).toBe('2026-11-20');

    const loaded = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}`,
      cookies: seller.cookies,
    });
    expect(loaded.json<LoadedLead>().lead.expectedCloseAt).toBe('2026-11-20');

    const listed = await app.inject({
      method: 'GET',
      url: '/leads?pipeline=expansao',
      cookies: seller.cookies,
    });
    const item = listed.json<{ leads: LeadListItem[] }>().leads.find((l) => l.id === leadId);
    expect(item?.expectedCloseAt).toBe('2026-11-20');

    const board = await app.inject({
      method: 'GET',
      url: '/leads/board?pipeline=expansao',
      cookies: seller.cookies,
    });
    const card = board
      .json<Board>()
      .columns.flatMap((column) => column.cards)
      .find((c) => c.id === leadId);
    expect(card?.expectedCloseAt).toBe('2026-11-20');

    const events = await db
      .select({ kind: leadEvents.kind, detail: leadEvents.detail })
      .from(leadEvents)
      .where(eq(leadEvents.leadId, leadId));
    expect(events.filter((e) => e.kind === 'lead.expected_close_changed')).toEqual([
      { kind: 'lead.expected_close_changed', detail: { from: null, to: '2026-11-20' } },
    ]);
  });

  it('the same date again changes nothing; null clears it', async () => {
    const same = await app.inject({
      method: 'PATCH',
      url: `/leads/${leadId}/deal`,
      cookies: seller.cookies,
      payload: { expectedCloseAt: '2026-11-20' },
    });
    expect(same.statusCode).toBe(200);
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/leads/${leadId}/deal`,
      cookies: seller.cookies,
      payload: { expectedCloseAt: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<LoadedLead>().lead.expectedCloseAt).toBeNull();
    const events = await db
      .select({ detail: leadEvents.detail })
      .from(leadEvents)
      .where(eq(leadEvents.leadId, leadId));
    expect(events.filter((e) => (e.detail as { to?: unknown })?.to === '2026-11-20')).toHaveLength(
      1,
    );
    expect(events.some((e) => (e.detail as { from?: unknown })?.from === '2026-11-20')).toBe(true);
  });

  it('refuses anything that is not a real calendar date', async () => {
    for (const bad of [
      '20/11/2026',
      '2026-11-20T10:00:00Z',
      '2026-02-30',
      '2026-13-01',
      '',
      20261120,
    ]) {
      const refused = await app.inject({
        method: 'PATCH',
        url: `/leads/${leadId}/deal`,
        cookies: seller.cookies,
        payload: { expectedCloseAt: bad },
      });
      expect(refused.statusCode, String(bad)).toBe(400);
    }
    const loaded = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}`,
      cookies: seller.cookies,
    });
    expect(loaded.json<LoadedLead>().lead.expectedCloseAt).toBeNull();
  });
});

describe('isCloseForecastOverdue', () => {
  it('is true only for an open deal whose day is behind today', () => {
    const today = '2026-10-05';
    expect(isCloseForecastOverdue({ expectedCloseAt: '2026-10-04', won: null }, today)).toBe(true);
    expect(isCloseForecastOverdue({ expectedCloseAt: '2026-10-05', won: null }, today)).toBe(false);
    expect(isCloseForecastOverdue({ expectedCloseAt: '2026-10-06', won: null }, today)).toBe(false);
    expect(isCloseForecastOverdue({ expectedCloseAt: null, won: null }, today)).toBe(false);
    expect(isCloseForecastOverdue({ expectedCloseAt: '2026-10-04', won: true }, today)).toBe(false);
    expect(isCloseForecastOverdue({ expectedCloseAt: '2026-10-04', won: false }, today)).toBe(
      false,
    );
  });
});
